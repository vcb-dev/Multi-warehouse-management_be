/**
 * Kéo `location_id` thật của từng đơn từ Sapo về file JSONL, để backfill
 * `orders.location_id` (dữ liệu cũ chỉ có branch_id 1/2 là seed giả).
 *
 * Chạy:  set -a && . ./.env && set +a && node scripts-tmp/fetch-order-locations.js
 *
 * Đặc điểm bắt buộc (theo các lỗi đã gặp với Sapo API, ghi ở docs/sapo-schema-mapping.md):
 *  - KHÔNG dùng `status=any` — Sapo trả 0 đơn im lặng (không phải lỗi Shopify-style).
 *  - `page * limit <= 30000` ⇒ phân trang theo cửa sổ THÁNG.
 *  - Response ~2 MB/250 đơn ⇒ chỉ giữ {id, location_id}, không in ra.
 *  - Kết nối rớt giữa chừng (HTTP status 0) ⇒ retry + ghi JSONL từng trang để chạy lại được.
 */
const fs = require('fs');
const path = require('path');

const STORE = process.env.SAPO_STORE;
const AUTH = Buffer.from(
  `${process.env.SAPO_API_KEY}:${process.env.SAPO_API_SECRET}`,
).toString('base64');

const OUT = path.join(__dirname, 'order-locations.jsonl');
const DONE = path.join(__dirname, 'order-locations.windows.json');

const LIMIT = 250;
const FROM = '2025-09-01';
const TO = '2026-08-01';

async function api(qs, tries = 6) {
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(`https://${STORE}.mysapo.net/admin/orders.json?${qs}`, {
        headers: { Authorization: `Basic ${AUTH}` },
        signal: AbortSignal.timeout(120000),
      });
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, 3000 * i));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (i === tries) throw e;
      await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
}

function months(from, to) {
  const out = [];
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (d < end) {
    const next = new Date(d);
    next.setUTCMonth(next.getUTCMonth() + 1);
    out.push([d.toISOString().slice(0, 10), next.toISOString().slice(0, 10)]);
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return out;
}

async function main() {
  const doneWindows = fs.existsSync(DONE)
    ? new Set(JSON.parse(fs.readFileSync(DONE, 'utf8')))
    : new Set();
  const out = fs.createWriteStream(OUT, { flags: 'a' });

  let total = 0;
  for (const [min, max] of months(FROM, TO)) {
    const key = `${min}..${max}`;
    if (doneWindows.has(key)) {
      console.log(`  ⏭  ${key} (đã xong)`);
      continue;
    }
    let page = 1;
    let inWindow = 0;
    for (;;) {
      const qs = `limit=${LIMIT}&page=${page}&created_on_min=${min}&created_on_max=${max}`;
      const { orders = [] } = await api(qs);
      if (!orders.length) break;
      for (const o of orders) {
        if (o.id == null) continue;
        out.write(JSON.stringify({ id: o.id, location_id: o.location_id ?? null }) + '\n');
        inWindow++;
      }
      if (orders.length < LIMIT) break;
      page++;
      if (page * LIMIT > 30000) {
        console.warn(`  ⚠ ${key} vượt trần 30000, cần chia nhỏ cửa sổ hơn`);
        break;
      }
    }
    total += inWindow;
    doneWindows.add(key);
    fs.writeFileSync(DONE, JSON.stringify([...doneWindows], null, 0));
    console.log(`  ✓ ${key}: ${inWindow} đơn (cộng dồn ${total})`);
  }

  out.end();
  console.log(`\nXong. Ghi vào ${OUT}`);
}

main().catch((e) => {
  console.error('LỖI:', e.message);
  process.exitCode = 1;
});
