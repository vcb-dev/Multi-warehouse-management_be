import { Injectable, NotFoundException } from '@nestjs/common';
import { GoodsReceiptStatus, PaymentStatus, Prisma, RefundStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { BusinessException } from '../../common/exceptions/business.exception';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { serializeLedgerEntry } from '../purchasing/purchasing.serializer';
import {
  CreateDebtAdjustmentDto,
  CreateSupplierDto,
  ListSuppliersQueryDto,
  ListSupplierLedgerQueryDto,
  SupplierAddressDto,
  SupplierSummaryQueryDto,
  UpdateSupplierDto,
} from './supplier.dto';
import { serializeSupplier } from './supplier.serializer';

@Injectable()
export class SupplierService {
  constructor(private prisma: PrismaService) {}

  async list(query: ListSuppliersQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? 20;
    const where = this.buildWhere(query);

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

    const [rows, total] = await Promise.all([
      this.prisma.supplierLedgerEntry.findMany({
        where: { supplierId: id },
        include: { createdBy: { select: { name: true, email: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.supplierLedgerEntry.count({ where: { supplierId: id } }),
    ]);

    return {
      data: rows.map(serializeLedgerEntry),
      total,
      page,
      page_size: pageSize,
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

  private async findOneOrThrow(id: bigint) {
    const row = await this.prisma.supplier.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Không tìm thấy NCC');
    return row;
  }

  private buildWhere(query: ListSuppliersQueryDto): Prisma.SupplierWhereInput {
    const where: Prisma.SupplierWhereInput = {};

    if (query.is_active !== undefined) {
      where.isActive = query.is_active;
    } else {
      where.isActive = true;
    }

    if (query.q?.trim()) {
      const q = query.q.trim();
      where.OR = [
        { code: { contains: q, mode: 'insensitive' } },
        { name: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
        { phone: { contains: q, mode: 'insensitive' } },
        { taxCode: { contains: q, mode: 'insensitive' } },
      ];
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
