/**
 * Sinh bút toán SỐ DƯ ĐẦU KỲ cho sổ cái tồn kho.
 *
 * Vì sao cần: tồn kho được nhập thẳng từ Sapo vào `inventory_levels`, còn
 * `inventory_movements` chỉ được ghi bởi nghiệp vụ chạy trong app. Bằng chứng:
 * chỉ 13/15.251 cặp (variant, kho) có movement, toàn bộ movement nằm gọn trong
 * khoảng thao tác tay tháng 7, và `inventory_levels` được cập nhật SAU movement
 * cuối cùng 3 ngày. Nên bất biến "on_hand = Σ movements" sai với dữ liệu nhập —
 * thiếu bút toán đầu kỳ chứ không phải dữ liệu hỏng.
 *
 * Cách làm: với mỗi (variant, kho, bồn) mà giá trị ở `inventory_levels` lệch
 * tổng sổ cái, chèn ĐÚNG MỘT dòng bù cho phần chênh.
 *
 * QUAN TRỌNG: không dùng InventoryService.applyMovement — hàm đó cập nhật luôn
 * `inventory_levels` nên sẽ nhân đôi tồn. Ở đây chỉ ghi vào bảng movement.
 *
 * Hoàn tác:
 *   DELETE FROM inventory_movements WHERE reference_type = 'opening_balance';
 *
 * Chạy thử:  node scripts/backfill-opening-balance.js
 * Ghi thật:  node scripts/backfill-opening-balance.js --apply
 */
require('dotenv').config({ quiet: true });
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');
const WRITE_CHUNK = 1000;
const REFERENCE_TYPE = 'opening_balance';

/** Bồn có sổ cái đối ứng — `available` là số dẫn xuất, `reserved` do Sapo giữ. */
const BUCKETS = [
  { bucket: 'on_hand', field: 'onHand' },
  { bucket: 'committed', field: 'committed' },
  { bucket: 'packed', field: 'packed' },
  { bucket: 'unavailable', field: 'unavailable' },
  { bucket: 'incoming', field: 'incoming' },
];

(async () => {
  console.log(APPLY ? '>>> CHẾ ĐỘ GHI THẬT' : '>>> chạy thử, không ghi gì');

  const daCo = await prisma.inventoryMovement.count({
    where: { referenceType: REFERENCE_TYPE },
  });
  if (daCo) {
    console.log(
      `\n⚠ Đã có ${daCo} bút toán '${REFERENCE_TYPE}'. Xoá chúng trước khi chạy lại:\n` +
        `  DELETE FROM inventory_movements WHERE reference_type = '${REFERENCE_TYPE}';`,
    );
    return;
  }

  const levels = await prisma.inventoryLevel.findMany({
    select: {
      variantId: true,
      locationId: true,
      onHand: true,
      committed: true,
      packed: true,
      unavailable: true,
      incoming: true,
    },
  });

  const sums = await prisma.inventoryMovement.groupBy({
    by: ['variantId', 'locationId', 'bucket'],
    _sum: { change: true },
  });
  const key = (v, l, b) => `${v}:${l}:${b}`;
  const ledger = new Map(
    sums.map((s) => [key(s.variantId, s.locationId, s.bucket), s._sum.change ?? 0]),
  );

  const rows = [];
  const theoButket = Object.fromEntries(BUCKETS.map((b) => [b.bucket, 0]));

  for (const lv of levels) {
    for (const { bucket, field } of BUCKETS) {
      const expected = lv[field];
      const actual = ledger.get(key(lv.variantId, lv.locationId, bucket)) ?? 0;
      const diff = expected - actual;
      if (diff === 0) continue;
      theoButket[bucket] += 1;
      rows.push({
        variantId: lv.variantId,
        locationId: lv.locationId,
        bucket,
        change: diff,
        type: 'adjust',
        referenceType: REFERENCE_TYPE,
        referenceId: null,
        createdById: null,
      });
    }
  }

  console.log(`\nKẾT QUẢ`);
  console.log(`  dòng tồn đã quét:      ${levels.length}`);
  console.log(`  bút toán sẽ sinh:      ${rows.length}`);
  for (const b of BUCKETS) {
    if (theoButket[b.bucket]) {
      console.log(`    ${b.bucket.padEnd(12)} ${theoButket[b.bucket]}`);
    }
  }

  if (!APPLY) {
    console.log(`\nChưa ghi gì. Thêm --apply để sinh bút toán.`);
    return;
  }

  for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
    await prisma.inventoryMovement.createMany({
      data: rows.slice(i, i + WRITE_CHUNK),
    });
    process.stdout.write(
      `\r  đã ghi ${Math.min(i + WRITE_CHUNK, rows.length)}/${rows.length}`,
    );
  }
  console.log('');

  // Kiểm lại: sau khi ghi thì mọi bồn phải khớp tổng sổ cái.
  const sums2 = await prisma.inventoryMovement.groupBy({
    by: ['variantId', 'locationId', 'bucket'],
    _sum: { change: true },
  });
  const ledger2 = new Map(
    sums2.map((s) => [key(s.variantId, s.locationId, s.bucket), s._sum.change ?? 0]),
  );
  let conLech = 0;
  for (const lv of levels) {
    for (const { bucket, field } of BUCKETS) {
      const actual = ledger2.get(key(lv.variantId, lv.locationId, bucket)) ?? 0;
      if (lv[field] !== actual) conLech += 1;
    }
  }
  console.log(`\nĐã ghi ${rows.length} bút toán. Còn lệch: ${conLech} (kỳ vọng 0).`);
})()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
