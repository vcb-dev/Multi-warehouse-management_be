/**
 * Sửa 4 lỗi chặn trên DB (đã dry-run trong transaction rollback, kết quả sạch).
 * Backup đã tạo sẵn ở các bảng zz_backup_*_20260801.
 *
 * 1) permissions.scope 'warehouse' -> 'location'  (15 dòng)  — lỗi làm mọi
 *    request đăng nhập 500 vì Prisma không đọc nổi enum PermissionScope
 * 2) permissions.scope text -> enum PermissionScope
 * 3) orders.created_on := ordered_at (87.893 dòng) — sửa lệch +7h so với Sapo
 * 4) orders.status text -> enum OrderStatus, và CREATE EXTENSION unaccent
 */
require('dotenv').config({ quiet: true });
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  console.log('=== ÁP THẬT ===');
  await prisma.$transaction(
    async (tx) => {
      const r1 = await tx.$executeRawUnsafe(
        `UPDATE permissions SET scope='location' WHERE scope='warehouse'`,
      );
      console.log(`  permissions.scope 'warehouse'->'location': ${r1} dòng`);

      await tx.$executeRawUnsafe(
        `ALTER TABLE permissions ALTER COLUMN scope TYPE "PermissionScope" USING scope::"PermissionScope"`,
      );
      console.log('  permissions.scope -> enum: OK');

      const r2 = await tx.$executeRawUnsafe(
        `UPDATE orders SET created_on = ordered_at WHERE ordered_at IS NOT NULL AND created_on <> ordered_at`,
      );
      console.log(`  orders.created_on sửa lệch +7h: ${r2} dòng`);

      await tx.$executeRawUnsafe(
        `ALTER TABLE orders ALTER COLUMN status TYPE "OrderStatus" USING status::"OrderStatus"`,
      );
      console.log('  orders.status -> enum: OK');
    },
    { timeout: 180000, maxWait: 30000 },
  );

  // CREATE EXTENSION không chạy trong interactive transaction của Prisma
  try {
    await prisma.$executeRawUnsafe(
      `CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA extensions`,
    );
    console.log('  CREATE EXTENSION unaccent (schema extensions): OK');
  } catch {
    await prisma.$executeRawUnsafe(`CREATE EXTENSION IF NOT EXISTS unaccent`);
    console.log('  CREATE EXTENSION unaccent (schema mặc định): OK');
  }

  console.log('\n=== KIỂM CHỨNG SAU KHI ÁP ===');
  const all = await prisma.permission.findMany();
  console.log('  prisma.permission.findMany():', all.length, 'dòng');

  const o = await prisma.order.findFirst({ where: { status: 'open' } });
  console.log('  prisma.order.findFirst({status:open}):', o ? o.name : 'không có');

  const u = await prisma.userLocationRole.findMany({
    where: { userId: 9n },
    include: { role: { include: { permissions: { include: { permission: true } } } } },
  });
  console.log('  resolvePermissions-style cho user 9:', u.length, 'assignment');

  const un = await prisma.$queryRawUnsafe(`SELECT unaccent('Áo thun') AS v`);
  console.log('  unaccent():', un[0].v);

  const lech = await prisma.$queryRawUnsafe(
    `SELECT count(*)::int c FROM orders WHERE ordered_at IS NOT NULL AND created_on <> ordered_at`,
  );
  console.log('  đơn còn lệch giờ:', lech[0].c);
})()
  .catch((e) => {
    console.error('LỖI:', e.message.slice(0, 600));
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
