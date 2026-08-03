require('dotenv').config({ quiet: true });
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const STORE = process.env.SAPO_STORE;
const AUTH = Buffer.from(`${process.env.SAPO_API_KEY}:${process.env.SAPO_API_SECRET}`).toString('base64');
async function api(p){const r=await fetch(`https://${STORE}.mysapo.net${p}`,{headers:{Authorization:`Basic ${AUTH}`}});return r.ok?r.json():null;}
const q=(s)=>prisma.$queryRawUnsafe(s);
(async () => {
  const rows = await q(`
    SELECT sapo_id, code, name, ordered_at, created_on, branch_id, location_id,
           payment_status, financial_status, total_amount, total_price, created_by, user_id
    FROM orders WHERE sapo_id IS NOT NULL ORDER BY random() LIMIT 5`);
  for (const o of rows) {
    const j = await api(`/admin/orders/${o.sapo_id}.json`);
    if (!j?.order) continue;
    const s = j.order;
    console.log(`\n--- ${o.name} (sapo_id=${o.sapo_id}) ---`);
    console.log(`  code(cũ)="${o.code}"  name(mới)="${o.name}"  | Sapo.name="${s.name}"`);
    console.log(`  ordered_at(cũ)=${o.ordered_at?.toISOString?.()}  created_on(mới)=${o.created_on?.toISOString?.()}  | Sapo.created_on=${s.created_on}`);
    console.log(`  branch_id(cũ)=${o.branch_id}  location_id(mới)=${o.location_id}  | Sapo.location_id=${s.location_id}`);
    console.log(`  payment_status(cũ)=${o.payment_status}  financial_status(mới)=${o.financial_status}  | Sapo.financial_status=${s.financial_status}`);
    console.log(`  total_amount(cũ)=${o.total_amount}  total_price(mới)=${o.total_price}  | Sapo.total_price=${s.total_price}`);
  }
})().catch(e=>console.error('ERR',e.message.slice(0,300))).finally(()=>prisma.$disconnect());
