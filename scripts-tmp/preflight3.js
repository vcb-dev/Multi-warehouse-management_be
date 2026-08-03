require('dotenv').config({ quiet: true });
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const q=(s)=>prisma.$queryRawUnsafe(s);
(async () => {
  console.log('=== Phân bố chênh lệch created_on - ordered_at (giờ) ===');
  console.log(await q(`
    SELECT EXTRACT(EPOCH FROM (created_on - ordered_at))/3600 AS lech_gio, count(*)::int AS so_don
    FROM orders WHERE ordered_at IS NOT NULL AND created_on IS NOT NULL
    GROUP BY 1 ORDER BY so_don DESC LIMIT 8`));

  console.log('\n=== branch_id vs location_id: phân bố ===');
  console.log(await q(`
    SELECT branch_id, location_id, count(*)::int c FROM orders
    GROUP BY 1,2 ORDER BY c DESC LIMIT 8`));

  console.log('\n=== locations: id ⇄ sapo_id ===');
  console.log(await q(`SELECT id, sapo_id, code, name FROM locations ORDER BY id LIMIT 20`));

  console.log('\n=== code có luôn = "SAPO-"+sapo_id không? ===');
  console.log(await q(`
    SELECT count(*) FILTER (WHERE code = 'SAPO-' || sapo_id::text)::int AS khop_mau,
           count(*) FILTER (WHERE code IS NOT NULL AND code <> 'SAPO-' || sapo_id::text)::int AS khac_mau,
           count(*)::int AS tong
    FROM orders WHERE sapo_id IS NOT NULL`));
})().catch(e=>console.error('ERR',e.message.slice(0,300))).finally(()=>prisma.$disconnect());
