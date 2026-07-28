import { Injectable, NotFoundException } from '@nestjs/common';
import { CustomerLedgerReferenceType, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { BusinessException } from '../../common/exceptions/business.exception';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { userDisplayName } from '../../common/utils/user-display-name';
import {
  CreateCustomerDebtAdjustmentDto,
  ListCustomerLedgerQueryDto,
} from './order.dto';

export type CustomerLedgerInput = {
  customerId: bigint;
  referenceType: CustomerLedgerReferenceType;
  referenceCode?: string | null;
  transactionLabel: string;
  reason?: string | null;
  amount: number;
  createdById: bigint;
};

type LedgerEntryWithCreator = Prisma.CustomerLedgerEntryGetPayload<{
  include: { createdBy: { select: { firstName: true; lastName: true; email: true } } };
}>;

function serializeEntry(entry: LedgerEntryWithCreator) {
  return {
    id: entry.id.toString(),
    customer_id: entry.customerId.toString(),
    reference_type: entry.referenceType,
    reference_code: entry.referenceCode,
    transaction_label: entry.transactionLabel,
    reason: entry.reason,
    amount: entry.amount.toString(),
    created_by_name: userDisplayName(entry.createdBy) ?? entry.createdBy?.email ?? null,
    created_at: entry.createdAt.toISOString(),
  };
}

/** Sổ công nợ khách hàng — amount: dương = tăng nợ phải thu, âm = giảm nợ phải thu */
@Injectable()
export class CustomerDebtService {
  constructor(private prisma: PrismaService) {}

  /** Một điểm vào duy nhất ghi sổ công nợ KH */
  recordEntry(input: CustomerLedgerInput, tx?: Prisma.TransactionClient) {
    const client = tx ?? this.prisma;
    return client.customerLedgerEntry.create({
      data: {
        customerId: input.customerId,
        referenceType: input.referenceType,
        referenceCode: input.referenceCode ?? null,
        transactionLabel: input.transactionLabel,
        reason: input.reason ?? null,
        amount: input.amount,
        createdById: input.createdById,
      },
    });
  }

  async getLedger(customerId: bigint, query: ListCustomerLedgerQueryDto) {
    await this.findCustomerOrThrow(customerId);
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? 20;

    const [rows, total, balanceAgg] = await Promise.all([
      this.prisma.customerLedgerEntry.findMany({
        where: { customerId },
        include: { createdBy: { select: { firstName: true, lastName: true, email: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.customerLedgerEntry.count({ where: { customerId } }),
      this.prisma.customerLedgerEntry.aggregate({
        where: { customerId },
        _sum: { amount: true },
      }),
    ]);

    return {
      data: rows.map(serializeEntry),
      debt_balance: (balanceAgg._sum.amount ?? 0).toString(),
      total,
      page,
      page_size: pageSize,
    };
  }

  async createAdjustment(
    customerId: bigint,
    dto: CreateCustomerDebtAdjustmentDto,
    user: AuthUser,
  ) {
    await this.findCustomerOrThrow(customerId);

    if (!dto.amount) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        'Giá trị điều chỉnh phải khác 0',
        422,
      );
    }

    const entry = await this.prisma.customerLedgerEntry.create({
      data: {
        customerId,
        referenceType: CustomerLedgerReferenceType.adjustment,
        referenceCode: null,
        transactionLabel: 'Điều chỉnh công nợ',
        reason: dto.reason.trim(),
        amount: dto.amount,
        createdById: user.userId,
      },
      include: { createdBy: { select: { firstName: true, lastName: true, email: true } } },
    });

    return { data: serializeEntry(entry) };
  }

  private async findCustomerOrThrow(id: bigint) {
    const row = await this.prisma.customer.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Không tìm thấy khách hàng');
    return row;
  }
}
