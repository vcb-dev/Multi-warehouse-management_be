/**
 * Đồng bộ lại `inventory_levels` (tồn theo từng kho) từ số liệu SỐNG trên Sapo.
 *
 * Vì sao cần: `inventory_levels` hiện tại là ảnh chụp từ một lần nhập trực
 * tiếp từ Sapo trước đây (xem `backfill-opening-balance.js`), không được cập
 * nhật liên tục — đã xác minh có lệch thật so với Sapo hiện tại.
 *
 * Ghi đè TOÀN BỘ cột (on_hand, committed, packed, unavailable, incoming,
 * incoming_owned, incoming_not_owned, reserved) theo Sapo; riêng `available`
 * tính lại theo công thức nội bộ `on_hand - committed - packed - unavailable`
 * (không dùng available thô của Sapo) để giữ đúng bất biến mà
 * `reconcile.service.ts` đang kiểm tra.
 *
 * Đồng thời sinh bút toán bù (`inventory_movements`, reference_type =
 * 'sapo_resync') cho 5 bucket có sổ cái thật — bắt buộc phải làm, nếu không
 * sẽ tái tạo lỗ hổng "on_hand ≠ Σ movements" mà `backfill-opening-balance.js`
 * từng phải vá một lần rồi.
 *
 * Chỉ đồng bộ được phiên bản đã có `inventory_item_id` (khoá gọi API này) —
 * phiên bản thiếu sẽ được báo cáo riêng, không đồng bộ.
 *
 * Chạy thử (không ghi):  node scripts/sync-sapo-inventory-levels.js
 * Ghi thật:              node scripts/sync-sapo-inventory-levels.js --apply
 */
require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const { PrismaClient, Prisma } = require('@prisma/client');

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');
const STORE = process.env.SAPO_STORE;
const AUTH = Buffer.from(
  `${process.env.SAPO_API_KEY}:${process.env.SAPO_API_SECRET}`,
).toString('base64');

const BATCH_SIZE = 40; // an toàn dưới PAGE_LIMIT ngay cả khi nhiều kho/sản phẩm
const PAGE_LIMIT = 250;
const WRITE_CHUNK = 1000;
const REFERENCE_TYPE = 'sapo_resync';
const LEDGER_BUCKETS = ['onHand', 'committed', 'packed', 'unavailable', 'incoming'];
const BUCKET_NAME = {
  onHand: 'on_hand',
  committed: 'committed',
  packed: 'packed',
  unavailable: 'unavailable',
  incoming: 'incoming',
};

async function api(path, tries = 5) {
  for (let i = 1; i <= tries; i++) {
    const res = await fetch(`https://${STORE}.mysapo.net${path}`, {
      headers: { Authorization: `Basic ${AUTH}` },
    });
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after')) || 2 * i;
      await new Promise((r) => setTimeout(r, 1000 * retryAfter));
      continue;
    }
    if (!res.ok) {
      if (i === tries) throw new Error(`HTTP ${res.status} — ${path}`);
      await new Promise((r) => setTimeout(r, 1000 * i));
      continue;
    }
    const rateLimit = res.headers.get('x-sapo-api-call-limit'); // "used/total"
    const json = await res.json();
    return { json, rateLimit };
  }
  throw new Error(`Không gọi được sau ${tries} lần: ${path}`);
}

async function throttle(rateLimit) {
  if (!rateLimit) return new Promise((r) => setTimeout(r, 250));
  const [used, total] = rateLimit.split('/').map(Number);
  const ratio = total ? used / total : 0;
  const delay = ratio > 0.75 ? 1200 : ratio > 0.5 ? 500 : 250;
  return new Promise((r) => setTimeout(r, delay));
}

function round(v) {
  return Math.round(Number(v ?? 0));
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

(async () => {
  console.log(APPLY ? '>>> CHẾ ĐỘ GHI THẬT' : '>>> chạy thử, không ghi gì');

  const locations = await prisma.location.findMany({
    where: { sapoId: { not: null } },
    select: { id: true, name: true, sapoId: true },
  });
  const locBySapoId = new Map(locations.map((l) => [l.sapoId.toString(), l]));

  const variants = await prisma.productVariant.findMany({
    where: { inventoryItemId: { not: null } },
    select: { id: true, sku: true, inventoryItemId: true },
  });
  const variantByInvItemId = new Map(
    variants.map((v) => [v.inventoryItemId.toString(), v]),
  );
  const thieuInventoryItemId = await prisma.productVariant.count({
    where: { inventoryItemId: null },
  });

  const existingLevels = await prisma.inventoryLevel.findMany();
  const existingByKey = new Map(
    existingLevels.map((l) => [`${l.variantId}:${l.locationId}`, l]),
  );

  console.log(
    `Local: ${variants.length} phiên bản có inventory_item_id (${thieuInventoryItemId} thiếu, bỏ qua), ` +
      `${locations.length} kho có sapo_id, ${existingLevels.length} dòng tồn hiện có.`,
  );

  const itemIdBatches = chunk([...variantByInvItemId.keys()], BATCH_SIZE);

  const upsertRows = [];
  const movementRows = [];
  const seenKeys = new Set();
  const khongKhopItem = new Set();
  const khongKhopLocation = new Set();
  let daDungSan = 0;
  let banGhiMoi = 0;
  const bucketDoiCount = Object.fromEntries(LEDGER_BUCKETS.map((b) => [b, 0]));

  for (let bi = 0; bi < itemIdBatches.length; bi++) {
    const ids = itemIdBatches[bi];
    let page = 1;
    for (;;) {
      const { json, rateLimit } = await api(
        `/admin/inventory_levels.json?inventory_item_ids=${ids.join(',')}&limit=${PAGE_LIMIT}&page=${page}`,
      );
      const rows = json.inventory_levels ?? [];

      for (const row of rows) {
        const variant = variantByInvItemId.get(String(row.inventory_item_id));
        if (!variant) {
          khongKhopItem.add(String(row.inventory_item_id));
          continue;
        }
        const location = locBySapoId.get(String(row.location_id));
        if (!location) {
          khongKhopLocation.add(String(row.location_id));
          continue;
        }

        const key = `${variant.id}:${location.id}`;
        seenKeys.add(key);

        const onHand = round(row.on_hand);
        const committed = round(row.committed);
        const packed = round(row.packed);
        const unavailable = round(row.unavailable);
        const incoming = round(row.incoming);
        const incomingOwned = round(row.incoming_owned);
        const incomingNotOwned = round(row.incoming_not_owned);
        const reserved = round(row.reserved);
        const available = onHand - committed - packed - unavailable;

        const before = existingByKey.get(key);
        const beforeVals = before ?? {
          onHand: 0,
          committed: 0,
          packed: 0,
          unavailable: 0,
          incoming: 0,
          incomingOwned: 0,
          incomingNotOwned: 0,
          reserved: 0,
          available: 0,
        };
        const after = {
          onHand,
          committed,
          packed,
          unavailable,
          incoming,
          incomingOwned,
          incomingNotOwned,
          reserved,
          available,
        };

        const coDoi = Object.keys(after).some((k) => after[k] !== beforeVals[k]);
        if (!coDoi) {
          daDungSan += 1;
          continue;
        }
        if (!before) banGhiMoi += 1;

        upsertRows.push({
          variantId: variant.id,
          locationId: location.id,
          isNew: !before,
          ...after,
        });

        for (const bucket of LEDGER_BUCKETS) {
          const diff = after[bucket] - beforeVals[bucket];
          if (diff === 0) continue;
          bucketDoiCount[bucket] += 1;
          movementRows.push({
            variantId: variant.id,
            locationId: location.id,
            bucket: BUCKET_NAME[bucket],
            change: diff,
            type: 'adjust',
            referenceType: REFERENCE_TYPE,
            referenceId: null,
            createdById: null,
          });
        }
      }

      await throttle(rateLimit);
      if (rows.length < PAGE_LIMIT) break;
      page += 1;
    }

    process.stdout.write(
      `\r  batch ${bi + 1}/${itemIdBatches.length} — ${upsertRows.length} dòng sẽ đổi`,
    );
  }
  console.log('');

  const localOnlyKeys = [...existingByKey.keys()].filter((k) => !seenKeys.has(k));

  console.log(`\nKẾT QUẢ`);
  console.log(`  dòng đã quét từ Sapo:          ${seenKeys.size}`);
  console.log(`  sẽ cập nhật/tạo mới:           ${upsertRows.length} (trong đó mới hoàn toàn: ${banGhiMoi})`);
  console.log(`  đã đúng sẵn:                   ${daDungSan}`);
  console.log(`  bút toán bù sẽ sinh:           ${movementRows.length}`);
  for (const b of LEDGER_BUCKETS) {
    if (bucketDoiCount[b]) console.log(`    ${BUCKET_NAME[b].padEnd(12)} ${bucketDoiCount[b]}`);
  }
  console.log(`  inventory_item_id không khớp local: ${khongKhopItem.size}`);
  console.log(`  location_id không khớp local:       ${khongKhopLocation.size}`);
  console.log(`  dòng local có nhưng Sapo không trả về (giữ nguyên): ${localOnlyKeys.length}`);
  console.log(`  phiên bản thiếu inventory_item_id (bỏ qua):         ${thieuInventoryItemId}`);

  fs.mkdirSync('scripts-tmp', { recursive: true });
  if (khongKhopItem.size) {
    fs.writeFileSync(
      'scripts-tmp/sapo-inventory-sync-unmatched-items.json',
      JSON.stringify([...khongKhopItem], null, 1),
    );
    console.log(`  → item không khớp: scripts-tmp/sapo-inventory-sync-unmatched-items.json`);
  }
  if (khongKhopLocation.size) {
    fs.writeFileSync(
      'scripts-tmp/sapo-inventory-sync-unmatched-locations.json',
      JSON.stringify([...khongKhopLocation], null, 1),
    );
    console.log(`  → kho không khớp: scripts-tmp/sapo-inventory-sync-unmatched-locations.json`);
  }
  if (localOnlyKeys.length) {
    fs.writeFileSync(
      'scripts-tmp/sapo-inventory-sync-local-only.json',
      JSON.stringify(localOnlyKeys, null, 1),
    );
    console.log(`  → dòng chỉ có ở local: scripts-tmp/sapo-inventory-sync-local-only.json`);
  }

  if (!APPLY) {
    console.log(`\nChưa ghi gì. Thêm --apply để cập nhật.`);
    return;
  }

  // KHÔNG có unique/PK constraint thật trên (variant_id, location_id) trong DB
  // (chỉ có index thường — lệch với @@id khai báo ở schema.prisma), nên không
  // dùng được ON CONFLICT. Tách INSERT (dòng hoàn toàn mới, không đụng tới
  // constraint nào) và UPDATE...FROM VALUES (dòng đã có) — đúng kiểu đã dùng ở
  // flush() trong backfill-inventory-item-ids.js.
  const insertRows = upsertRows.filter((r) => r.isNew);
  const updateRows = upsertRows.filter((r) => !r.isNew);

  for (let i = 0; i < insertRows.length; i += WRITE_CHUNK) {
    const rowsChunk = insertRows.slice(i, i + WRITE_CHUNK);
    const values = rowsChunk.map(
      (r) => Prisma.sql`(${r.variantId}::bigint, ${r.locationId}::bigint, ${r.onHand}, ${r.available}, ${r.committed}, ${r.incoming}, ${r.incomingOwned}, ${r.incomingNotOwned}, ${r.packed}, ${r.reserved}, ${r.unavailable}, now(), now())`,
    );
    await prisma.$executeRaw`
      INSERT INTO inventory_levels
        (variant_id, location_id, on_hand, available, committed, incoming, incoming_owned, incoming_not_owned, packed, reserved, unavailable, created_at, updated_at)
      VALUES ${Prisma.join(values)}`;
    process.stdout.write(`\r  đã thêm mới ${Math.min(i + WRITE_CHUNK, insertRows.length)}/${insertRows.length}`);
  }
  console.log('');

  for (let i = 0; i < updateRows.length; i += WRITE_CHUNK) {
    const rowsChunk = updateRows.slice(i, i + WRITE_CHUNK);
    const values = rowsChunk.map(
      (r) => Prisma.sql`(${r.variantId}::bigint, ${r.locationId}::bigint, ${r.onHand}, ${r.available}, ${r.committed}, ${r.incoming}, ${r.incomingOwned}, ${r.incomingNotOwned}, ${r.packed}, ${r.reserved}, ${r.unavailable})`,
    );
    await prisma.$executeRaw`
      UPDATE inventory_levels AS t SET
        on_hand = v.on_hand,
        available = v.available,
        committed = v.committed,
        incoming = v.incoming,
        incoming_owned = v.incoming_owned,
        incoming_not_owned = v.incoming_not_owned,
        packed = v.packed,
        reserved = v.reserved,
        unavailable = v.unavailable,
        updated_at = now()
      FROM (VALUES ${Prisma.join(values)}) AS v(variant_id, location_id, on_hand, available, committed, incoming, incoming_owned, incoming_not_owned, packed, reserved, unavailable)
      WHERE t.variant_id = v.variant_id AND t.location_id = v.location_id`;
    process.stdout.write(`\r  đã cập nhật ${Math.min(i + WRITE_CHUNK, updateRows.length)}/${updateRows.length}`);
  }
  console.log('');

  for (let i = 0; i < movementRows.length; i += WRITE_CHUNK) {
    await prisma.inventoryMovement.createMany({
      data: movementRows.slice(i, i + WRITE_CHUNK),
    });
    process.stdout.write(
      `\r  đã ghi bút toán ${Math.min(i + WRITE_CHUNK, movementRows.length)}/${movementRows.length}`,
    );
  }
  console.log('');

  // Kiểm lại: ledger sum phải khớp giá trị level mới ghi cho các dòng vừa đổi.
  const touchedKeys = [...new Set(movementRows.map((m) => `${m.variantId}:${m.locationId}`))];
  let conLech = 0;
  for (const key of touchedKeys) {
    const [variantId, locationId] = key.split(':').map(BigInt);
    const sums = await prisma.inventoryMovement.groupBy({
      by: ['bucket'],
      where: { variantId, locationId },
      _sum: { change: true },
    });
    const level = await prisma.inventoryLevel.findUnique({
      where: { variantId_locationId: { variantId, locationId } },
    });
    for (const bucket of LEDGER_BUCKETS) {
      const ledgerSum =
        sums.find((s) => s.bucket === BUCKET_NAME[bucket])?._sum.change ?? 0;
      if (ledgerSum !== level[bucket]) conLech += 1;
    }
  }
  console.log(`\nĐã ghi ${upsertRows.length} dòng tồn, ${movementRows.length} bút toán. Còn lệch: ${conLech} (kỳ vọng 0).`);
})()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
