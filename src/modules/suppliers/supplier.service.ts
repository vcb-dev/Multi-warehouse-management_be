import { Injectable, NotFoundException } from '@nestjs/common';
import {
  GoodsReceiptStatus,
  PaymentStatus,
  Prisma,
  RefundStatus,
  SupplierLedgerReferenceType,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { BusinessException } from '../../common/exceptions/business.exception';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { findSupplierIdsByQuery } from '../../common/search/unaccent-search';
import { VoucherService } from '../vouchers/voucher.service';
import { serializeLedgerEntry } from '../purchasing/purchasing.serializer';
import {
  CreateDebtAdjustmentDto,
  CreateSupplierDto,
  CreateSupplierPaymentDto,
  ListSuppliersQueryDto,
  ListSupplierLedgerQueryDto,
  SupplierAddressDto,
  SupplierSummaryQueryDto,
  UpdateSupplierDto,
} from './supplier.dto';
import { serializeSupplier } from './supplier.serializer';

// DB ở xa (Supabase qua pooler) + phân bổ thanh toán lặp qua nhiều phiếu nhập
// dễ vượt timeout mặc định 5s của Prisma interactive transaction.
const TX_OPTIONS = { timeout: 15_000, maxWait: 10_000 };

@Injectable()
export class SupplierService {
  constructor(
    private prisma: PrismaService,
    private vouchers: VoucherService,
  ) {}

  async list(query: ListSuppliersQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? 20;
    const where = await this.buildWhere(query);

    const [rows, total] = await Promise.all([
      this.prisma.supplier.findMany({
        where,
        orderBy: { code: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.supplier.count({ where }),
    ]);

    return {
      data: rows.map(serializeSupplier),
      total,
      page,
      page_size: pageSize,
    };
  }

  /** Danh sách công nợ mọi NCC — dùng cho màn Công nợ tổng, không cần chọn NCC trước */
  async listDebts() {
    const [ledgerAgg, outstandingAgg, suppliers] = await Promise.all([
      this.prisma.supplierLedgerEntry.groupBy({
        by: ['supplierId'],
        _sum: { amount: true },
      }),
      this.prisma.goodsReceipt.groupBy({
        by: ['supplierId'],
        where: {
          status: GoodsReceiptStatus.da_nhap,
          paymentStatus: { not: PaymentStatus.da_thanh_toan },
        },
        _count: true,
      }),
      this.prisma.supplier.findMany({
        where: { isActive: true },
        select: { id: true, code: true, name: true },
      }),
    ]);

    const balanceMap = new Map(
      ledgerAgg.map((r) => [r.supplierId.toString(), Number(r._sum.amount ?? 0)]),
    );
    const countMap = new Map(
      outstandingAgg.map((r) => [r.supplierId.toString(), r._count]),
    );

    const rows = suppliers
      .map((s) => {
        const key = s.id.toString();
        return {
          supplier_id: key,
          code: s.code,
          name: s.name,
          debt_balance: (balanceMap.get(key) ?? 0).toString(),
          outstanding_count: countMap.get(key) ?? 0,
        };
      })
      .filter((r) => Number(r.debt_balance) !== 0 || r.outstanding_count > 0)
      .sort((a, b) => Number(a.debt_balance) - Number(b.debt_balance));

    return { data: rows };
  }

  async findOne(id: bigint) {
    const row = await this.prisma.supplier.findUnique({
      where: { id },
      include: { assignedTo: { select: { name: true, email: true } } },
    });
    if (!row) throw new NotFoundException('Không tìm thấy NCC');
    return { data: serializeSupplier(row) };
  }

  async create(dto: CreateSupplierDto) {
    const code = dto.code?.trim() || (await this.generateCode());
    const existing = await this.prisma.supplier.findUnique({ where: { code } });
    if (existing) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        'Mã NCC đã tồn tại',
        422,
        { code: ['Mã NCC đã tồn tại'] },
      );
    }

    const row = await this.prisma.supplier.create({
      data: {
        code,
        name: dto.name.trim(),
        email: dto.email?.trim() || null,
        phone: dto.phone?.trim() || null,
        website: dto.website?.trim() || null,
        fax: dto.fax?.trim() || null,
        taxCode: dto.tax_code?.trim() || null,
        ...this.mapAddress(dto.address),
        assignedToId: dto.assigned_to ? BigInt(dto.assigned_to) : null,
        tags: dto.tags ?? [],
      },
    });

    return { data: serializeSupplier(row) };
  }

  async update(id: bigint, dto: UpdateSupplierDto) {
    await this.findOneOrThrow(id);

    const row = await this.prisma.supplier.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.email !== undefined ? { email: dto.email?.trim() || null } : {}),
        ...(dto.phone !== undefined ? { phone: dto.phone?.trim() || null } : {}),
        ...(dto.website !== undefined ? { website: dto.website?.trim() || null } : {}),
        ...(dto.fax !== undefined ? { fax: dto.fax?.trim() || null } : {}),
        ...(dto.tax_code !== undefined
          ? { taxCode: dto.tax_code?.trim() || null }
          : {}),
        ...(dto.address !== undefined ? this.mapAddress(dto.address) : {}),
        ...(dto.assigned_to !== undefined
          ? {
              assignedToId: dto.assigned_to
                ? BigInt(dto.assigned_to)
                : null,
            }
          : {}),
        ...(dto.tags !== undefined ? { tags: dto.tags } : {}),
        ...(dto.is_active !== undefined ? { isActive: dto.is_active } : {}),
      },
    });

    return { data: serializeSupplier(row) };
  }

  async softDelete(id: bigint) {
    await this.findOneOrThrow(id);
    await this.assertNotInUse(id);

    const row = await this.prisma.supplier.update({
      where: { id },
      data: { isActive: false },
    });

    return { data: serializeSupplier(row) };
  }

  async getSummary(id: bigint, query: SupplierSummaryQueryDto) {
    await this.findOneOrThrow(id);

    const createdAtRange =
      query.date_from || query.date_to
        ? {
            ...(query.date_from ? { gte: new Date(query.date_from) } : {}),
            ...(query.date_to ? { lte: new Date(query.date_to) } : {}),
          }
        : undefined;

    const [
      reiCreated,
      reiUnpaid,
      pvnCreated,
      pvnUnrefunded,
      debtAgg,
    ] = await Promise.all([
      this.prisma.goodsReceipt.aggregate({
        where: {
          supplierId: id,
          status: { not: GoodsReceiptStatus.huy },
          ...(createdAtRange ? { createdAt: createdAtRange } : {}),
        },
        _count: true,
        _sum: { amountDue: true },
      }),
      this.prisma.goodsReceipt.aggregate({
        where: {
          supplierId: id,
          status: GoodsReceiptStatus.da_nhap,
          paymentStatus: { not: PaymentStatus.da_thanh_toan },
          ...(createdAtRange ? { createdAt: createdAtRange } : {}),
        },
        _count: true,
        _sum: { amountDue: true, paidAmount: true },
      }),
      this.prisma.purchaseReturn.aggregate({
        where: {
          supplierId: id,
          ...(createdAtRange ? { createdAt: createdAtRange } : {}),
        },
        _count: true,
        _sum: { totalAmount: true },
      }),
      this.prisma.purchaseReturn.aggregate({
        where: {
          supplierId: id,
          refundStatus: RefundStatus.chua_hoan_tien,
          ...(createdAtRange ? { createdAt: createdAtRange } : {}),
        },
        _count: true,
        _sum: { totalAmount: true },
      }),
      this.prisma.supplierLedgerEntry.aggregate({
        where: { supplierId: id },
        _sum: { amount: true },
      }),
    ]);

    return {
      data: {
        rei_created: {
          count: reiCreated._count,
          amount: (reiCreated._sum.amountDue ?? 0).toString(),
        },
        rei_unpaid: {
          count: reiUnpaid._count,
          amount: (
            Number(reiUnpaid._sum.amountDue ?? 0) -
            Number(reiUnpaid._sum.paidAmount ?? 0)
          ).toString(),
        },
        pvn_created: {
          count: pvnCreated._count,
          amount: (pvnCreated._sum.totalAmount ?? 0).toString(),
        },
        pvn_unrefunded: {
          count: pvnUnrefunded._count,
          amount: (pvnUnrefunded._sum.totalAmount ?? 0).toString(),
        },
        debt_balance: (debtAgg._sum.amount ?? 0).toString(),
      },
    };
  }

  async getLedger(id: bigint, query: ListSupplierLedgerQueryDto) {
    await this.findOneOrThrow(id);
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? 20;

    const createdAtRange =
      query.date_from || query.date_to
        ? {
            ...(query.date_from ? { gte: new Date(query.date_from) } : {}),
            ...(query.date_to ? { lte: new Date(query.date_to) } : {}),
          }
        : undefined;

    const where: Prisma.SupplierLedgerEntryWhereInput = {
      supplierId: id,
      ...(createdAtRange ? { createdAt: createdAtRange } : {}),
      ...(query.reference_type
        ? { referenceType: query.reference_type as SupplierLedgerReferenceType }
        : {}),
      ...(query.q?.trim()
        ? { referenceCode: { contains: query.q.trim(), mode: 'insensitive' } }
        : {}),
    };

    // Tổng hợp kỳ (Nợ đầu kỳ / tăng / giảm) chỉ theo khoảng ngày, không theo q/loại
    const periodWhere: Prisma.SupplierLedgerEntryWhereInput = {
      supplierId: id,
      ...(createdAtRange ? { createdAt: createdAtRange } : {}),
    };

    const [rows, total, totalAgg, openingAgg, decreasedAgg, increasedAgg] =
      await Promise.all([
        this.prisma.supplierLedgerEntry.findMany({
          where,
          include: { createdBy: { select: { name: true, email: true } } },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        this.prisma.supplierLedgerEntry.count({ where }),
        this.prisma.supplierLedgerEntry.aggregate({
          where: { supplierId: id },
          _sum: { amount: true },
        }),
        query.date_from
          ? this.prisma.supplierLedgerEntry.aggregate({
              where: {
                supplierId: id,
                createdAt: { lt: new Date(query.date_from) },
              },
              _sum: { amount: true },
            })
          : Promise.resolve(null),
        this.prisma.supplierLedgerEntry.aggregate({
          where: { ...periodWhere, amount: { gt: 0 } },
          _sum: { amount: true },
        }),
        this.prisma.supplierLedgerEntry.aggregate({
          where: { ...periodWhere, amount: { lt: 0 } },
          _sum: { amount: true },
        }),
      ]);

    // Nợ sau giao dịch: số dư lũy kế trên toàn bộ sổ (không phụ thuộc bộ lọc)
    const balances: number[] = [];
    if (rows.length > 0) {
      const newest = rows[0];
      const newerAgg = await this.prisma.supplierLedgerEntry.aggregate({
        where: {
          supplierId: id,
          OR: [
            { createdAt: { gt: newest.createdAt } },
            { createdAt: newest.createdAt, id: { gt: newest.id } },
          ],
        },
        _sum: { amount: true },
      });
      let running =
        Number(totalAgg._sum.amount ?? 0) - Number(newerAgg._sum.amount ?? 0);
      for (const row of rows) {
        balances.push(running);
        running -= Number(row.amount);
      }
    }

    // Tra id chứng từ theo mã để FE dựng link
    const codes = [
      ...new Set(
        rows
          .map((r) => r.referenceCode)
          .filter((c): c is string => !!c),
      ),
    ];
    const [reis, pvns] = codes.length
      ? await Promise.all([
          this.prisma.goodsReceipt.findMany({
            where: { code: { in: codes } },
            select: { id: true, code: true },
          }),
          this.prisma.purchaseReturn.findMany({
            where: { code: { in: codes } },
            select: { id: true, code: true },
          }),
        ])
      : [[], []];
    const refMap = new Map<string, { kind: string; id: string }>();
    for (const r of reis) {
      refMap.set(r.code, { kind: 'goods_receipt', id: r.id.toString() });
    }
    for (const p of pvns) {
      refMap.set(p.code, { kind: 'purchase_return', id: p.id.toString() });
    }

    const openingBalance = query.date_from
      ? Number(openingAgg?._sum.amount ?? 0)
      : 0;
    const decreased = Number(decreasedAgg._sum.amount ?? 0);
    const increased = Math.abs(Number(increasedAgg._sum.amount ?? 0));

    return {
      data: rows.map((row, i) => {
        const ref = row.referenceCode
          ? refMap.get(row.referenceCode)
          : undefined;
        return {
          ...serializeLedgerEntry(row),
          balance_after: (balances[i] ?? 0).toString(),
          reference_id: ref?.id ?? null,
          reference_kind: ref?.kind ?? null,
        };
      }),
      total,
      page,
      page_size: pageSize,
      summary: {
        opening_balance: openingBalance.toString(),
        debt_decreased: decreased.toString(),
        debt_increased: increased.toString(),
        closing_balance: (openingBalance + decreased - increased).toString(),
      },
    };
  }

  async createDebtAdjustment(
    id: bigint,
    dto: CreateDebtAdjustmentDto,
    user: AuthUser,
  ) {
    await this.findOneOrThrow(id);

    if (!dto.amount) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        'Giá trị điều chỉnh phải khác 0',
        422,
      );
    }

    const entry = await this.prisma.supplierLedgerEntry.create({
      data: {
        supplierId: id,
        referenceType: 'adjustment',
        referenceCode: null,
        transactionLabel: 'Điều chỉnh công nợ',
        reason: dto.reason.trim(),
        amount: dto.amount,
        createdById: user.userId,
      },
      include: { createdBy: { select: { name: true, email: true } } },
    });

    return { data: serializeLedgerEntry(entry) };
  }

  /**
   * Thanh toán đợt — trả dứt điểm 1 nhóm phiếu nhập được chọn cụ thể (tick chọn
   * trên màn Công nợ) trong 1 lần, tạo 1 phiếu chi + 1 dòng sổ công nợ duy nhất.
   */
  async createPayment(
    id: bigint,
    dto: CreateSupplierPaymentDto,
    user: AuthUser,
  ) {
    const supplier = await this.findOneOrThrow(id);

    const branch = await this.prisma.branch.findUnique({
      where: { id: BigInt(dto.branch_id) },
    });
    if (!branch || !branch.isActive) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        'Chi nhánh không hợp lệ',
        422,
      );
    }

    const reiIds = dto.goods_receipt_ids.map((v) => BigInt(v));

    const result = await this.prisma.$transaction(async (tx) => {
      const receipts = await tx.goodsReceipt.findMany({
        where: { id: { in: reiIds } },
      });

      if (receipts.length !== reiIds.length) {
        throw new BusinessException(
          'VALIDATION_ERROR',
          'Có phiếu nhập không tồn tại',
          422,
        );
      }
      for (const rei of receipts) {
        if (rei.supplierId !== id) {
          throw new BusinessException(
            'VALIDATION_ERROR',
            `Phiếu ${rei.code} không thuộc NCC này`,
            422,
          );
        }
        if (rei.status !== GoodsReceiptStatus.da_nhap) {
          throw new BusinessException(
            'INVALID_TRANSITION',
            `Phiếu ${rei.code} chưa ở trạng thái đã nhập`,
            409,
          );
        }
        if (rei.paymentStatus === PaymentStatus.da_thanh_toan) {
          throw new BusinessException(
            'INVALID_TRANSITION',
            `Phiếu ${rei.code} đã thanh toán đủ`,
            409,
          );
        }
      }

      const total = receipts.reduce(
        (sum, rei) => sum + (Number(rei.amountDue) - Number(rei.paidAmount)),
        0,
      );

      for (const rei of receipts) {
        await tx.goodsReceipt.update({
          where: { id: rei.id },
          data: {
            paidAmount: rei.amountDue,
            paymentStatus: PaymentStatus.da_thanh_toan,
          },
        });
      }

      const voucher = await this.vouchers.createPayment(
        {
          branchId: branch.id,
          amount: total,
          createdById: user.userId,
          sourceDocument: supplier.code,
          referenceType: 'supplier_payment',
          referenceId: supplier.id,
          reason:
            dto.note?.trim() ||
            `Thanh toán đợt (${receipts.map((r) => r.code).join(', ')}) — NCC ${supplier.name}`,
        },
        tx,
      );

      const ledgerEntry = await tx.supplierLedgerEntry.create({
        data: {
          supplierId: id,
          referenceType: SupplierLedgerReferenceType.payment,
          referenceCode: voucher.code,
          transactionLabel: 'Thanh toán đợt',
          reason:
            dto.note?.trim() ||
            `Thanh toán đợt: ${receipts.map((r) => r.code).join(', ')}`,
          amount: total,
          createdById: user.userId,
        },
        include: { createdBy: { select: { name: true, email: true } } },
      });

      return { voucher, ledgerEntry };
    }, TX_OPTIONS);

    return {
      data: {
        voucher: result.voucher,
        ledger_entry: serializeLedgerEntry(result.ledgerEntry),
      },
    };
  }

  private async findOneOrThrow(id: bigint) {
    const row = await this.prisma.supplier.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Không tìm thấy NCC');
    return row;
  }

  private async buildWhere(
    query: ListSuppliersQueryDto,
  ): Promise<Prisma.SupplierWhereInput> {
    const where: Prisma.SupplierWhereInput = {};

    if (query.is_active !== undefined) {
      where.isActive = query.is_active;
    } else {
      where.isActive = true;
    }

    if (query.q?.trim()) {
      const ids = await findSupplierIdsByQuery(this.prisma, query.q.trim());
      where.id = { in: ids };
    }

    return where;
  }

  private mapAddress(address?: SupplierAddressDto) {
    return {
      country: address?.country?.trim() || null,
      province: address?.province?.trim() || null,
      district: address?.district?.trim() || null,
      ward: address?.ward?.trim() || null,
      address: address?.address?.trim() || null,
    };
  }

  private async generateCode() {
    const latest = await this.prisma.supplier.findFirst({
      orderBy: { id: 'desc' },
      select: { id: true },
    });
    const next = (latest?.id ?? 0n) + 1n;
    return `NCC${String(next).padStart(4, '0')}`;
  }

  /** Kiểm tra PO/REI mở */
  private async assertNotInUse(supplierId: bigint) {
    const [openPo, openRei] = await Promise.all([
      this.prisma.purchaseOrder.count({
        where: {
          supplierId,
          status: { in: ['don_nhap', 'cho_nhap'] },
        },
      }),
      this.prisma.goodsReceipt.count({
        where: {
          supplierId,
          status: 'chua_nhap',
        },
      }),
    ]);

    if (openPo > 0 || openRei > 0) {
      throw new BusinessException(
        'SUPPLIER_IN_USE',
        'NCC còn chứng từ mở (PO hoặc phiếu nhập)',
        409,
      );
    }
  }
}
