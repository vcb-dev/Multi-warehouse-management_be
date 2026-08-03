require('dotenv').config({ quiet: true });
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const q = (sql) => prisma.$queryRawUnsafe(sql);
(async () => {
  console.log('=== A. user_warehouse_roles (112) vs user_location_roles (27) ===');
  console.log('cột uwr:', (await q(`SELECT column_name FROM information_schema.columns WHERE table_name='user_warehouse_roles' ORDER BY ordinal_position`)).map(c=>c.column_name).join(', '));
  const overlap = await q(`
    SELECT
      (SELECT count(*)::int FROM user_warehouse_roles) AS uwr_total,
      (SELECT count(*)::int FROM user_location_roles) AS ulr_total,
      (SELECT count(*)::int FROM user_warehouse_roles u
         WHERE NOT EXISTS (SELECT 1 FROM user_location_roles l
           WHERE l.user_id=u.user_id AND l.location_id=u.warehouse_id)) AS uwr_khong_co_trong_ulr`);
  console.log(overlap[0]);
  console.log('uwr theo user:', await q(`SELECT user_id, count(*)::int c FROM user_warehouse_roles GROUP BY user_id ORDER BY c DESC LIMIT 5`));

  console.log('\n=== B. warehouses(68) vs locations(16) ===');
  const wh = await q(`SELECT count(*)::int total, count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM locations l WHERE l.id=w.id))::int khong_co_trong_locations FROM warehouses w`);
  console.log(wh[0]);

  console.log('\n=== C. 18 cột cũ trên orders — còn dữ liệu KHÔNG có ở cột mới? ===');
  const cols = await q(`
    SELECT
      count(*) FILTER (WHERE code IS NOT NULL AND code <> name)::int AS code_khac_name,
      count(*) FILTER (WHERE total_amount IS NOT NULL AND total_amount <> total_price)::int AS total_amount_khac,
      count(*) FILTER (WHERE ordered_at IS NOT NULL AND ordered_at <> created_on)::int AS ordered_at_khac,
      count(*) FILTER (WHERE branch_id IS NOT NULL AND branch_id <> location_id)::int AS branch_khac_location,
      count(*) FILTER (WHERE shipped_at IS NOT NULL)::int AS shipped_at_co_data,
      count(*) FILTER (WHERE payment_status IS NOT NULL)::int AS payment_status_co_data,
      count(*) FILTER (WHERE assigned_to IS NOT NULL)::int AS assigned_to_co_data,
      count(*) FILTER (WHERE created_by IS NOT NULL)::int AS created_by_co_data,
      count(*)::int AS tong_don
    FROM orders`);
  console.log(cols[0]);

  console.log('\n=== D. Bảng sapo_* staging — có phải nguồn ETL đang dùng? ===');
  for (const t of ['sapo_orders','sapo_customers','sapo_order_line_items','sapo_catalog_variants']) {
    const r = await q(`SELECT count(*)::int c FROM "${t}"`);
    console.log(`  ${t}: ${r[0].c} dòng`);
  }
  console.log('  orders có sapo_id:', (await q(`SELECT count(*)::int c FROM orders WHERE sapo_id IS NOT NULL`))[0].c);
})().catch(e=>console.error('ERR', e.message.slice(0,300))).finally(()=>prisma.$disconnect());
