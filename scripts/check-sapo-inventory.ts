#!/usr/bin/env ts-node
/**
 * Đối chiếu tồn kho giữa Sapo và DB — CHỈ ĐỌC, không ghi một dòng nào.
 *
 * Chạy: npx ts-node --compiler-options '{"module":"CommonJS"}' scripts/check-sapo-inventory.ts
 *
 * Cặp với `SapoInventorySyncService`: service kia GHI đè tồn theo Sapo, script này chỉ đếm
 * xem đang lệch bao nhiêu và ở đâu — để biết trước lượt đồng bộ sẽ đụng vào những gì.
 *
 * So đúng 5 bucket có sổ cái (on_hand, committed, packed, unavailable, incoming); `available`
 * không so vì đó là số dự án TỰ TÍNH theo công thức nội bộ, không lấy của Sapo.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';

/** Xem chú thích trong `check-sapo-locations.ts`: `dotenv` không phải dependency của dự án. */
function loadEnv() {
  try {
    const raw = readFileSync(join(__dirname, '..', '.env'), 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (!m || process.env[m[1]]) continue;
      process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  } catch {
    // Trên server biến nằm sẵn trong môi trường.
  }
}
loadEnv();

const prisma = new PrismaClient();
const STORE = process.env.SAPO_STORE;
const AUTH = Buffer.from(
  `${process.env.SAPO_API_KEY}:${process.env.SAPO_API_SECRET}`,
).toString('base64');

const BATCH_SIZE = 40;
const PAGE_LIMIT = 250;
const BUCKETS = [
  ['onHand', 'on_hand'],
  ['committed', 'committed'],
  ['packed', 'packed'],
  ['unavailable', 'unavailable'],
  ['incoming', 'incoming'],
] as const;

type SapoLevel = Record<string, number | string | null | undefined>;

let lastRateLimit: string | null = null;

async function api<T>(path: string, tries = 5): Promise<T> {
  for (let i = 1; i <= tries; i++) {
    const res = await fetch(`https://${STORE}.mysapo.net${path}`, {
      headers: { Authorization: `Basic ${AUTH}` },
    });
    lastRateLimit = res.headers.get('x-sapo-api-call-limit');
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 2000 * i));
      continue;
    }
    if (!res.ok) {
      if (i === tries) throw new Error(`Sapo HTTP ${res.status} — ${path}`);
      await new Promise((r) => setTimeout(r, 800 * i));
      continue;
    }
    return (await res.json()) as T;
  }
  throw new Error(`Không gọi được sau ${tries} lần: ${path}`);
}

async function throttle() {
  if (!lastRateLimit) return new Promise((r) => setTimeout(r, 250));
  const [used, total] = lastRateLimit.split('/').map(Number);
  const ratio = total ? used / total : 0;
  return new Promise((r) =>
    setTimeout(r, ratio > 0.75 ? 1200 : ratio > 0.5 ? 500 : 250),
  );
}

const n = (v: unknown) => Math.round(Number(v ?? 0));

async function main() {
  if (!STORE || !process.env.SAPO_API_KEY || !process.env.SAPO_API_SECRET) {
    console.error('Thiếu SAPO_STORE / SAPO_API_KEY / SAPO_API_SECRET.');
    process.exit(1);
  }

  const [locations, variants, levels] = await Promise.all([
    prisma.location.findMany({
      where: { sapoId: { not: null } },
      select: { id: true, sapoId: true, name: true },
    }),
    prisma.productVariant.findMany({
      where: { inventoryItemId: { not: null } },
      select: { id: true, sku: true, inventoryItemId: true },
    }),
    prisma.inventoryLevel.findMany(),
  ]);

  const locBySapo = new Map(locations.map((l) => [String(l.sapoId), l]));
  const varByItem = new Map(
    variants.map((v) => [String(v.inventoryItemId), v]),
  );
  const levelByKey = new Map(
    levels.map((l) => [`${l.variantId}:${l.locationId}`, l]),
  );

  console.log(
    `DB: ${variants.length} phiên bản có inventory_item_id, ${locations.length} kho, ${levels.length} dòng tồn.\n` +
      `Đang hỏi Sapo (${Math.ceil(variants.length / BATCH_SIZE)} lượt)...`,
  );

  /** Thống kê theo kho: số dòng lệch + tổng chênh on_hand. */
  const perLoc = new Map<
    string,
    { lech: number; quet: number; chenhOnHand: number; thieuDong: number }
  >();
  const bucketLech: Record<string, number> = {};
  const viDu: string[] = [];
  let scanned = 0;
  let khongKhopItem = 0;
  let khongKhopKho = 0;

  const itemIds = [...varByItem.keys()];
  for (let i = 0; i < itemIds.length; i += BATCH_SIZE) {
    const ids = itemIds.slice(i, i + BATCH_SIZE);
    for (let page = 1; ; page++) {
      const body = await api<{ inventory_levels?: SapoLevel[] }>(
        `/admin/inventory_levels.json?inventory_item_ids=${ids.join(',')}&limit=${PAGE_LIMIT}&page=${page}`,
      );
      const rows = body.inventory_levels ?? [];

      for (const row of rows) {
        const variant = varByItem.get(String(row.inventory_item_id));
        if (!variant) {
          khongKhopItem += 1;
          continue;
        }
        const loc = locBySapo.get(String(row.location_id));
        if (!loc) {
          khongKhopKho += 1;
          continue;
        }
        scanned += 1;

        const stat = perLoc.get(loc.name) ?? {
          lech: 0,
          quet: 0,
          chenhOnHand: 0,
          thieuDong: 0,
        };
        stat.quet += 1;

        const level = levelByKey.get(`${variant.id}:${loc.id}`);
        if (!level) {
          // Sapo có dòng tồn mà DB chưa có: coi như DB đang là 0 ở mọi bucket.
          stat.thieuDong += 1;
          if (BUCKETS.some(([, sapoKey]) => n(row[sapoKey]) !== 0)) {
            stat.lech += 1;
            stat.chenhOnHand += n(row.on_hand);
            if (viDu.length < 12) {
              viDu.push(
                `${variant.sku} @ ${loc.name}: DB chưa có dòng, Sapo on_hand=${n(row.on_hand)}`,
              );
            }
          }
          perLoc.set(loc.name, stat);
          continue;
        }

        let lechDong = false;
        for (const [dbKey, sapoKey] of BUCKETS) {
          const sapoVal = n(row[sapoKey]);
          const dbVal = level[dbKey];
          if (sapoVal === dbVal) continue;
          lechDong = true;
          bucketLech[sapoKey] = (bucketLech[sapoKey] ?? 0) + 1;
          if (dbKey === 'onHand') stat.chenhOnHand += sapoVal - dbVal;
          if (viDu.length < 12) {
            viDu.push(
              `${variant.sku} @ ${loc.name}: ${sapoKey} DB=${dbVal} → Sapo=${sapoVal}`,
            );
          }
        }
        if (lechDong) stat.lech += 1;
        perLoc.set(loc.name, stat);
      }

      await throttle();
      if (rows.length < PAGE_LIMIT) break;
    }

    const done = Math.min(i + BATCH_SIZE, itemIds.length);
    if (done % 2000 < BATCH_SIZE) {
      process.stdout.write(`\r  ...${done}/${itemIds.length} phiên bản`);
    }
  }
  console.log('');

  const rows = [...perLoc.entries()].sort((a, b) => b[1].lech - a[1].lech);
  console.log('\n=== LỆCH TỒN THEO KHO ===');
  console.log(
    'dòng lệch/quét'.padStart(16) +
      'chênh on_hand'.padStart(15) +
      'DB thiếu dòng'.padStart(15) +
      '  kho',
  );
  for (const [name, s] of rows) {
    console.log(
      `${s.lech}/${s.quet}`.padStart(16) +
        `${s.chenhOnHand > 0 ? '+' : ''}${s.chenhOnHand}`.padStart(15) +
        `${s.thieuDong}`.padStart(15) +
        `  ${name}`,
    );
  }

  const tongLech = rows.reduce((a, [, s]) => a + s.lech, 0);
  console.log('\n=== LỆCH THEO BUCKET ===');
  for (const [k, v] of Object.entries(bucketLech).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(13)} ${v}`);
  }

  if (viDu.length) {
    console.log('\n=== VÍ DỤ ===');
    for (const v of viDu) console.log(`  ${v}`);
  }

  const thieuItemId = await prisma.productVariant.count({
    where: { inventoryItemId: null },
  });
  console.log(
    `\nQuét ${scanned} dòng | LỆCH ${tongLech} dòng | ` +
      `${khongKhopItem} item Sapo không khớp phiên bản | ${khongKhopKho} dòng thuộc kho lạ | ` +
      `${thieuItemId} phiên bản thiếu inventory_item_id (không đối chiếu được)`,
  );
  console.log(
    tongLech === 0
      ? '\n✅ Tồn kho khớp Sapo.'
      : '\n⚠️  Đồng bộ bằng: POST /channels/sapo/inventory-sync (ghi đè theo Sapo, sinh bút toán `sapo_resync`)',
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
