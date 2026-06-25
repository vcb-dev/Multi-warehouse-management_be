import { Injectable, NotFoundException } from '@nestjs/common';
import {
  InventoryBucket,
  MovementType,
  OrderSource,
  OrderStatus,
  Prisma,
} from '@prisma/client';
import { assertAnyWarehouseAccess, isAdminUser } from '../../common/auth/access';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import {
  BusinessException,
  InsufficientStockException,
} from '../../common/exceptions/business.exception';
import { InventoryService } from '../inventory/inventory.service';
import { PriceListService } from '../pricing/price-list.service';
import { generateOrderCode } from './order-code';
import {
  calcLineTotal,
  calcOrderTotals,
  deriveTaxRate,
  PricedLine,
} from './order-pricing';
import { CreateOrderDto, ListOrdersQueryDto, OrderTransitionDto, UpdateOrderDto } from './order.dto';
import { OrderRepository, orderInclude } from './order.repository';
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
  ) {}

  async list(query: ListOrdersQueryDto, user: AuthUser) {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? 20;
    const where: Prisma.OrderWhereInput = {};

    if (!isAdminUser(user)) {
      where.items = { some: { warehouseId: { in: user.warehouseIds } } };
    }

    if (query.status) where.status = query.status as OrderStatus;
    if (query.branch_id) where.branchId = BigInt(query.branch_id);
    if (query.source) where.source = query.source as OrderSource;
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
      where.OR = [
        { code: { contains: query.q.trim(), mode: 'insensitive' } },
        { phone: { contains: query.q.trim() } },
        {
          items: {
            some: { sku: { contains: query.q.trim(), mode: 'insensitive' } },
          },
        },
      ];
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
    const levels = await this.repo.client.inventoryLevel.findMany({
      where: {
        OR: order.items.map((i) => ({
          variantId: i.variantId,
          warehouseId: i.warehouseId,
        })),
      },
    });
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

    const data: Prisma.OrderUpdateInput = {
      discountTotal,
      shippingFee,
      subtotal: totals.subtotal,
      taxTotal: totals.taxTotal,
      totalAmount: totals.totalAmount,
      totalQuantity: totals.totalQuantity,
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

    const updated = await this.repo.client.order.update({
      where: { id },
      data,
      include: orderInclude,
    });

    return { data: serializeOrderDetail(updated) };
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
            totalAmount: totals.totalAmount,
            totalQuantity: totals.totalQuantity,
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

        for (const item of resolvedItems) {
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
      await this.repo.client.order.update({
        where: { id },
        data: { status: OrderStatus.processing },
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
      await this.repo.client.$transaction(async (tx) => {
        for (const item of order.items) {
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
        await tx.order.update({
          where: { id },
          data: { status: OrderStatus.cancelled },
        });
      });
      return { id: id.toString(), status: OrderStatus.cancelled };
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
        for (const item of order.items) {
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
        await tx.order.update({
          where: { id },
          data: { status: OrderStatus.completed },
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
