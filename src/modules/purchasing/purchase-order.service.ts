import { Injectable, NotFoundException } from '@nestjs/common';
import {
  InventoryBucket,
  MovementType,
  PoStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { BusinessException } from '../../common/exceptions/business.exception';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { InventoryService } from '../inventory/inventory.service';
import {
  CreatePurchaseOrderDto,
  ListPurchaseOrdersQueryDto,
  UpdatePurchaseOrderDto,
} from './purchasing.dto';
import { serializePurchaseOrder } from './purchasing.serializer';

const poInclude = {
  items: { include: { variant: { select: { sku: true } } } },
  supplier: { select: { code: true, name: true } },
  warehouse: { select: { code: true, name: true } },
  branch: { select: { code: true, name: true } },
} satisfies Prisma.PurchaseOrderInclude;

@Injectable()
export class PurchaseOrderService {
  constructor(
    private prisma: PrismaService,
    private inventory: InventoryService,
  ) {}

  async list(query: ListPurchaseOrdersQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? 20;
    const where: Prisma.PurchaseOrderWhereInput = {};

    if (query.status)
      where.status = query.status as import('@prisma/client').PoStatus;
    if (query.supplier_id) where.supplierId = BigInt(query.supplier_id);

    const [rows, total] = await Promise.all([
      this.prisma.purchaseOrder.findMany({
        where,
        include: poInclude,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.purchaseOrder.count({ where }),
    ]);

    return {
      data: rows.map(serializePurchaseOrder),
      total,
      page,
      page_size: pageSize,
    };
  }

  async findOne(id: bigint) {
    const po = await this.prisma.purchaseOrder.findUnique({
      where: { id },
      include: poInclude,
    });
    if (!po) throw new NotFoundException('Không tìm thấy PO');
    return { data: serializePurchaseOrder(po) };
  }

  async create(dto: CreatePurchaseOrderDto, user: AuthUser) {
    if (!dto.items?.length) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        'PO phải có ít nhất một dòng',
        422,
      );
    }

    await this.validateSupplier(BigInt(dto.supplier_id));
    await this.validateBranch(BigInt(dto.branch_id));
    this.inventory.assertWarehouseAccess(user, BigInt(dto.warehouse_id));

    const totalQuantity = dto.items.reduce((s, i) => s + i.quantity, 0);
    const totalAmount = dto.items.reduce(
      (s, i) => s + i.quantity * i.unit_price,
      0,
    );

    const code = await this.generatePoCode();

    const po = await this.prisma.$transaction(async (tx) => {
      const created = await tx.purchaseOrder.create({
        data: {
          code,
          supplierId: BigInt(dto.supplier_id),
          branchId: BigInt(dto.branch_id),
          warehouseId: BigInt(dto.warehouse_id),
          status: PoStatus.don_nhap,
          totalQuantity,
          totalAmount,
          createdById: user.userId,
          items: {
            create: dto.items.map((item) => ({
              variantId: BigInt(item.variant_id),
              quantity: item.quantity,
              unitPrice: item.unit_price,
            })),
          },
        },
        include: poInclude,
      });

      await tx.activityLog.create({
        data: {
          userId: user.userId,
          action: 'purchase_order.create',
          entityType: 'purchase_order',
          entityId: created.id,
          metadata: { code: created.code },
        },
      });

      return created;
    });

    return { data: serializePurchaseOrder(po) };
  }

  async update(id: bigint, dto: UpdatePurchaseOrderDto, user: AuthUser) {
    const po = await this.prisma.purchaseOrder.findUnique({ where: { id } });
    if (!po) throw new NotFoundException('Không tìm thấy PO');
    if (po.status !== PoStatus.don_nhap) {
      throw new BusinessException(
        'INVALID_TRANSITION',
        'Chỉ sửa PO ở trạng thái đơn nháp',
        409,
      );
    }
    if (dto.items && !dto.items.length) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        'PO phải có ít nhất một dòng',
        422,
      );
    }

    if (dto.supplier_id) await this.validateSupplier(BigInt(dto.supplier_id));
    if (dto.branch_id) await this.validateBranch(BigInt(dto.branch_id));
    if (dto.warehouse_id) {
      this.inventory.assertWarehouseAccess(user, BigInt(dto.warehouse_id));
    }

    const data: Prisma.PurchaseOrderUpdateInput = {};
    if (dto.supplier_id)
      data.supplier = { connect: { id: BigInt(dto.supplier_id) } };
    if (dto.branch_id) data.branch = { connect: { id: BigInt(dto.branch_id) } };
    if (dto.warehouse_id)
      data.warehouse = { connect: { id: BigInt(dto.warehouse_id) } };

    if (dto.items) {
      data.totalQuantity = dto.items.reduce((s, i) => s + i.quantity, 0);
      data.totalAmount = dto.items.reduce(
        (s, i) => s + i.quantity * i.unit_price,
        0,
      );
      data.items = {
        deleteMany: {},
        create: dto.items.map((item) => ({
          variantId: BigInt(item.variant_id),
          quantity: item.quantity,
          unitPrice: item.unit_price,
        })),
      };
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.purchaseOrder.update({
        where: { id },
        data,
        include: poInclude,
      });

      await tx.activityLog.create({
        data: {
          userId: user.userId,
          action: 'purchase_order.update',
          entityType: 'purchase_order',
          entityId: id,
          metadata: { code: result.code },
        },
      });

      return result;
    });

    return { data: serializePurchaseOrder(updated) };
  }

  async transition(
    id: bigint,
    action: 'submit' | 'close' | 'cancel',
    user: AuthUser,
  ) {
    const po = await this.prisma.purchaseOrder.findUnique({
      where: { id },
      include: { items: true },
    });
    if (!po) throw new NotFoundException('Không tìm thấy PO');

    this.inventory.assertWarehouseAccess(user, po.warehouseId);

    switch (action) {
      case 'submit':
        return this.submit(po, user);
      case 'close':
        return this.close(po, user);
      case 'cancel':
        return this.cancel(po, user);
      default:
        throw new BusinessException(
          'INVALID_TRANSITION',
          'Action không hợp lệ',
          409,
        );
    }
  }

  /** Gọi sau REI confirm — tự chuyển PO → da_nhap nếu nhập đủ */
  async tryCompleteIfFullyReceived(
    purchaseOrderId: bigint,
    userId: bigint,
    tx: Prisma.TransactionClient,
  ) {
    const po = await tx.purchaseOrder.findUnique({
      where: { id: purchaseOrderId },
      include: { items: true },
    });
    if (!po || po.status !== PoStatus.cho_nhap) return;

    const fullyReceived = po.items.every(
      (item) => item.receivedQuantity >= item.quantity,
    );
    if (fullyReceived) {
      await tx.purchaseOrder.update({
        where: { id: purchaseOrderId },
        data: { status: PoStatus.da_nhap },
      });

      await tx.activityLog.create({
        data: {
          userId,
          action: 'purchase_order.auto_complete',
          entityType: 'purchase_order',
          entityId: purchaseOrderId,
          metadata: { code: po.code },
        },
      });
    }
  }

  private async submit(
    po: Prisma.PurchaseOrderGetPayload<{ include: { items: true } }>,
    user: AuthUser,
  ) {
    if (po.status !== PoStatus.don_nhap) {
      throw new BusinessException(
        'INVALID_TRANSITION',
        'Chỉ submit PO ở trạng thái đơn nháp',
        409,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      for (const item of po.items) {
        await this.inventory.applyMovement(
          {
            variantId: item.variantId,
            warehouseId: po.warehouseId,
            bucket: InventoryBucket.incoming,
            change: item.quantity,
            type: MovementType.incoming_po,
            referenceType: 'purchase_order',
            referenceId: po.id,
            createdById: user.userId,
          },
          tx,
        );
      }

      await tx.purchaseOrder.update({
        where: { id: po.id },
        data: { status: PoStatus.cho_nhap },
      });

      await tx.activityLog.create({
        data: {
          userId: user.userId,
          action: 'purchase_order.submit',
          entityType: 'purchase_order',
          entityId: po.id,
          metadata: { code: po.code },
        },
      });
    });

    return this.findOne(po.id);
  }

  private async close(
    po: Prisma.PurchaseOrderGetPayload<{ include: { items: true } }>,
    user: AuthUser,
  ) {
    if (po.status !== PoStatus.cho_nhap) {
      throw new BusinessException(
        'INVALID_TRANSITION',
        'Chỉ close PO đang chờ nhập',
        409,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await this.cancelRemainingIncoming(po, user.userId, tx);
      await tx.purchaseOrder.update({
        where: { id: po.id },
        data: { status: PoStatus.da_nhap },
      });

      await tx.activityLog.create({
        data: {
          userId: user.userId,
          action: 'purchase_order.close',
          entityType: 'purchase_order',
          entityId: po.id,
          metadata: { code: po.code },
        },
      });
    });

    return this.findOne(po.id);
  }

  private async cancel(
    po: Prisma.PurchaseOrderGetPayload<{ include: { items: true } }>,
    user: AuthUser,
  ) {
    if (po.status !== PoStatus.don_nhap) {
      throw new BusinessException(
        'INVALID_TRANSITION',
        'Chỉ hủy được PO ở trạng thái đơn nháp',
        409,
      );
    }

    // PO đơn nháp chưa từng submit nên chưa tạo incoming/công nợ gì — hủy = xóa hẳn,
    // giống logic hủy phiếu nhập (REI): không giữ lại trạng thái "đã hủy".
    // PO đã "Chờ nhập" (cho_nhap) chỉ có thể đóng sớm qua "Chốt" (close), không hủy được nữa.
    await this.prisma.$transaction(async (tx) => {
      await tx.activityLog.create({
        data: {
          userId: user.userId,
          action: 'purchase_order.cancel',
          entityType: 'purchase_order',
          entityId: po.id,
          metadata: { code: po.code },
        },
      });

      await tx.purchaseOrder.delete({ where: { id: po.id } });
    });

    return { id: po.id.toString(), deleted: true };
  }

  private async cancelRemainingIncoming(
    po: Prisma.PurchaseOrderGetPayload<{ include: { items: true } }>,
    userId: bigint,
    tx: Prisma.TransactionClient,
  ) {
    for (const item of po.items) {
      const remaining = item.quantity - item.receivedQuantity;
      if (remaining <= 0) continue;

      await this.inventory.applyMovement(
        {
          variantId: item.variantId,
          warehouseId: po.warehouseId,
          bucket: InventoryBucket.incoming,
          change: -remaining,
          type: MovementType.incoming_cancel,
          referenceType: 'purchase_order',
          referenceId: po.id,
          createdById: userId,
        },
        tx,
      );
    }
  }

  private async validateSupplier(id: bigint) {
    const s = await this.prisma.supplier.findUnique({ where: { id } });
    if (!s || !s.isActive) {
      throw new BusinessException('VALIDATION_ERROR', 'NCC không hợp lệ', 422);
    }
  }

  private async validateBranch(id: bigint) {
    const b = await this.prisma.branch.findUnique({ where: { id } });
    if (!b || !b.isActive) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        'Chi nhánh không hợp lệ',
        422,
      );
    }
  }

  private async generatePoCode() {
    // Dựa vào count() sẽ trùng mã sau khi PO nháp bị xóa hẳn (cancel), nên
    // phải lấy số thứ tự cao nhất đã từng cấp thay vì đếm số bản ghi còn lại.
    // Sắp theo chính "code" (không phải id) — thứ tự tạo record không đảm bảo
    // khớp thứ tự số trong code nếu dữ liệu cũ từng bị cấp lệch.
    const latest = await this.prisma.purchaseOrder.findFirst({
      orderBy: { code: 'desc' },
      select: { code: true },
    });
    const nextSeq = latest ? Number(latest.code.slice(2)) + 1 : 1;
    return `PO${String(nextSeq).padStart(6, '0')}`;
  }
}
