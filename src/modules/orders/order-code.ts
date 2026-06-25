import { PrismaClient } from '@prisma/client';

/** Sinh mã đơn theo tiền tố chi nhánh (O-3) */
export async function generateOrderCode(
  prisma: PrismaClient | Parameters<Parameters<PrismaClient['$transaction']>[0]>[0],
  branchId: bigint,
): Promise<string> {
  const branch = await prisma.branch.findUniqueOrThrow({
    where: { id: branchId },
  });
  const prefix = branch.code.replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 6);
  const count = await prisma.order.count({ where: { branchId } });
  return `${prefix}${String(count + 1).padStart(6, '0')}`;
}

export async function generateDraftCode(
  prisma: PrismaClient | Parameters<Parameters<PrismaClient['$transaction']>[0]>[0],
): Promise<string> {
  const count = await prisma.draftOrder.count();
  return `#D${String(count + 1).padStart(6, '0')}`;
}

export async function generateReturnCode(
  prisma: PrismaClient | Parameters<Parameters<PrismaClient['$transaction']>[0]>[0],
): Promise<string> {
  const count = await prisma.orderReturn.count();
  return `RTN${String(count + 1).padStart(6, '0')}`;
}
