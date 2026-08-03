require('dotenv').config({ quiet: true });
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const x=(s)=>prisma.$executeRawUnsafe(s);
const q=(s)=>prisma.$queryRawUnsafe(s);
const STAMP = '20260801';
(async () => {
  // 1) Backup cột orders sắp bị drop (chỉ các cột, kèm id để khôi phục được)
  console.log('Backup cột cũ của orders...');
  await x(`DROP TABLE IF EXISTS "zz_backup_orders_oldcols_${STAMP}"`);
  await x(`CREATE TABLE "zz_backup_orders_oldcols_${STAMP}" AS
    SELECT id, sapo_id, code, branch_id, ordered_at, created_at, updated_at,
           payment_status, total_amount, subtotal, discount_total, tax_total,
           shipping_fee, paid_amount, total_quantity, shipped_at,
           expected_delivery_at, assigned_to, created_by, source
    FROM orders`);
  console.log('  ->', (await q(`SELECT count(*)::int c FROM "zz_backup_orders_oldcols_${STAMP}"`))[0].c, 'dòng');

  // 2) Backup các bảng sắp DROP mà CÓ dữ liệu
  for (const t of ['branches','warehouses','user_warehouses','user_warehouse_roles',
                   'sapo_orders','sapo_customers','sapo_order_line_items',
                   'sapo_catalog_variants','cskh_page_message_totals']) {
    const n = (await q(`SELECT count(*)::int c FROM "${t}"`))[0].c;
    if (n === 0) { console.log(`  bỏ qua ${t} (0 dòng)`); continue; }
    await x(`DROP TABLE IF EXISTS "zz_backup_${t}_${STAMP}"`);
    await x(`CREATE TABLE "zz_backup_${t}_${STAMP}" AS SELECT * FROM "${t}"`);
    console.log(`  backup ${t}: ${n} dòng`);
  }

  // 3) Backup permissions (sắp đổi scope)
  await x(`DROP TABLE IF EXISTS "zz_backup_permissions_${STAMP}"`);
  await x(`CREATE TABLE "zz_backup_permissions_${STAMP}" AS SELECT * FROM permissions`);
  console.log('  backup permissions:', (await q(`SELECT count(*)::int c FROM "zz_backup_permissions_${STAMP}"`))[0].c, 'dòng');

  console.log('\n=== Danh sách bảng backup ===');
  console.log((await q(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'zz_backup_%' ORDER BY table_name`)).map(r=>r.table_name).join('\n'));
})().catch(e=>{console.error('ERR', e.message.slice(0,400)); process.exit(1);}).finally(()=>prisma.$disconnect());
