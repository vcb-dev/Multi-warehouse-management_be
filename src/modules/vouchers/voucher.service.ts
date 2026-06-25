import { Injectable } from '@nestjs/common';
import { Prisma, VoucherType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { generateVoucherCode } from './voucher-code';
import { ListVouchersQueryDto } from './voucher.dto';

export type CreatePaymentVoucherInput = {
  branchId: bigint;
  amount: number;
  createdById: bigint;
  sourceDocument: string;
  referenceType: string;
  referenceId: bigint;
  reason?: string;
};

@Injectable()
export class VoucherService {
  constructor(private prisma: PrismaService) {}

  async createPayment(
    input: CreatePaymentVoucherInput,
    tx?: Prisma.TransactionClient,
  ) {
    const client = tx ?? this.prisma;
    const code = await generateVoucherCode(client, VoucherType.payment);

    const row = await client.voucher.create({
      data: {
        code,
        type: VoucherType.payment,
        amountOut: input.amount,
        branchId: input.branchId,
        createdById: input.createdById,
        sourceDocument: input.sourceDocument,
        referenceType: input.referenceType,
        referenceId: input.referenceId,
        reason: input.reason?.trim() || null,
      },
    });

    return {
      id: row.id.toString(),
      code: row.code,
      amount_out: Number(row.amountOut),
    };
  }

  async list(query: ListVouchersQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? 20;
    const where: Prisma.VoucherWhereInput = {};

    if (query.type) where.type = query.type as VoucherType;
    if (query.branch_id) where.branchId = BigInt(query.branch_id);
    if (query.q?.trim()) {
      where.OR = [
        { code: { contains: query.q.trim(), mode: 'insensitive' } },
        { sourceDocument: { contains: query.q.trim(), mode: 'insensitive' } },
      ];
    }

    const [rows, total] = await Promise.all([
      this.prisma.voucher.findMany({
        where,
        orderBy: { recordedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          branch: { select: { name: true } },
          createdBy: { select: { name: true, email: true } },
        },
      }),
      this.prisma.voucher.count({ where }),
    ]);

    return {
      data: rows.map((v) => ({
        id: v.id.toString(),
        code: v.code,
        type: v.type,
        amount_in: Number(v.amountIn),
        amount_out: Number(v.amountOut),
        branch_id: v.branchId.toString(),
        branch_name: v.branch.name,
        source_document: v.sourceDocument,
        reference_type: v.referenceType,
        reference_id: v.referenceId?.toString() ?? null,
        reason: v.reason,
        created_by_name: v.createdBy.name ?? v.createdBy.email,
        recorded_at: v.recordedAt.toISOString(),
      })),
      total,
      page,
      page_size: pageSize,
    };
  }
}
