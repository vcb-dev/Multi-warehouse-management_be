require('dotenv').config({ quiet: true });
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  console.log('=== DRY RUN (sẽ ROLLBACK, không ghi thật) ===');
  try {
    await prisma.$transaction(async (tx) => {
      const r1 = await tx.$executeRawUnsafe(`UPDATE permissions SET scope='location' WHERE scope='warehouse'`);
      console.log(`  permissions.scope 'warehouse'->'location': ${r1} dòng`);

      await tx.$executeRawUnsafe(`ALTER TABLE permissions ALTER COLUMN scope TYPE "PermissionScope" USING scope::"PermissionScope"`);
      console.log('  permissions.scope -> enum PermissionScope: OK');

      const r2 = await tx.$executeRawUnsafe(`UPDATE orders SET created_on = ordered_at WHERE ordered_at IS NOT NULL AND created_on <> ordered_at`);
      console.log(`  orders.created_on := ordered_at (sửa lệch +7h): ${r2} dòng`);

      await tx.$executeRawUnsafe(`ALTER TABLE orders ALTER COLUMN status TYPE "OrderStatus" USING status::"OrderStatus"`);
      console.log('  orders.status -> enum OrderStatus: OK');

      const chk = await tx.$queryRawUnsafe(`SELECT status, count(*)::int c FROM orders GROUP BY status ORDER BY c DESC`);
      console.log('  kiểm tra status sau cast:', JSON.stringify(chk));
      const chk2 = await tx.$queryRawUnsafe(`SELECT scope, count(*)::int c FROM permissions GROUP BY scope`);
      console.log('  kiểm tra scope sau cast:', JSON.stringify(chk2));
      const chk3 = await tx.$queryRawUnsafe(`SELECT count(*)::int c FROM orders WHERE ordered_at IS NOT NULL AND created_on <> ordered_at`);
      console.log('  còn đơn lệch giờ:', chk3[0].c);

      throw new Error('__ROLLBACK__');
    }, { timeout: 180000, maxWait: 30000 });
  } catch (e) {
    if (e.message.includes('__ROLLBACK__')) console.log('\n✅ Dry run thành công — đã rollback, DB chưa đổi.');
    else console.error('❌ LỖI THẬT:', e.message.slice(0, 500));
  }
})().finally(()=>prisma.$disconnect());
