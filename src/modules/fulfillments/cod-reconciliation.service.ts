import { Injectable, NotFoundException } from '@nestjs/common';
import { ShipmentStatus } from '@prisma/client';
import { assertLocationPermission } from '../../common/auth/access';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { BusinessException } from '../../common/exceptions/business.exception';
import { OrderService } from '../orders/order.service';
import { PrismaService } from '../../prisma/prisma.service';
import { BulkReconcileCodDto } from './fulfillment.dto';

/**
 * Đối soát COD: hãng vận chuyển đã chuyển tiền thu hộ về shop.
 *
 * Sapo theo dõi việc này bằng "Trạng thái đối soát" trên từng vận đơn. Ở đây
 * đối soát làm hai việc: đánh dấu vận đơn và ghi nhận tiền thu hộ thành thanh
 * toán của đơn (phiếu thu) — trước đây đơn COD giao xong vẫn "chưa thanh toán"
 * mãi vì không bước nào ghi tiền về.
 *
 * Tách service riêng vì cần `OrderService.pay`; nhét vào `FulfillmentService`
 * sẽ kéo cả module đơn hàng vào constructor của nó.
 */
@Injectable()
export class CodReconciliationService {
  constructor(
    private prisma: PrismaService,
    private orders: OrderService,
  ) {}

  /** Mỗi vận đơn xử lý riêng: vận đơn lỗi không chặn các vận đơn khác. */
  async reconcileMany(dto: BulkReconcileCodDto, user: AuthUser) {
    const succeeded: string[] = [];
    const failed: { id: string; message: string }[] = [];
    for (const id of [...new Set(dto.ids)]) {
      try {
        await this.reconcile(BigInt(id), user);
        succeeded.push(id);
      } catch (err) {
        failed.push({
          id,
          message: err instanceof Error ? err.message : 'Lỗi không xác định',
        });
      }
    }
    return { succeeded, failed };
  }

  async reconcile(id: bigint, user: AuthUser) {
    const f = await this.prisma.fulfillment.findUnique({
      where: { id },
      include: {
        order: {
          select: {
            id: true,
            locationId: true,
            totalPrice: true,
            totalReceived: true,
          },
        },
      },
    });
    if (!f) throw new NotFoundException('Không tìm thấy vận đơn');
    // Đối soát ghi tiền vào đơn nên đòi cùng quyền với thanh toán đơn
    assertLocationPermission(user, 'order:update', f.order.locationId);
    if (f.shipmentStatus !== ShipmentStatus.delivered) {
      throw new BusinessException(
        'INVALID_TRANSITION',
        'Chỉ đối soát vận đơn đã giao thành công',
        409,
      );
    }
    if (f.codReconciledOn) {
      throw new BusinessException(
        'INVALID_TRANSITION',
        'Vận đơn đã đối soát',
        409,
      );
    }

    // Thu phần COD còn thiếu của đơn — khách có thể đã trả trước một phần.
    // Thu tiền TRƯỚC khi đánh dấu: nếu bước đánh dấu hỏng, chạy lại sẽ thấy
    // không còn gì phải thu và chỉ đánh dấu, không thu hai lần.
    const unpaid = Number(f.order.totalPrice) - Number(f.order.totalReceived);
    const collect = Math.min(Number(f.codAmount), unpaid);
    if (collect > 0) {
      await this.orders.pay(f.order.id, { amount: collect }, user);
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.fulfillment.update({
        where: { id },
        data: { codReconciledOn: new Date(), codReconciledById: user.userId },
      });
      await tx.activityLog.create({
        data: {
          userId: user.userId,
          action: 'fulfillment.cod_reconcile',
          entityType: 'order',
          entityId: f.order.id,
          metadata: {
            fulfillment_code: f.name,
            cod_amount: Number(f.codAmount),
            collected: Math.max(collect, 0),
          },
        },
      });
    });
    return { id: id.toString(), collected: Math.max(collect, 0) };
  }
}
