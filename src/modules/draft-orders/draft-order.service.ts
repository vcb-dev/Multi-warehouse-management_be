import { Injectable, NotFoundException } from '@nestjs/common';
import { DraftOrderStatus, OrderSource, Prisma } from '@prisma/client';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { assertAnyWarehouseAccess, assertWarehouseAccess, isAdminUser } from '../../common/auth/access';
import { BusinessException } from '../../common/exceptions/business.exception';
import { OrderService } from '../orders/order.service';
import { generateDraftCode } from '../orders/order-code';
import { calcLineTotal, calcOrderTotals } from '../orders/order-pricing';
import { CreateDraftOrderDto, UpdateDraftOrderDto } from '../orders/order.dto';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class DraftOrderService {
  constructor(
    private prisma: PrismaService,
    private orders: OrderService,
  ) {}

  async list(user: AuthUser) {
    const where: Prisma.DraftOrderWhereInput = { status: DraftOrderStatus.draft };
    if (!isAdminUser(user)) {
      where.items = { some: { warehouseId: { in: user.warehouseIds } } };
    }
    const rows = await this.prisma.draftOrder.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: { items: true, customer: true, branch: true },
    });
    return {
      data: rows.map((d) => {
        const customerName = d.customer
          ? [d.customer.firstName, d.customer.lastName].filter(Boolean).join(' ')
          : null;
        return {
          id: d.id.toString(),
          code: d.code,
          status: d.status,
          source: d.source,
          branch_name: d.branch.name,
          customer_name: customerName,
          tags: d.tags,
          subtotal: Number(d.subtotal),
          discount_total: Number(d.discountTotal),
          tax_total: Number(d.taxTotal),
          shipping_fee: Number(d.shippingFee),
          total_amount: Number(d.totalAmount),
          total_quantity: d.items.reduce((s, i) => s + i.quantity, 0),
          item_count: d.items.length,
          note: d.note,
          created_at: d.createdAt.toISOString(),
        };
      }),
    };
  }

  async create(dto: CreateDraftOrderDto, user: AuthUser) {
    if (!dto.items?.length) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        'Nháp phải có ít nhất một dòng',
        422,
      );
    }

    const branchId = BigInt(dto.branch_id);
    const code = await generateDraftCode(this.prisma);
    const lines = await this.resolveDraftLines(dto);
    const totals = calcOrderTotals(
      lines,
      dto.discount_total ?? 0,
      dto.shipping_fee ?? 0,
      dto.tax_rate ?? 0,
    );

    const draft = await this.prisma.draftOrder.create({
      data: {
        code,
        branchId,
        customerId: dto.customer_id ? BigInt(dto.customer_id) : null,
        source: dto.source ?? OrderSource.other,
        status: DraftOrderStatus.draft,
        createdById: user.userId,
        subtotal: totals.subtotal,
        discountTotal: dto.discount_total ?? 0,
        taxTotal: totals.taxTotal,
        shippingFee: dto.shipping_fee ?? 0,
        totalAmount: totals.totalAmount,
        note: dto.note?.trim() || null,
        tags: dto.tags ?? [],
        items: {
          create: lines.map((l) => ({
            variantId: l.variantId,
            warehouseId: l.warehouseId,
            productName: l.productName,
            sku: l.sku,
            quantity: l.quantity,
            price: l.price,
            discount: l.discount,
          })),
        },
      },
    });

    return { id: draft.id.toString(), code: draft.code };
  }

  async findOne(id: bigint, user?: AuthUser) {
    const draft = await this.prisma.draftOrder.findUnique({
      where: { id },
      include: { items: true, customer: true, branch: true },
    });
    if (!draft) throw new NotFoundException('Không tìm thấy đơn nháp');
    if (user) {
      assertAnyWarehouseAccess(
        user,
        draft.items.map((i) => i.warehouseId),
      );
    }
    return {
      data: {
        id: draft.id.toString(),
        code: draft.code,
        status: draft.status,
        branch_id: draft.branchId.toString(),
        branch_name: draft.branch.name,
        customer_id: draft.customerId?.toString() ?? null,
        source: draft.source,
        phone: draft.customer?.phone ?? null,
        tags: draft.tags,
        note: draft.note,
        discount_total: Number(draft.discountTotal),
        tax_total: Number(draft.taxTotal),
        shipping_fee: Number(draft.shippingFee),
        total_amount: Number(draft.totalAmount),
        items: draft.items.map((i) => ({
          variant_id: i.variantId.toString(),
          warehouse_id: i.warehouseId.toString(),
          product_name: i.productName,
          sku: i.sku,
          quantity: i.quantity,
          price: Number(i.price),
          discount: Number(i.discount),
        })),
      },
    };
  }

  async update(id: bigint, dto: UpdateDraftOrderDto, user: AuthUser) {
    const draft = await this.prisma.draftOrder.findUnique({
      where: { id },
      include: { items: true },
    });
    if (!draft) throw new NotFoundException('Không tìm thấy đơn nháp');
    assertAnyWarehouseAccess(
      user,
      draft.items.map((i) => i.warehouseId),
    );
    if (draft.status !== DraftOrderStatus.draft) {
      throw new BusinessException(
        'INVALID_TRANSITION',
        'Chỉ sửa đơn nháp ở trạng thái draft',
        409,
      );
    }
    if (!dto.items?.length) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        'Nháp phải có ít nhất một dòng',
        422,
      );
    }

    const branchId = BigInt(dto.branch_id);
    const lines = await this.resolveDraftLines(dto);
    for (const line of lines) {
      assertWarehouseAccess(user, line.warehouseId);
    }
    const totals = calcOrderTotals(
      lines,
      dto.discount_total ?? 0,
      dto.shipping_fee ?? 0,
      dto.tax_rate ?? 0,
    );

    await this.prisma.$transaction(async (tx) => {
      await tx.draftOrderItem.deleteMany({ where: { draftOrderId: id } });
      await tx.draftOrder.update({
        where: { id },
        data: {
          branchId,
          customerId: dto.customer_id ? BigInt(dto.customer_id) : null,
          source: dto.source ?? draft.source,
          subtotal: totals.subtotal,
          discountTotal: dto.discount_total ?? 0,
          taxTotal: totals.taxTotal,
          shippingFee: dto.shipping_fee ?? 0,
          totalAmount: totals.totalAmount,
          note: dto.note?.trim() || null,
          tags: dto.tags ?? [],
          items: {
            create: lines.map((l) => ({
              variantId: l.variantId,
              warehouseId: l.warehouseId,
              productName: l.productName,
              sku: l.sku,
              quantity: l.quantity,
              price: l.price,
              discount: l.discount,
            })),
          },
        },
      });
      await tx.activityLog.create({
        data: {
          userId: user.userId,
          action: 'draft_order.update',
          entityType: 'draft_order',
          entityId: id,
        },
      });
    });

    return this.findOne(id, user);
  }

  async convert(id: bigint, user: AuthUser) {
    const draft = await this.prisma.draftOrder.findUnique({
      where: { id },
      include: { items: true },
    });
    if (!draft) throw new NotFoundException('Không tìm thấy đơn nháp');
    assertAnyWarehouseAccess(
      user,
      draft.items.map((i) => i.warehouseId),
    );
    if (draft.status !== DraftOrderStatus.draft) {
      throw new BusinessException(
        'INVALID_TRANSITION',
        'Đơn nháp đã chuyển đổi',
        409,
      );
    }
    if (!draft.items.length) {
      throw new BusinessException('VALIDATION_ERROR', 'Nháp không có dòng', 422);
    }

    const result = await this.orders.create(
      {
        branch_id: draft.branchId.toString(),
        source: draft.source,
        customer_id: draft.customerId?.toString(),
        items: draft.items.map((i) => ({
          variant_id: i.variantId.toString(),
          warehouse_id: i.warehouseId.toString(),
          quantity: i.quantity,
          price: Number(i.price),
          discount: Number(i.discount),
        })),
        discount_total: Number(draft.discountTotal),
        shipping_fee: Number(draft.shippingFee),
        note: draft.note ?? undefined,
      },
      user,
    );

    await this.prisma.draftOrder.update({
      where: { id },
      data: {
        status: DraftOrderStatus.confirmed,
        convertedOrderId: BigInt(result.id),
      },
    });

    return { order_id: result.id, status: result.status };
  }

  private async resolveDraftLines(dto: CreateDraftOrderDto) {
    const lines: {
      variantId: bigint;
      warehouseId: bigint;
      productName: string;
      sku: string;
      quantity: number;
      price: number;
      discount: number;
    }[] = [];

    for (const item of dto.items) {
      if (!item.warehouse_id) {
        throw new BusinessException(
          'MISSING_WAREHOUSE',
          'Mỗi dòng phải có kho xuất',
          422,
        );
      }
      const variant = await this.prisma.productVariant.findUnique({
        where: { id: BigInt(item.variant_id) },
        include: { product: true },
      });
      if (!variant) {
        throw new BusinessException('VALIDATION_ERROR', 'Phiên bản không tồn tại', 422);
      }
      const price = item.price ?? Number(variant.price);
      const discount = item.discount ?? 0;
      lines.push({
        variantId: variant.id,
        warehouseId: BigInt(item.warehouse_id),
        productName: variant.product.name,
        sku: variant.sku,
        quantity: item.quantity,
        price,
        discount,
      });
    }
    return lines;
  }
}
