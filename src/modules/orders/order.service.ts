import { Injectable, NotFoundException } from '@nestjs/common';
import {
  CustomerLedgerReferenceType,
  InventoryBucket,
  MovementType,
  OrderSource,
  OrderStatus,
  PaymentStatus,
  Prisma,
} from '@prisma/client';
import { assertAnyWarehouseAccess } from '../../common/auth/access';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { findOrderIdsByQuery } from '../../common/search/unaccent-search';
import {
  BusinessException,
  InsufficientStockException,
} from '../../common/exceptions/business.exception';
import { InventoryService } from '../inventory/inventory.service';
import { sortForLocking } from '../inventory/inventory.types';
import { PriceListService } from '../pricing/price-list.service';
import { VoucherService } from '../vouchers/voucher.service';
import { CustomerDebtService } from './customer-debt.service';
import { generateOrderCode } from './order-code';
import {
  calcLineTotal,
  calcOrderTotals,
  deriveTaxRate,
  PricedLine,
} from './order-pricing';
import {
  CreateOrderDto,
  ListOrdersQueryDto,
  OrderTransitionDto,
  PayOrderDto,
  UpdateOrderDto,
} from './order.dto';
import { OrderRepository, orderInclude, OrderWithRelations } from './order.repository';
import { serializeOrderDetail, serializeOrderListItem } from './order.serializer';

type ResolvedItem = {
  variantId: bigint;
  warehouseId: bigint;
  productName: string;
  sku: string;
  quantity: number;
  price: number;
  discount: number;
  total: number;
};

@Injectable()
export class OrderService {
  constructor(
    private repo: OrderRepository,
    private inventory: InventoryService,
    private pricing: PriceListService,
    private vouchers: VoucherService,
    private customerDebt: CustomerDebtService,
  ) {}

  async list(query: ListOrdersQueryDto, user: AuthUser) {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? 20;
    const where: Prisma.OrderWhereInput = {};

    where.items = { some: { warehouseId: { in: user.warehouseIds } } };

    if (query.status) where.status = query.status as OrderStatus;
    if (query.branch_id) where.branchId = BigInt(query.branch_id);
    if (query.sources) {
      const list = query.sources
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (list.length) where.source = { in: list as OrderSource[] };
    } else if (query.source) {
      where.source = query.source as OrderSource;
    }
    if (query.assigned_to) {
      where.assignedToId = BigInt(query.assigned_to);
    }
    if (query.from || query.to) {
      where.orderedAt = {};
      if (query.from) {
        where.orderedAt.gte = new Date(query.from);
      }
      if (query.to) {
        where.orderedAt.lte = new Date(query.to);
      }
    }
    if (query.tags?.trim()) {
      where.tags = { has: query.tags.trim() };
    }
    if (query.q?.trim()) {
      const ids = await findOrderIdsByQuery(this.repo.client, query.q.trim());
      where.id = { in: ids };
    }

    const [rows, total] = await Promise.all([
      this.repo.client.order.findMany({
        where,
        orderBy: { orderedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          customer: true,
          branch: true,
          createdBy: true,
          items: { select: { sku: true }, take: 8 },
        },
      }),
      this.repo.count(where),
    ]);

    return {
      data: rows.map(serializeOrderListItem),
      total,
      page,
      page_size: pageSize,
    };
  }

  async findOne(id: bigint, user?: AuthUser) {
    const order = await this.repo.findById(id);
    if (!order) throw new NotFoundException('Không tìm thấy đơn hàng');
    if (user) {
      assertAnyWarehouseAccess(
        user,
        order.items.map((i) => i.warehouseId),
      );
    }

    const detail = serializeOrderDetail(order);
    const [levels, customerStats] = await Promise.all([
      this.repo.client.inventoryLevel.findMany({
        where: {
          OR: order.items.map((i) => ({
            variantId: i.variantId,
            warehouseId: i.warehouseId,
          })),
        },
      }),
      order.customerId
        ? Promise.all([
            this.repo.client.order.aggregate({
              where: { customerId: order.customerId },
              _count: { _all: true },
              _sum: { totalAmount: true },
            }),
            this.repo.client.order.findFirst({
              where: { customerId: order.customerId },
              orderBy: { orderedAt: 'desc' },
              select: { id: true, code: true },
            }),
          ]).then(([agg, last]) => ({
            total_orders: agg._count._all,
            total_spent: Number(agg._sum.totalAmount ?? 0),
            last_order_id: last?.id.toString() ?? null,
            last_order_code: last?.code ?? null,
          }))
        : Promise.resolve(null),
    ]);
    const availMap = new Map(
      levels.map((l) => [
        `${l.variantId}:${l.warehouseId}`,
        l.available,
      ]),
    );

    return {
      data: {
        ...detail,
        items: detail.items.map((i) => ({
          ...i,
          available: availMap.get(`${i.variant_id}:${i.warehouse_id}`) ?? 0,
        })),
        customer: detail.customer && customerStats
          ? { ...detail.customer, ...customerStats }
          : detail.customer,
      },
    };
  }

  async update(id: bigint, dto: UpdateOrderDto, user: AuthUser) {
    const order = await this.repo.findById(id);
    if (!order) throw new NotFoundException('Không tìm thấy đơn hàng');
    assertAnyWarehouseAccess(
      user,
      order.items.map((i) => i.warehouseId),
    );
    if (order.status !== OrderStatus.ordered) {
      throw new BusinessException(
        'INVALID_TRANSITION',
        'Chỉ sửa đơn ở trạng thái ordered',
        409,
      );
    }

    const discountTotal =
      dto.discount_total !== undefined
        ? dto.discount_total
        : Number(order.discountTotal);
    const shippingFee =
      dto.shipping_fee !== undefined
        ? dto.shipping_fee
        : Number(order.shippingFee);

    const pricedLines: PricedLine[] = order.items.map((i) => ({
      quantity: i.quantity,
      price: Number(i.price),
      discount: Number(i.discount),
    }));
    const subtotal = pricedLines.reduce((s, l) => s + calcLineTotal(l), 0);
    const taxRate =
      dto.tax_rate !== undefined
        ? dto.tax_rate
        : deriveTaxRate(subtotal, discountTotal, Number(order.taxTotal));
    const totals = calcOrderTotals(
      pricedLines,
      discountTotal,
      shippingFee,
      taxRate,
    );

    const paidAmount = Number(order.paidAmount);
    if (totals.totalAmount < paidAmount) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        'Giá trị đơn sau sửa nhỏ hơn số tiền khách đã thanh toán',
        422,
      );
    }

    const data: Prisma.OrderUpdateInput = {
      discountTotal,
      shippingFee,
      subtotal: totals.subtotal,
      taxTotal: totals.taxTotal,
      totalAmount: totals.totalAmount,
      totalQuantity: totals.totalQuantity,
      paymentStatus:
        paidAmount >= totals.totalAmount
          ? PaymentStatus.da_thanh_toan
          : paidAmount > 0
            ? PaymentStatus.mot_phan
            : PaymentStatus.chua_thanh_toan,
    };
    if (dto.note !== undefined) data.note = dto.note.trim() || null;
    if (dto.tags !== undefined) data.tags = dto.tags;
    if (dto.assigned_to !== undefined) {
      data.assignedTo = { connect: { id: BigInt(dto.assigned_to) } };
    }
    if (dto.expected_delivery_at !== undefined) {
      data.expectedDeliveryAt = dto.expected_delivery_at
        ? new Date(dto.expected_delivery_at)
        : null;
    }
    if (dto.shipping_method !== undefined) {
      data.shippingMethod = dto.shipping_method.trim() || null;
    }

    const totalDelta = totals.totalAmount - Number(order.totalAmount);

    const updated = await this.repo.client.$transaction(async (tx) => {
      // Sửa đơn làm đổi giá trị → điều chỉnh nợ phải thu theo chênh lệch
      if (order.customerId && totalDelta !== 0) {
        await this.customerDebt.recordEntry(
          {
            customerId: order.customerId,
            referenceType: CustomerLedgerReferenceType.adjustment,
            referenceCode: order.code,
            transactionLabel: 'Sửa đơn hàng',
            reason: `Cập nhật giá trị đơn ${order.code}`,
            amount: totalDelta,
            createdById: user.userId,
          },
          tx,
        );
      }

      const record = await tx.order.update({
        where: { id },
        data,
        include: orderInclude,
      });

      await tx.activityLog.create({
        data: {
          userId: user.userId,
          action: 'order.update',
          entityType: 'order',
          entityId: id,
          metadata: { code: order.code },
        },
      });

      return record;
    });

    return { data: serializeOrderDetail(updated) };
  }

  /** Thanh toán đơn (toàn bộ hoặc một phần) — phiếu thu + giảm công nợ KH */
  async pay(id: bigint, dto: PayOrderDto, user: AuthUser) {
    const order = await this.repo.findById(id);
    if (!order) throw new NotFoundException('Không tìm thấy đơn hàng');
    assertAnyWarehouseAccess(
      user,
      order.items.map((i) => i.warehouseId),
    );

    if (order.status === OrderStatus.cancelled) {
      throw new BusinessException(
        'INVALID_TRANSITION',
        'Không thể thanh toán đơn đã hủy',
        409,
      );
    }
    if (order.paymentStatus === PaymentStatus.da_thanh_toan) {
      return {
        id: order.id.toString(),
        payment_status: PaymentStatus.da_thanh_toan,
        paid_amount: order.paidAmount.toString(),
      };
    }

    const remaining = Number(order.totalAmount) - Number(order.paidAmount);
    const payAmount = dto.amount ?? remaining;

    if (payAmount <= 0) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        'Số tiền thanh toán phải lớn hơn 0',
        422,
      );
    }
    if (payAmount > remaining) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        `Số tiền thanh toán vượt quá số còn phải thu (còn ${remaining})`,
        422,
      );
    }

    const newPaidAmount = Number(order.paidAmount) + payAmount;
    const newStatus =
      newPaidAmount >= Number(order.totalAmount)
        ? PaymentStatus.da_thanh_toan
        : PaymentStatus.mot_phan;

    const voucher = await this.repo.client.$transaction(async (tx) => {
      await tx.order.update({
        where: { id },
        data: { paymentStatus: newStatus, paidAmount: newPaidAmount },
      });

      const result = await this.vouchers.createReceipt(
        {
          branchId: order.branchId,
          amount: payAmount,
          createdById: user.userId,
          sourceDocument: order.code,
          referenceType: 'order',
          referenceId: order.id,
          reason: `Thanh toán đơn ${order.code}`,
        },
        tx,
      );

      if (order.customerId) {
        await this.customerDebt.recordEntry(
          {
            customerId: order.customerId,
            referenceType: CustomerLedgerReferenceType.payment,
            referenceCode: order.code,
            transactionLabel: 'Thanh toán',
            reason: `Thanh toán đơn ${order.code}`,
            amount: -payAmount,
            createdById: user.userId,
          },
          tx,
        );
      }

      await tx.activityLog.create({
        data: {
          userId: user.userId,
          action: 'order.pay',
          entityType: 'order',
          entityId: id,
          metadata: { code: order.code, amount: payAmount },
        },
      });

      return result;
    });

    return {
      id: order.id.toString(),
      payment_status: newStatus,
      paid_amount: newPaidAmount.toString(),
      voucher,
    };
  }

  async create(dto: CreateOrderDto, user: AuthUser) {
    if (!dto.items?.length) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        'Đơn phải có ít nhất một dòng',
        422,
      );
    }

    for (const item of dto.items) {
      if (!item.warehouse_id) {
        throw new BusinessException(
          'MISSING_WAREHOUSE',
          'Mỗi dòng hàng phải có kho xuất',
          422,
        );
      }
    }

    const branchId = BigInt(dto.branch_id);
    await this.repo.client.branch.findUniqueOrThrow({ where: { id: branchId } });

    if (dto.code) {
      const dup = await this.repo.findByCode(dto.code.trim());
      if (dup) {
        throw new BusinessException(
          'DUPLICATE_CODE',
          'Mã đơn đã tồn tại',
          409,
        );
      }
    }

    const resolvedItems = await this.resolveItems(dto, branchId);
    const pricedLines: PricedLine[] = resolvedItems.map((i) => ({
      quantity: i.quantity,
      price: i.price,
      discount: i.discount,
    }));
    const totals = calcOrderTotals(
      pricedLines,
      dto.discount_total ?? 0,
      dto.shipping_fee ?? 0,
      dto.tax_rate ?? 0,
    );

    const customerId = dto.customer_id ? BigInt(dto.customer_id) : null;
    const assignedToId = dto.assigned_to
      ? BigInt(dto.assigned_to)
      : user.userId;

    const initialPaid = dto.paid_amount ?? 0;
    if (initialPaid > totals.totalAmount) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        'Số tiền thanh toán vượt quá giá trị đơn',
        422,
      );
    }

    try {
      const order = await this.repo.client.$transaction(async (tx) => {
        const code =
          dto.code?.trim() || (await generateOrderCode(tx, branchId));

        const record = await tx.order.create({
          data: {
            code,
            branchId,
            customerId,
            source: dto.source ?? OrderSource.other,
            status: OrderStatus.ordered,
            assignedToId,
            createdById: user.userId,
            email: dto.email?.trim() || null,
            phone: dto.phone?.trim() || null,
            subtotal: totals.subtotal,
            discountTotal: dto.discount_total ?? 0,
            taxTotal: totals.taxTotal,
            shippingFee: dto.shipping_fee ?? 0,
            shippingMethod: dto.shipping_method?.trim() || null,
            totalAmount: totals.totalAmount,
            totalQuantity: totals.totalQuantity,
            paidAmount: initialPaid,
            paymentStatus:
              initialPaid >= totals.totalAmount
                ? PaymentStatus.da_thanh_toan
                : initialPaid > 0
                  ? PaymentStatus.mot_phan
                  : PaymentStatus.chua_thanh_toan,
            note: dto.note?.trim() || null,
            tags: dto.tags ?? [],
            orderedAt: dto.ordered_at ? new Date(dto.ordered_at) : new Date(),
            expectedDeliveryAt: dto.expected_delivery_at
              ? new Date(dto.expected_delivery_at)
              : null,
            items: {
              create: resolvedItems.map((i) => ({
                variantId: i.variantId,
                warehouseId: i.warehouseId,
                productName: i.productName,
                sku: i.sku,
                quantity: i.quantity,
                price: i.price,
                discount: i.discount,
                total: i.total,
              })),
            },
          },
        });

        for (const item of sortForLocking(resolvedItems)) {
          this.inventory.assertWarehouseAccess(user, item.warehouseId);
          await this.inventory.applyMovement(
            {
              variantId: item.variantId,
              warehouseId: item.warehouseId,
              bucket: InventoryBucket.committed,
              change: item.quantity,
              type: MovementType.order_reserve,
              referenceType: 'order',
              referenceId: record.id,
              createdById: user.userId,
            },
            tx,
          );
        }

        // Công nợ KH: khách mua chưa thanh toán → tăng nợ phải thu
        if (customerId) {
          await this.customerDebt.recordEntry(
            {
              customerId,
              referenceType: CustomerLedgerReferenceType.order,
              referenceCode: record.code,
              transactionLabel: 'Bán hàng',
              reason: `Đơn hàng ${record.code}`,
              amount: totals.totalAmount,
              createdById: user.userId,
            },
            tx,
          );
        }

        if (initialPaid > 0) {
          await this.vouchers.createReceipt(
            {
              branchId,
              amount: initialPaid,
              createdById: user.userId,
              sourceDocument: record.code,
              referenceType: 'order',
              referenceId: record.id,
              reason: `Thanh toán đơn ${record.code}`,
            },
            tx,
          );
          if (customerId) {
            await this.customerDebt.recordEntry(
              {
                customerId,
                referenceType: CustomerLedgerReferenceType.payment,
                referenceCode: record.code,
                transactionLabel: 'Thanh toán',
                reason: `Thanh toán khi tạo đơn ${record.code}`,
                amount: -initialPaid,
                createdById: user.userId,
              },
              tx,
            );
          }
        }

        await tx.activityLog.create({
          data: {
            userId: user.userId,
            action: 'order.create',
            entityType: 'order',
            entityId: record.id,
            metadata: { code: record.code, status: record.status },
          },
        });

        return record;
      });

      return { id: order.id.toString(), code: order.code, status: order.status };
    } catch (e) {
      if (e instanceof InsufficientStockException) throw e;
      throw e;
    }
  }

  /** Trừ on_hand + committed cho toàn bộ dòng hàng — dùng ở cả action 'ship'
   * và action 'complete' (khi đơn hoàn thành thẳng mà chưa qua bước xuất hàng). */
  private async shipOrderItems(
    order: OrderWithRelations,
    user: AuthUser,
    tx: Prisma.TransactionClient,
  ) {
    for (const item of sortForLocking(order.items)) {
      await this.inventory.applyMovements(
        [
          {
            variantId: item.variantId,
            warehouseId: item.warehouseId,
            bucket: InventoryBucket.on_hand,
            change: -item.quantity,
            type: MovementType.order_ship,
            referenceType: 'order',
            referenceId: order.id,
            createdById: user.userId,
          },
          {
            variantId: item.variantId,
            warehouseId: item.warehouseId,
            bucket: InventoryBucket.committed,
            change: -item.quantity,
            type: MovementType.order_ship,
            referenceType: 'order',
            referenceId: order.id,
            createdById: user.userId,
          },
        ],
        tx,
      );
    }
  }

  async transition(id: bigint, dto: OrderTransitionDto, user: AuthUser) {
    const order = await this.repo.findById(id);
    if (!order) throw new NotFoundException('Không tìm thấy đơn hàng');
    assertAnyWarehouseAccess(
      user,
      order.items.map((i) => i.warehouseId),
    );

    const action = dto.action;

    if (action === 'processing') {
      if (order.status !== OrderStatus.ordered) {
        throw new BusinessException(
          'INVALID_TRANSITION',
          'Chỉ chuyển processing từ ordered',
          409,
        );
      }
      await this.repo.client.$transaction(async (tx) => {
        await tx.order.update({
          where: { id },
          data: { status: OrderStatus.processing },
        });
        await tx.activityLog.create({
          data: {
            userId: user.userId,
            action: 'order.transition_processing',
            entityType: 'order',
            entityId: id,
            metadata: { code: order.code },
          },
        });
      });
      return { id: id.toString(), status: OrderStatus.processing };
    }

    if (action === 'cancel') {
      if (
        order.status !== OrderStatus.ordered &&
        order.status !== OrderStatus.processing
      ) {
        throw new BusinessException(
          'INVALID_TRANSITION',
          'Không thể hủy đơn ở trạng thái này',
          409,
        );
      }
      if (order.shippedAt) {
        throw new BusinessException(
          'INVALID_TRANSITION',
          'Đơn đã xuất hàng, không thể hủy — dùng đổi trả hàng',
          409,
        );
      }
      await this.repo.client.$transaction(async (tx) => {
        for (const item of sortForLocking(order.items)) {
          await this.inventory.applyMovement(
            {
              variantId: item.variantId,
              warehouseId: item.warehouseId,
              bucket: InventoryBucket.committed,
              change: -item.quantity,
              type: MovementType.order_release,
              referenceType: 'order',
              referenceId: order.id,
              createdById: user.userId,
            },
            tx,
          );
        }
        // Hủy đơn giảm công nợ đúng giá trị đơn; phần khách đã trả
        // trở thành nợ âm (shop nợ khách) chờ hoàn tiền
        if (order.customerId) {
          await this.customerDebt.recordEntry(
            {
              customerId: order.customerId,
              referenceType: CustomerLedgerReferenceType.order,
              referenceCode: order.code,
              transactionLabel: 'Hủy đơn',
              reason: `Hủy đơn hàng ${order.code}`,
              amount: -Number(order.totalAmount),
              createdById: user.userId,
            },
            tx,
          );
        }
        await tx.order.update({
          where: { id },
          data: { status: OrderStatus.cancelled },
        });
        await tx.activityLog.create({
          data: {
            userId: user.userId,
            action: 'order.cancel',
            entityType: 'order',
            entityId: id,
            metadata: { code: order.code },
          },
        });
      });
      return { id: id.toString(), status: OrderStatus.cancelled };
    }

    if (action === 'ship') {
      if (order.status !== OrderStatus.processing) {
        throw new BusinessException(
          'INVALID_TRANSITION',
          'Chỉ xuất hàng từ processing',
          409,
        );
      }
      if (order.shippedAt) {
        throw new BusinessException('INVALID_TRANSITION', 'Đơn đã xuất hàng', 409);
      }
      const shippedAt = await this.repo.client.$transaction(async (tx) => {
        await this.shipOrderItems(order, user, tx);
        const now = new Date();
        await tx.order.update({ where: { id }, data: { shippedAt: now } });
        await tx.activityLog.create({
          data: {
            userId: user.userId,
            action: 'order.ship',
            entityType: 'order',
            entityId: id,
            metadata: { code: order.code },
          },
        });
        return now;
      });
      return {
        id: id.toString(),
        status: order.status,
        shipped_at: shippedAt.toISOString(),
      };
    }

    if (action === 'complete') {
      if (order.status !== OrderStatus.processing) {
        throw new BusinessException(
          'INVALID_TRANSITION',
          'Chỉ hoàn thành từ processing',
          409,
        );
      }
      await this.repo.client.$transaction(async (tx) => {
        // Đơn có thể đã xuất hàng trước đó qua action 'ship' — chỉ xuất
        // kho ở đây nếu chưa từng xuất, tránh trừ tồn kho hai lần.
        if (!order.shippedAt) {
          await this.shipOrderItems(order, user, tx);
        }
        await tx.order.update({
          where: { id },
          data: { status: OrderStatus.completed, shippedAt: order.shippedAt ?? new Date() },
        });
        await tx.activityLog.create({
          data: {
            userId: user.userId,
            action: 'order.complete',
            entityType: 'order',
            entityId: id,
            metadata: { code: order.code },
          },
        });
      });
      return { id: id.toString(), status: OrderStatus.completed };
    }

    throw new BusinessException('VALIDATION_ERROR', 'Action không hợp lệ', 422);
  }

  /** Dùng chung cho draft convert & channel webhook */
  async createFromResolvedItems(
    params: {
      branchId: bigint;
      source: OrderSource;
      customerId?: bigint | null;
      items: ResolvedItem[];
      discountTotal?: number;
      shippingFee?: number;
      note?: string;
      phone?: string;
    },
    user: AuthUser,
  ) {
    const dto: CreateOrderDto = {
      branch_id: params.branchId.toString(),
      source: params.source,
      customer_id: params.customerId?.toString(),
      items: params.items.map((i) => ({
        variant_id: i.variantId.toString(),
        warehouse_id: i.warehouseId.toString(),
        quantity: i.quantity,
        price: i.price,
        discount: i.discount,
      })),
      discount_total: params.discountTotal,
      shipping_fee: params.shippingFee,
      note: params.note,
      phone: params.phone,
    };
    return this.create(dto, user);
  }

  private async resolveItems(
    dto: CreateOrderDto,
    branchId: bigint,
  ): Promise<ResolvedItem[]> {
    const result: ResolvedItem[] = [];
    for (const item of dto.items) {
      const variantId = BigInt(item.variant_id);
      const warehouseId = BigInt(item.warehouse_id);
      const variant = await this.repo.client.productVariant.findUnique({
        where: { id: variantId },
        include: { product: true },
      });
      if (!variant) {
        throw new BusinessException(
          'VALIDATION_ERROR',
          `Không tìm thấy phiên bản ${item.variant_id}`,
          422,
        );
      }

      let price = item.price;
      if (price === undefined) {
        const resolved = await this.pricing.resolvePrice(variantId, {
          branch_id: branchId,
        });
        price = resolved.price;
      }

      const discount = item.discount ?? 0;
      result.push({
        variantId,
        warehouseId,
        productName: variant.product.name,
        sku: variant.sku,
        quantity: item.quantity,
        price,
        discount,
        total: calcLineTotal({ quantity: item.quantity, price, discount }),
      });
    }
    return result;
  }
}

export type { ResolvedItem };
