import { Prisma } from '@prisma/client';

/** Sinh mã fulfillment dạng `${orderCode}-F${n}` — gọi bên trong transaction. */
export async function generateFulfillmentCode(
  tx: Prisma.TransactionClient,
  orderId: bigint,
  orderCode: string,
): Promise<string> {
  const count = await tx.fulfillment.count({ where: { orderId } });
  return `${orderCode}-F${count + 1}`;
}
