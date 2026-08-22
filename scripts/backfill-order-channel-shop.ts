#!/usr/bin/env tsx
/**
 * Backfill tên gian hàng (`channel_shop_name`/`channel_shop_id`) cho đơn sàn cũ.
 *
 * Chạy: npx tsx scripts/backfill-order-channel-shop.ts [--apply] [--limit=N]
 *
 * Vì sao cần script riêng, không gộp vào `backfill-order-source-reference.ts`: mã tham chiếu
 * suy được offline từ `orders.name`, còn tên gian hàng thì KHÔNG có ở đâu trong DB — phải hỏi
 * Sapo. Đo 21/08/2026: 30.912 đơn tiktokshop/shopee trống cột này, trong khi shop bán trên
 * **7 gian** (Viễn Chí Bảo, Viễn Chí Bảo Silver, Trang sức Viễn Chí Bảo, Miêu Bạc, Minco
 * Accessories, Viễn Chí Bảo Art Silver...) nên để trống là mất hẳn chiều phân tích theo gian.
 *
 * Hai pha, tách bạch vì độ tin cậy khác nhau:
 *
 * - **Pha 1 (nguồn thật)** — đơn có `sapo_id`: hỏi thẳng Sapo, lấy `channel_definition`.
 * - **Pha 2 (suy luận)** — đơn KHÔNG có `sapo_id` (do sync thẳng từ sàn tạo ra, Sapo không hề
 *   biết): gán theo gian hàng của chính kết nối đang chạy. An toàn vì sync trực tiếp chỉ kéo
 *   được đơn của đúng gian nó kết nối; nhưng vẫn là suy luận nên phải bật riêng bằng
 *   `--infer` và chỉ áp cho đơn có `source_identifier` đúng dạng mã sàn.
 *
 * KHÔNG đụng đơn đã có `channel_shop_name` (mệnh đề `IS NULL` trong mọi câu UPDATE) — chạy lại
 * bao nhiêu lần cũng không ghi đè dữ liệu sync trực tiếp đã đặt.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { normalizeChannelShopName } from '../src/modules/channels/channel-order-link';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');
const INFER = process.argv.includes('--infer');
const LIMIT = Number(
  process.argv.find((a) => a.startsWith('--limit='))?.slice('--limit='.length) ??
    0,
);

const STORE = process.env.SAPO_STORE;
const AUTH = Buffer.from(
  `${process.env.SAPO_API_KEY}:${process.env.SAPO_API_SECRET}`,
).toString('base64');

/** Số id hỏi Sapo mỗi lượt. 60 × ~19 ký tự ≈ 1,2 KB URL — thừa an toàn với giới hạn độ dài. */
const FETCH_BATCH = 60;
/** Số dòng mỗi câu UPDATE. 100 dòng × 3 tham số = 300 bind — xa trần 32.767 của Postgres. */
const WRITE_BATCH = 100;

const SOURCE_NAMES = ['tiktokshop', 'shopee'];

async function api(path: string, tries = 5): Promise<any> {
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(`https://${STORE}.mysapo.net${path}`, {
        headers: { Authorization: `Basic ${AUTH}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (i === tries) throw e;
      await new Promise((r) => setTimeout(r, 1000 * i));
    }
  }
}

type Patch = { sapoId: string; shopName: string; shopId: string | null };

/**
 * Ghi một mẻ bằng MỘT câu UPDATE ... FROM (VALUES ...).
 *
 * Không lặp `prisma.order.update()` từng dòng: cùng bài học đã ghi trong
 * `backfill-order-source-reference.ts` — đường per-row chạy 3.500 đơn mất 13 phút vì mỗi dòng
 * là một round-trip tới Supabase; ở đây 30.912 đơn sẽ thành nhiều giờ.
 */
async function writePatches(rows: Patch[]): Promise<number> {
  let written = 0;
  for (let i = 0; i < rows.length; i += WRITE_BATCH) {
    const batch = rows.slice(i, i + WRITE_BATCH);
    const params: any[] = [];
    const values = batch
      .map((r) => {
        params.push(r.sapoId, r.shopName, r.shopId);
        const n = params.length;
        return `($${n - 2}::bigint, $${n - 1}::text, $${n}::text)`;
      })
      .join(',');

    written += await prisma.$executeRawUnsafe(
      `UPDATE "orders" AS o
          SET "channel_shop_name" = v.shop_name,
              "channel_shop_id"   = COALESCE(v.shop_id, o."channel_shop_id")
         FROM (VALUES ${values}) AS v(sapo_id, shop_name, shop_id)
        WHERE o."sapo_id" = v.sapo_id
          AND o."channel_shop_name" IS NULL`,
      ...params,
    );
  }
  return written;
}

/** Pha 1 — đơn có `sapo_id`: lấy gian hàng thật từ Sapo. */
async function phaseSapo() {
  const rows = await prisma.$queryRawUnsafe<{ sapo_id: string }[]>(
    `SELECT sapo_id::text AS sapo_id FROM orders
      WHERE source_name = ANY($1::text[])
        AND channel_shop_name IS NULL AND sapo_id IS NOT NULL
      ORDER BY created_on DESC ${LIMIT ? `LIMIT ${LIMIT}` : ''}`,
    SOURCE_NAMES,
  );
  console.log(`\n=== PHA 1 — hỏi Sapo: ${rows.length} đơn ===`);
  if (!rows.length) return 0;

  const ids = rows.map((r) => r.sapo_id);
  const patches: Patch[] = [];
  const shops = new Map<string, number>();
  let noShop = 0;
  let written = 0;

  for (let i = 0; i < ids.length; i += FETCH_BATCH) {
    const j = await api(
      `/admin/orders.json?limit=250&ids=${ids.slice(i, i + FETCH_BATCH).join(',')}`,
    );
    for (const o of j.orders ?? []) {
      const shopName = normalizeChannelShopName(
        o.source_name,
        o.channel_definition?.branch_name,
      );
      if (!shopName) {
        noShop++;
        continue;
      }
      shops.set(shopName, (shops.get(shopName) ?? 0) + 1);
      patches.push({
        sapoId: String(o.id),
        shopName,
        shopId: o.channel_definition?.branch_external_id
          ? String(o.channel_definition.branch_external_id)
          : null,
      });
    }

    // Ghi dần theo mẻ thay vì dồn cuối: lượt chạy dài (hơn 500 lời gọi API) mà đứt giữa chừng
    // thì phần đã lấy vẫn được giữ, chạy lại chỉ tốn phần còn thiếu.
    if (APPLY && patches.length >= 600) {
      written += await writePatches(patches.splice(0));
    }
    const done = Math.min(i + FETCH_BATCH, ids.length);
    if (done % 1200 === 0 || done === ids.length) {
      console.log(`  ... ${done}/${ids.length} đơn (đã ghi ${written})`);
    }
  }
  if (APPLY && patches.length) written += await writePatches(patches.splice(0));

  console.log(`  Sapo không có gian hàng: ${noShop} đơn (để nguyên NULL)`);
  console.log('  Phân bố gian hàng:');
  for (const [k, v] of [...shops.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(v).padStart(6)}  ${k}`);
  }
  console.log(`  ${APPLY ? 'ĐÃ GHI' : 'sẽ ghi'}: ${APPLY ? written : shops.size ? [...shops.values()].reduce((a, b) => a + b, 0) : 0} đơn`);
  return written;
}

/**
 * Pha 2 — đơn không có `sapo_id`: gán gian hàng của kết nối trực tiếp.
 *
 * Chỉ áp cho đơn có `source_identifier` (mã đơn sàn thật) để loại đơn nhập tay bị gắn nhầm
 * `source_name`. Cần đúng MỘT kết nối cho mỗi kênh, nếu nhiều hơn thì không đoán được đơn nào
 * của gian nào — bỏ qua thay vì gán bừa.
 */
async function phaseInfer() {
  console.log('\n=== PHA 2 — suy từ kết nối trực tiếp ===');
  const conns = await prisma.channelConnection.findMany({
    select: { channel: true, shopId: true, shopName: true },
  });
  const bySource: Record<string, string> = {
    tiktokshop: 'tiktok',
    shopee: 'shopee',
  };
  let written = 0;

  for (const [sourceName, channel] of Object.entries(bySource)) {
    const matches = conns.filter((c) => c.channel === channel);
    if (matches.length !== 1 || !matches[0].shopName) {
      console.log(
        `  ${sourceName}: có ${matches.length} kết nối — bỏ qua (không suy được gian hàng)`,
      );
      continue;
    }
    const shop = matches[0];
    const shopName = normalizeChannelShopName(sourceName, shop.shopName)!;
    // CHỈ ghi tên, KHÔNG ghi `channel_shop_id` từ `channelConnection.shopId`: với TikTok cột
    // đó lưu **shop cipher** (`mzm8WQAAAAC...`) chứ không phải mã gian hàng, đổ vào sẽ lệch
    // hẳn với `7495245725371828263` mà sync trực tiếp đang ghi. Mã gian hàng vốn cũng không
    // hiển thị ở đâu (UI chỉ dùng tên) nên để trống còn hơn điền sai.

    const sql = `"source_name" = $1
        AND "channel_shop_name" IS NULL
        AND "sapo_id" IS NULL
        AND "source_identifier" IS NOT NULL`;
    const [{ n }] = await prisma.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM "orders" WHERE ${sql}`,
      sourceName,
    );
    console.log(`  ${sourceName}: ${n} đơn → "${shopName}"`);
    if (!APPLY || !n) continue;

    written += await prisma.$executeRawUnsafe(
      `UPDATE "orders" SET "channel_shop_name" = $2 WHERE ${sql}`,
      sourceName,
      shopName,
    );
  }
  console.log(`  ${APPLY ? 'ĐÃ GHI' : 'sẽ ghi'}: ${written} đơn`);
  return written;
}

async function main() {
  console.log(
    APPLY ? '=== CHẠY THẬT (--apply) ===' : '=== THỬ KHÔ (thêm --apply để ghi) ===',
  );
  let total = await phaseSapo();
  if (INFER) total += await phaseInfer();
  else console.log('\n(bỏ qua PHA 2 — thêm --infer nếu muốn gán theo kết nối trực tiếp)');

  console.log(`\nTổng cộng ${APPLY ? 'đã ghi' : 'sẽ ghi'} ${total} đơn.`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
