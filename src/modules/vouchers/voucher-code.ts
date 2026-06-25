import { Prisma, VoucherType } from '@prisma/client';

type PrismaTx = Prisma.TransactionClient | Prisma.DefaultPrismaClient;

export async function generateVoucherCode(
  prisma: PrismaTx,
  type: VoucherType,
): Promise<string> {
  const prefix = type === VoucherType.payment ? 'PVN' : 'RVN';
  const count = await prisma.voucher.count({
    where: { type, code: { startsWith: prefix } },
  });
  return `${prefix}${String(count + 1).padStart(6, '0')}`;
}
