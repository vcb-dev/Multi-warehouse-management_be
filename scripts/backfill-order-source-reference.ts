#!/usr/bin/env tsx
/**
 * Backfill "Mã tham chiếu" (`source_identifier`) + link đơn gốc (`source_url`) cho đơn cũ.
 *
 * Chạy: npx tsx scripts/backfill-order-source-reference.ts [--apply]
 *
 * Chỉ xử lý đơn TikTok Shop và Shopee, vì hai kênh này Sapo lấy **mã đơn bên sàn làm luôn
 * `orders.name`** (kiểm chứng 20/08/2026 trên 750 đơn Sapo gần nhất: `source_identifier`
 * trùng `name` ở 100% đơn tiktokshop/shopee) — nên dựng lại được offline, không tốn một lời
 * gọi API nào.
 *
 * KHÔNG xử lý đơn chat (facebook/instagram/zalo-oa/tiktok-for-business): `source_identifier`
 * của chúng là conversationId của Sapo Chat OmniAI (`6a858f582281d800012ea120`), còn `name`
 * là mã Sapo (`HK100699`) — không có quan hệ nào để suy ra. Nhóm đó phải kéo lại từ API Sapo,
 * để riêng một đợt.
 *
 * An toàn: chỉ UPDATE 2 cột `source_identifier`/`source_url` của đúng nhóm đơn nói trên, bỏ
 * qua đơn đã có sẵn giá trị (đơn mới do sync trực tiếp ghi). Không đụng tiền, tồn kho, trạng thái.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import {
  LinkableChannel,
  marketplaceOrderUrl,
} from '../src/modules/channels/channel-order-link';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

/**
 * `name` phải đúng dạng mã đơn của sàn thì mới ghép link. Đơn tiktokshop cũ đôi khi mang mã
 * Sapo (`HK79254`, `VCB01057092` — 244 đơn tính đến 20/08/2026): đó là đơn nhập tay hoặc đơn
 * Sapo tự sinh mã, ghép vào link Seller Center sẽ ra trang trống nên bỏ qua.
 */
const NAME_PATTERN: Record<LinkableChannel, RegExp> = {
  // Mã đơn TikTok: chuỗi số 18–19 chữ số
  tiktok: /^\d{15,}$/,
  // Mã đơn Shopee (`order_sn`): YYMMDD + 8 ký tự chữ/số in hoa. Sapo tách một đơn Shopee
  // thành nhiều đơn con thì gắn thêm đuôi `-<số>` (16 đơn tính đến 20/08/2026) — phần trước
  // dấu gạch vẫn là `order_sn` thật, tra được trên Shopee nên vẫn dựng link.
  shopee: /^[0-9A-Z]{12,16}(-\d+)?$/,
};

/** Mã đơn bên sàn suy ra từ `orders.name`. */
function identifierFromName(channel: LinkableChannel, name: string): string {
  return channel === 'shopee' ? name.replace(/-\d+$/, '') : name;
}

const SOURCE_NAMES: Record<LinkableChannel, string[]> = {
  tiktok: ['tiktokshop'],
  shopee: ['shopee'],
};

async function main() {
  console.log(
    APPLY
      ? '=== CHẠY THẬT (--apply) ==='
      : '=== THỬ KHÔ (thêm --apply để ghi) ===',
  );
  let totalUpdated = 0;

  for (const channel of ['tiktok', 'shopee'] as LinkableChannel[]) {
    const rows = await prisma.order.findMany({
      where: {
        sourceName: { in: SOURCE_NAMES[channel] },
        OR: [{ sourceIdentifier: null }, { sourceUrl: null }],
      },
      select: { id: true, name: true },
    });

    const ok = rows.filter((r) => NAME_PATTERN[channel].test(r.name));
    const skipped = rows.length - ok.length;
    console.log(
      `\n${channel}: ${rows.length} đơn chưa có mã tham chiếu — dựng được ${ok.length}, bỏ qua ${skipped} (mã không phải mã sàn)`,
    );
    if (ok.length) {
      const id = identifierFromName(channel, ok[0].name);
      console.log(
        `  ví dụ: ${ok[0].name} → ${marketplaceOrderUrl(channel, id)}`,
      );
    }
    if (skipped) {
      const ex = rows
        .filter((r) => !NAME_PATTERN[channel].test(r.name))
        .slice(0, 5);
      console.log(`  bỏ qua ví dụ: ${ex.map((r) => r.name).join(', ')}`);
    }
    if (!APPLY || !ok.length) continue;

    // Một câu UPDATE cho cả kênh, KHÔNG lặp `prisma.order.update()` từng dòng: đo 20/08/2026
    // trên chính DB này, đường per-row chạy 3.500/19.048 đơn mất 13 phút (~2,3 giờ cho cả
    // lượt) vì mỗi dòng là một round-trip tới Supabase. Set-based xong trong vài giây.
    //
    // Link ghép thẳng trong SQL thay vì gọi `marketplaceOrderUrl()`: giữ hai chỗ cùng một
    // dạng chuỗi là rủi ro có thật, nên mẫu link lấy từ chính hàm đó (thay mã bằng
    // placeholder) chứ không chép tay.
    // Placeholder phải là ký tự mà `encodeURIComponent` không đụng tới (chữ + số): dùng
    // `@@ID@@` thì nó bị mã hoá thành `%40%40ID%40%40`, split không tìm thấy, `suffix` ra
    // `undefined` và cả cột `source_url` ghi NULL — đã dính đúng lần chạy đầu 20/08/2026.
    const TOKEN = 'IDPLACEHOLDER';
    const parts = marketplaceOrderUrl(channel, TOKEN).split(TOKEN);
    if (parts.length !== 2) {
      throw new Error(`Không tách được mẫu link cho kênh ${channel}`);
    }
    const [prefix, suffix] = parts;
    const namePattern = NAME_PATTERN[channel].source;
    // Shopee: cắt đuôi `-<số>` của đơn Sapo tách nhỏ; TikTok giữ nguyên `name`.
    const idExpr =
      channel === 'shopee'
        ? `regexp_replace("name", '-[0-9]+$', '')`
        : `"name"`;

    const affected = await prisma.$executeRawUnsafe(
      `UPDATE "orders"
          SET "source_identifier" = ${idExpr},
              "source_url" = $1 || ${idExpr} || $2
        WHERE "source_name" = ANY($3::text[])
          AND ("source_identifier" IS NULL OR "source_url" IS NULL)
          AND "name" ~ $4`,
      prefix,
      suffix,
      SOURCE_NAMES[channel],
      namePattern,
    );
    totalUpdated += affected;
    console.log(`  đã ghi ${affected} đơn`);
  }

  console.log(
    `\nTổng cộng ${APPLY ? 'đã ghi' : 'sẽ ghi'} ${totalUpdated} đơn.`,
  );
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
