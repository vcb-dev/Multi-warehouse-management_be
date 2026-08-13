import { Injectable, NotFoundException } from '@nestjs/common';
import {
  GoodsReceiptStatus,
  InventoryBucket,
  MovementType,
  PaymentStatus,
  PoStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { BusinessException } from '../../common/exceptions/business.exception';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import {
  assertLocationPermission,
  locationScopeFilter,
} from '../../common/auth/access';
import { InventoryService } from '../inventory/inventory.service';
import { sortForLocking } from '../inventory/inventory.types';
import { VoucherService } from '../vouchers/voucher.service';
import { PurchaseOrderService } from './purchase-order.service';
import {
  CreateGoodsReceiptDto,
  ListGoodsReceiptsQueryDto,
} from './purchasing.dto';
import { serializeGoodsReceipt } from './purchasing.serializer';

// DB ở xa (Supabase qua pooler) + transaction lặp qua nhiều dòng sản phẩm dễ
// vượt timeout mặc định 5s của Prisma interactive transaction.
const TX_OPTIONS = { timeout: 15_000, maxWait: 10_000 };

const reiInclude = {
  items: {
    include: {
      variant: { select: { sku: true } },
      purchaseOrder: { select: { code: true } },
    },
  },
  supplier: { select: { code: true, name: true } },
  location: { select: { code: true, name: true } },
  purchaseOrder: { select: { code: true } },
  assignedTo: { select: { firstName: true, lastName: true, email: true } },
} satisfies Prisma.GoodsReceiptInclude;

/** Khớp @RequirePermission trong purchasing.controller. */
const REI_READ = ['purchasing:manage', 'inventory:view', 'inventory:receive'];
const REI_WRITE = ['inventory:receive', 'purchasing:manage'];
/** Thanh toán phiếu nhập chặt hơn: chỉ purchasing:manage (khớp controller). */
const REI_PAY = ['purchasing:manage'];

@Injectable()
export class GoodsReceiptService {
  constructor(
    private prisma: PrismaService,
    private inventory: InventoryService,
    private poService: PurchaseOrderService,
    private vouchers: VoucherService,
  ) {}

  async list(query: ListGoodsReceiptsQueryDto, user: AuthUser) {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? 20;
    const where: Prisma.GoodsReceiptWhereInput = {
      locationId: locationScopeFilter(user, REI_READ),
    };

    if (query.status) {
      where.status = query.status as GoodsReceiptStatus;
    }
    if (query.supplier_id) {
      where.supplierId = BigInt(query.supplier_id);
    }
    if (query.payment_status) {
      const statuses = query.payment_status
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean) as PaymentStatus[];
      if (statuses.length) where.paymentStatus = { in: statuses };
    }
    if (query.date_from || query.date_to) {
      where.createdAt = {
        ...(query.date_from ? { gte: new Date(query.date_from) } : {}),
        ...(query.date_to ? { lte: new Date(query.date_to) } : {}),
      };
    }

    const [rows, total] = await Promise.all([
      this.prisma.goodsReceipt.findMany({
        where,
        include: reiInclude,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.goodsReceipt.count({ where }),
    ]);

    return {
      data: rows.map(serializeGoodsReceipt),
      total,
      page,
      page_size: pageSize,
    };
  }

  async findOne(id: bigint, user: AuthUser) {
    const rei = await this.prisma.goodsReceipt.findUnique({
      where: { id },
      include: reiInclude,
    });
    if (!rei) throw new NotFoundException('Không tìm thấy phiếu nhập');
    assertLocationPermission(user, REI_READ, rei.locationId);
    return { data: serializeGoodsReceipt(rei) };
  }

  /** Chốt quyền theo kho của phiếu cho endpoint không cần nạp cả phiếu. */
  async assertReceiptReadable(id: bigint, user: AuthUser) {
    const rei = await this.prisma.goodsReceipt.findUnique({
      where: { id },
      select: { locationId: true },
    });
    if (!rei) throw new NotFoundException('Không tìm thấy phiếu nhập');
    assertLocationPermission(user, REI_READ, rei.locationId);
  }

  async create(dto: CreateGoodsReceiptDto, user: AuthUser) {
    if (!dto.items?.length) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        'Phiếu nhập phải có ít nhất một dòng',
        422,
      );
    }

    if (!dto.invoice_symbol?.trim()) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        'Ký hiệu hóa đơn là bắt buộc',
        422,
      );
    }

    await this.getActiveSupplier(BigInt(dto.supplier_id));
    assertLocationPermission(user, REI_WRITE, BigInt(dto.location_id));

    // Gom PO tham chiếu: từng dòng có thể gắn PO riêng, dòng không gắn thì
    // dùng PO chung của phiếu (nếu có).
    const poIds = new Set<string>();
    if (dto.purchase_order_id) poIds.add(dto.purchase_order_id);
    for (const item of dto.items) {
      if (item.purchase_order_id) poIds.add(item.purchase_order_id);
    }

    const poMap = new Map<
      string,
      Prisma.PurchaseOrderGetPayload<{ include: { items: true } }>
    >();
    for (const poId of poIds) {
      const po = await this.prisma.purchaseOrder.findUnique({
        where: { id: BigInt(poId) },
        include: { items: true },
      });
      if (!po) {
        throw new BusinessException(
          'VALIDATION_ERROR',
          'PO không tồn tại',
          422,
        );
      }
      if (po.status !== PoStatus.cho_nhap) {
        throw new BusinessException(
          'VALIDATION_ERROR',
          `PO ${po.code} phải ở trạng thái chờ nhập`,
          422,
        );
      }
      if (po.supplierId !== BigInt(dto.supplier_id)) {
        throw new BusinessException(
          'VALIDATION_ERROR',
          `NCC không khớp với PO ${po.code}`,
          422,
        );
      }
      if (po.locationId !== BigInt(dto.location_id)) {
        throw new BusinessException(
          'VALIDATION_ERROR',
          `Kho không khớp với PO ${po.code}`,
          422,
        );
      }
      poMap.set(poId, po);
    }

    // Bắt buộc mỗi dòng gắn một PO, và sản phẩm phải có mặt trên PO đó
    for (const item of dto.items) {
      const poId = item.purchase_order_id ?? dto.purchase_order_id;
      if (!poId) {
        throw new BusinessException(
          'VALIDATION_ERROR',
          'Mỗi dòng sản phẩm phải gắn với một đơn đặt hàng (PO)',
          422,
        );
      }
      const po = poMap.get(poId)!;
      if (!po.items.some((i) => i.variantId === BigInt(item.variant_id))) {
        throw new BusinessException(
          'VALIDATION_ERROR',
          `Sản phẩm ${item.variant_id} không có trên PO ${po.code}`,
          422,
        );
      }
    }

    // PO gắn ở header: giữ giá trị client gửi; nếu mọi dòng cùng quy về đúng
    // 1 PO thì gắn luôn để hiển thị "nhập theo PO" và cấn trừ cọc như cũ.
    // Nhiều PO khác nhau trên cùng phiếu → header để trống, cọc không tự cấn.
    const headerPoId =
      dto.purchase_order_id ?? (poIds.size === 1 ? [...poIds][0] : undefined);

    const code = await this.generateReiCode();

    const rei = await this.prisma.$transaction(async (tx) => {
      const receipt = await tx.goodsReceipt.create({
        data: {
          code,
          supplierId: BigInt(dto.supplier_id),
          locationId: BigInt(dto.location_id),
          purchaseOrderId: headerPoId ? BigInt(headerPoId) : null,
          status: GoodsReceiptStatus.chua_nhap,
          paymentStatus: PaymentStatus.chua_thanh_toan,
          createdById: user.userId,
          assignedToId: dto.assigned_to_id ? BigInt(dto.assigned_to_id) : null,
          expectedReceiptAt: dto.expected_receipt_at
            ? new Date(dto.expected_receipt_at)
            : null,
          invoiceAt: dto.invoice_at ? new Date(dto.invoice_at) : null,
          invoiceSymbol: dto.invoice_symbol?.trim() || null,
          orderCode: dto.order_code?.trim() || null,
          referenceCode: dto.reference_code?.trim() || null,
          discountAmount: dto.discount_amount ?? 0,
          extraCost: dto.extra_cost ?? 0,
        },
      });

      for (const item of dto.items) {
        const itemPoId = item.purchase_order_id ?? headerPoId;
        await tx.goodsReceiptItem.create({
          data: {
            goodsReceiptId: receipt.id,
            variantId: BigInt(item.variant_id),
            purchaseOrderId: itemPoId ? BigInt(itemPoId) : null,
            quantity: item.quantity,
            unitPrice: item.unit_price,
          },
        });
      }

      await tx.activityLog.create({
        data: {
          userId: user.userId,
          action: 'goods_receipt.create',
          entityType: 'goods_receipt',
          entityId: receipt.id,
          metadata: { code: receipt.code },
        },
      });

      return tx.goodsReceipt.findUniqueOrThrow({
        where: { id: receipt.id },
        include: reiInclude,
      });
    }, TX_OPTIONS);

    return { data: serializeGoodsReceipt(rei) };
  }

  async confirm(id: bigint, user: AuthUser) {
    const rei = await this.prisma.goodsReceipt.findUnique({
      where: { id },
      include: { items: true },
    });
    if (!rei) throw new NotFoundException('Không tìm thấy phiếu nhập');
    if (rei.status === GoodsReceiptStatus.da_nhap) {
      throw new BusinessException(
        'INVALID_TRANSITION',
        'Phiếu nhập đã xác nhận',
        409,
      );
    }
    if (rei.status === GoodsReceiptStatus.huy) {
      throw new BusinessException(
        'INVALID_TRANSITION',
        'Phiếu nhập đã hủy',
        409,
      );
    }

    assertLocationPermission(user, REI_WRITE, rei.locationId);

    const movementIds: bigint[] = [];
    let amountDue = 0;

    await this.prisma.$transaction(async (tx) => {
      // PO hiệu lực của từng dòng: PO gắn riêng trên dòng, fallback về PO
      // chung của phiếu (dữ liệu cũ chỉ gắn header).
      const poIdOf = (item: (typeof rei.items)[number]) =>
        item.purchaseOrderId ?? rei.purchaseOrderId;

      const poIds = [
        ...new Set(
          rei.items
            .map((i) => poIdOf(i)?.toString())
            .filter((v): v is string => !!v),
        ),
      ];

      const pos = await tx.purchaseOrder.findMany({
        where: { id: { in: poIds.map((v) => BigInt(v)) } },
        include: { items: true },
      });
      // key: `${poId}:${variantId}`
      const poItemMap = new Map<string, (typeof pos)[number]['items'][number]>(
        pos.flatMap((po) =>
          po.items.map((i): [string, typeof i] => [
            `${po.id}:${i.variantId}`,
            i,
          ]),
        ),
      );

      // Gom theo (PO, variant) để validate incoming còn lại trên từng PO
      const qtyByPoVariant = new Map<string, number>();
      for (const item of rei.items) {
        const poId = poIdOf(item);
        if (!poId) continue;
        const key = `${poId}:${item.variantId}`;
        qtyByPoVariant.set(key, (qtyByPoVariant.get(key) ?? 0) + item.quantity);
      }

      for (const [key, qty] of qtyByPoVariant) {
        const poItem = poItemMap.get(key);
        if (!poItem) {
          throw new BusinessException(
            'VALIDATION_ERROR',
            `Variant ${key.split(':')[1]} không có trên PO`,
            422,
          );
        }
        const remaining = poItem.quantity - poItem.receivedQuantity;
        if (qty > remaining) {
          throw new BusinessException(
            'INCOMING_EXCEEDS_PO',
            `Số lượng nhập vượt incoming còn lại (còn ${remaining}, nhập ${qty})`,
            422,
          );
        }
      }

      for (const item of sortForLocking(rei.items)) {
        amountDue += item.quantity * Number(item.unitPrice);
        const movements: Parameters<InventoryService['applyMovements']>[0] = [];
        const itemPoId = poIdOf(item);

        if (itemPoId) {
          movements.push({
            variantId: item.variantId,
            locationId: rei.locationId,
            bucket: InventoryBucket.incoming,
            change: -item.quantity,
            type: MovementType.incoming_receipt,
            referenceType: 'goods_receipt',
            referenceId: rei.id,
            createdById: user.userId,
          });
        }

        movements.push({
          variantId: item.variantId,
          locationId: rei.locationId,
          bucket: InventoryBucket.on_hand,
          change: item.quantity,
          type: MovementType.receipt,
          referenceType: 'goods_receipt',
          referenceId: rei.id,
          createdById: user.userId,
          cost: item.unitPrice,
        });

        const result = await this.inventory.applyMovements(movements, tx);
        movementIds.push(...result.movementIds);

        if (itemPoId) {
          const poItem = poItemMap.get(`${itemPoId}:${item.variantId}`);
          if (poItem) {
            await tx.purchaseOrderItem.update({
              where: { id: poItem.id },
              data: {
                receivedQuantity: poItem.receivedQuantity + item.quantity,
              },
            });
            poItem.receivedQuantity += item.quantity;
          }
        }
      }

      amountDue =
        amountDue - Number(rei.discountAmount) + Number(rei.extraCost);

      // Cấn trừ tiền cọc đã đóng trên PO (nếu phiếu nhập gắn với PO có cọc)
      let depositApplied = 0;
      if (rei.purchaseOrderId) {
        const po = await tx.purchaseOrder.findUnique({
          where: { id: rei.purchaseOrderId },
          select: { depositAmount: true },
        });
        if (po && Number(po.depositAmount) > 0) {
          const used = await tx.goodsReceipt.aggregate({
            _sum: { depositApplied: true },
            where: {
              purchaseOrderId: rei.purchaseOrderId,
              id: { not: rei.id },
            },
          });
          const available =
            Number(po.depositAmount) - Number(used._sum.depositApplied ?? 0);
          depositApplied = Math.min(Math.max(available, 0), amountDue);
        }
      }
      // amountDue <= 0 (đơn 0đ, hoặc chiết khấu vượt tổng tiền hàng) ⇒ không
      // nợ gì NCC, coi như đã thanh toán ngay — không cần gọi pay().
      const paymentStatus =
        amountDue <= 0 || depositApplied >= amountDue
          ? PaymentStatus.da_thanh_toan
          : depositApplied > 0
            ? PaymentStatus.mot_phan
            : PaymentStatus.chua_thanh_toan;

      await tx.goodsReceipt.update({
        where: { id: rei.id },
        data: {
          status: GoodsReceiptStatus.da_nhap,
          amountDue,
          receivedAt: new Date(),
          depositApplied,
          paidAmount: depositApplied,
          paymentStatus,
        },
      });

      for (const poId of poIds) {
        await this.poService.tryCompleteIfFullyReceived(
          BigInt(poId),
          user.userId,
          tx,
        );
      }

      await tx.supplierLedgerEntry.create({
        data: {
          supplierId: rei.supplierId,
          referenceType: 'goods_receipt',
          referenceCode: rei.code,
          transactionLabel: 'Nhập hàng',
          reason: 'Nhập hàng',
          amount: -amountDue,
          createdById: user.userId,
        },
      });

      if (depositApplied > 0) {
        await tx.supplierLedgerEntry.create({
          data: {
            supplierId: rei.supplierId,
            referenceType: 'payment',
            referenceCode: rei.code,
            transactionLabel: 'Trừ cọc',
            reason: 'Trừ tiền cọc đặt hàng nhập',
            amount: depositApplied,
            createdById: user.userId,
          },
        });
      }

      await tx.activityLog.create({
        data: {
          userId: user.userId,
          action: 'goods_receipt.confirm',
          entityType: 'goods_receipt',
          entityId: rei.id,
          metadata: { code: rei.code },
        },
      });
    }, TX_OPTIONS);

    return {
      id: rei.id.toString(),
      status: GoodsReceiptStatus.da_nhap,
      movement_ids: movementIds.map((m) => m.toString()),
      amount_due: amountDue.toString(),
    };
  }

  async pay(id: bigint, user: AuthUser, amount?: number) {
    const rei = await this.prisma.goodsReceipt.findUnique({
      where: { id },
      include: { supplier: true, location: true },
    });
    if (!rei) throw new NotFoundException('Không tìm thấy phiếu nhập');
    if (rei.status !== GoodsReceiptStatus.da_nhap) {
      throw new BusinessException(
        'INVALID_TRANSITION',
        'Chỉ thanh toán phiếu đã nhập',
        409,
      );
    }
    if (rei.paymentStatus === PaymentStatus.da_thanh_toan) {
      return {
        id: rei.id.toString(),
        payment_status: PaymentStatus.da_thanh_toan,
        paid_amount: rei.paidAmount.toString(),
      };
    }

    assertLocationPermission(user, REI_PAY, rei.locationId);

    const remaining = Number(rei.amountDue) - Number(rei.paidAmount);

    // Không còn nợ (đơn 0đ, hoặc phiếu cũ lỡ bị kẹt trạng thái trước khi có
    // fix ở confirm()) ⇒ chốt đã thanh toán, không tạo phiếu chi 0đ.
    if (remaining <= 0) {
      await this.prisma.goodsReceipt.update({
        where: { id },
        data: { paymentStatus: PaymentStatus.da_thanh_toan },
      });
      return {
        id: rei.id.toString(),
        payment_status: PaymentStatus.da_thanh_toan,
        paid_amount: rei.paidAmount.toString(),
      };
    }

    const payAmount = amount ?? remaining;

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
        `Số tiền thanh toán vượt quá số tiền còn phải trả (còn ${remaining})`,
        422,
      );
    }

    const newPaidAmount = Number(rei.paidAmount) + payAmount;
    const newStatus =
      newPaidAmount >= Number(rei.amountDue)
        ? PaymentStatus.da_thanh_toan
        : PaymentStatus.mot_phan;

    const voucher = await this.prisma.$transaction(async (tx) => {
      await tx.goodsReceipt.update({
        where: { id },
        data: { paymentStatus: newStatus, paidAmount: newPaidAmount },
      });

      const result = await this.vouchers.createPayment(
        {
          locationId: rei.locationId,
          amount: payAmount,
          createdById: user.userId,
          sourceDocument: rei.code,
          referenceType: 'goods_receipt',
          referenceId: rei.id,
          reason: `Thanh toán nhập hàng — NCC ${rei.supplier.name}`,
        },
        tx,
      );

      await tx.supplierLedgerEntry.create({
        data: {
          supplierId: rei.supplierId,
          referenceType: 'payment',
          referenceCode: rei.code,
          transactionLabel: 'Thanh toán',
          reason: 'Thanh toán nhập hàng',
          amount: payAmount,
          createdById: user.userId,
        },
      });

      await tx.activityLog.create({
        data: {
          userId: user.userId,
          action: 'goods_receipt.pay',
          entityType: 'goods_receipt',
          entityId: rei.id,
          metadata: { code: rei.code, amount: payAmount },
        },
      });

      return result;
    }, TX_OPTIONS);

    return {
      id: rei.id.toString(),
      payment_status: newStatus,
      paid_amount: newPaidAmount.toString(),
      voucher,
    };
  }

  async cancel(id: bigint, user: AuthUser) {
    const rei = await this.prisma.goodsReceipt.findUnique({ where: { id } });
    if (!rei) throw new NotFoundException('Không tìm thấy phiếu nhập');
    if (rei.status !== GoodsReceiptStatus.chua_nhap) {
      throw new BusinessException(
        'INVALID_TRANSITION',
        'Chỉ hủy được phiếu nhập chưa nhập kho',
        409,
      );
    }

    assertLocationPermission(user, REI_WRITE, rei.locationId);

    // Phiếu "chưa nhập" chưa từng đụng vào tồn kho/công nợ nên hủy = xóa hẳn,
    // không giữ lại bản ghi "đã hủy" (khớp Sapo: chỉ có 2 trạng thái Đã nhập/Chưa nhập).
    await this.prisma.$transaction(async (tx) => {
      await tx.activityLog.create({
        data: {
          userId: user.userId,
          action: 'goods_receipt.cancel',
          entityType: 'goods_receipt',
          entityId: rei.id,
          metadata: { code: rei.code },
        },
      });

      await tx.goodsReceipt.delete({ where: { id } });
    }, TX_OPTIONS);

    return { id: rei.id.toString(), deleted: true };
  }

  private async getActiveSupplier(id: bigint) {
    const s = await this.prisma.supplier.findUnique({ where: { id } });
    if (!s || !s.isActive) {
      throw new BusinessException('VALIDATION_ERROR', 'NCC không hợp lệ', 422);
    }
    return s;
  }

  private async generateReiCode() {
    // Dựa vào count() sẽ trùng mã sau khi phiếu nháp bị xóa hẳn (cancel), nên
    // phải lấy số thứ tự cao nhất đã từng cấp thay vì đếm số bản ghi còn lại.
    // Sắp theo chính "code" (không phải id) — thứ tự tạo record không đảm bảo
    // khớp thứ tự số trong code nếu dữ liệu cũ từng bị cấp lệch.
    const latest = await this.prisma.goodsReceipt.findFirst({
      orderBy: { code: 'desc' },
      select: { code: true },
    });
    const nextSeq = latest ? Number(latest.code.slice(3)) + 1 : 1;
    return `REI${String(nextSeq).padStart(6, '0')}`;
  }
}
