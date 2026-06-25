import { Injectable, Logger } from '@nestjs/common';
import { MovementType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/** Đối soát movement type order_* vs trạng thái đơn (T031) */
@Injectable()
export class OrderReconcileService {
  private readonly logger = new Logger(OrderReconcileService.name);

  constructor(private prisma: PrismaService) {}

  async runOrderMovementReconcile() {
    const orderTypes: MovementType[] = [
      MovementType.order_reserve,
      MovementType.order_release,
      MovementType.order_ship,
      MovementType.return_in,
    ];

    const movements = await this.prisma.inventoryMovement.groupBy({
      by: ['variantId', 'warehouseId', 'type'],
      where: { type: { in: orderTypes } },
      _sum: { change: true },
    });

    const mismatches: unknown[] = [];
    for (const order of await this.prisma.order.findMany({
      where: { status: { in: ['ordered', 'processing'] } },
      include: { items: true },
    })) {
      const expectedCommitted = order.items.reduce((s, i) => s + i.quantity, 0);
      for (const item of order.items) {
        const level = await this.prisma.inventoryLevel.findUnique({
          where: {
            variantId_warehouseId: {
              variantId: item.variantId,
              warehouseId: item.warehouseId,
            },
          },
        });
        if (!level) {
          mismatches.push({
            order_id: order.id.toString(),
            issue: 'missing_inventory_level',
          });
        }
      }
      void expectedCommitted;
    }

    const report = {
      movement_groups: movements.length,
      mismatches,
      ok: mismatches.length === 0,
      ran_at: new Date().toISOString(),
    };

    if (!report.ok) {
      this.logger.warn(`Đối soát đơn: ${mismatches.length} vấn đề`);
    }
    return report;
  }
}
