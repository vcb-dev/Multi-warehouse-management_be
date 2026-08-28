import { Prisma } from '@prisma/client';
import { Db, nextSequentialCode } from '../../common/db/sequential-code';

/**
 * Sinh mã đơn theo tiền tố chi nhánh (O-3). PHẢI gọi bên trong transaction — xem
 * {@link nextSequentialCode} về lý do.
 */
export async function generateOrderCode(
  prisma: Db,
  locationId: bigint,
): Promise<string> {
  const branch = await prisma.location.findUniqueOrThrow({
    where: { id: locationId },
  });
  const prefix = (branch.code ?? branch.name)
    .replace(/[^A-Z0-9]/gi, '')
    .toUpperCase()
    .slice(0, 6);
  return nextSequentialCode(prisma, {
    table: Prisma.sql`orders`,
    column: Prisma.sql`name`,
    prefix,
  });
}

export async function generateDraftCode(prisma: Db): Promise<string> {
  // Giữ nguyên tiền tố `#D` của dữ liệu cũ. `#` là ký tự thường trong regex Postgres
  // nên nhúng thẳng vào `^#D[0-9]{6}$` là an toàn.
  return nextSequentialCode(prisma, {
    table: Prisma.sql`draft_orders`,
    column: Prisma.sql`code`,
    prefix: '#D',
  });
}

export async function generateReturnCode(prisma: Db): Promise<string> {
  return nextSequentialCode(prisma, {
    table: Prisma.sql`order_returns`,
    column: Prisma.sql`code`,
    prefix: 'RTN',
  });
}
