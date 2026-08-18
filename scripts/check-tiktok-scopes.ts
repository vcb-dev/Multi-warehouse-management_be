#!/usr/bin/env tsx
/**
 * Kiểm tra token TikTok hiện tại có những quyền gì — chạy SAU khi bật gói API trong
 * Partner Center và ủy quyền lại.
 *
 * Chạy: npx tsx scripts/check-tiktok-scopes.ts
 *
 * Vì sao cần: `granted_scopes` trong DB KHÔNG đủ tin. Trước lần ủy quyền lại 15/08 nó có
 * 127 mục lẫn scope test nội bộ của TikTok (`QA TEST`, `冻结测试_tiktik_shop`). Cách duy
 * nhất biết chắc là gọi thử endpoint thật và xem có dính `105005` không.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { TiktokApiClient } from '../src/modules/channels/tiktok/tiktok-api.client';

/** Mã TikTok trả khi app chưa được cấp scope cho endpoint đó. */
const SCOPE_DENIED = 105005;

const prisma = new PrismaClient();

async function main() {
  const conn = await prisma.channelConnection.findFirst({
    where: { channel: 'tiktok' },
    orderBy: { createdAt: 'desc' },
  });
  if (!conn) throw new Error('Chưa có kết nối TikTok trong channel_connections');

  console.log(`Gian hàng: ${conn.shopName}`);
  console.log(`Token hết hạn: ${conn.accessTokenExpiresAt.toISOString()}`);
  console.log(`granted_scopes trong DB (${conn.grantedScopes.length}): ${conn.grantedScopes.join(', ')}\n`);

  const client = new TiktokApiClient(
    process.env.TIKTOK_APP_KEY!.trim(),
    process.env.TIKTOK_APP_SECRET!.trim(),
    conn.accessToken,
  );
  const shops = await client.getAuthorizedShops();
  const cipher = shops[0]?.cipher;
  if (!cipher) throw new Error('Token không gắn với gian hàng nào — cần ủy quyền lại');

  const now = Math.floor(Date.now() / 1000);
  const window = { create_time_ge: now - 7 * 86400, create_time_lt: now };

  // Phải là `call` (có retry) chứ KHÔNG phải `callOnce`: TikTok trả `105005` ngẫu nhiên
  // ngay cả khi scope đã đủ — đo 2026-08-18, gọi thẳng một phát báo "chưa có quyền" trong
  // khi vòng thử lại cùng lúc đó đang gọi được. Bỏ retry ở đây là script tự nói dối.
  const call = (client as unknown as {
    call: (m: 'GET' | 'POST', p: string, q?: Record<string, string>, b?: unknown) => Promise<unknown>;
  }).call.bind(client);

  // Mã kiện thật, lấy từ `fulfillments.name` (`TTS-{package_id}`). BẮT BUỘC phải thật:
  // TikTok validate tham số TRƯỚC khi kiểm quyền, nên id giả trả về lỗi tham số và làm
  // endpoint trông như đã có quyền — đúng cái bẫy đã dính với `shop_cipher` hồi 14/08.
  const pkg = await prisma.fulfillment.findFirst({
    where: { name: { startsWith: 'TTS-' } },
    orderBy: { id: 'desc' },
    select: { name: true },
  });
  const packageId = pkg?.name.slice(4);

  const checks: [string, () => Promise<unknown>][] = [
    ['Đơn hàng (seller.order.info)', () =>
      client.searchOrders({ shopCipher: cipher, createTimeGe: now - 86400, createTimeLt: now, pageSize: 1 })],
    ['Hoàn/huỷ hàng (seller.return_refund.basic)', () =>
      call('POST', '/return_refund/202309/returns/search', { shop_cipher: cipher, page_size: '1' }, window)],
    ['Yêu cầu huỷ đơn (seller.return_refund.basic)', () =>
      call('POST', '/return_refund/202309/cancellations/search', { shop_cipher: cipher, page_size: '1' }, window)],
    ...(packageId
      ? ([['Nhãn vận đơn (seller.fulfillment.basic)', () =>
          call('GET', `/fulfillment/202309/packages/${packageId}/shipping_documents`, {
            shop_cipher: cipher, document_type: 'SHIPPING_LABEL', document_size: 'A6',
          })]] as [string, () => Promise<unknown>][])
      : []),
  ];

  for (const [label, run] of checks) {
    try {
      await run();
      console.log(`✅ ${label} — GỌI ĐƯỢC`);
    } catch (e) {
      const code = (e as { tiktokCode?: number | null }).tiktokCode ?? null;
      if (code === SCOPE_DENIED) {
        console.log(`❌ ${label} — CHƯA CÓ QUYỀN (105005)`);
      } else {
        // Qua được tầng kiểm quyền. Chỉ kết luận như vậy vì mọi lời gọi ở trên đều dùng
        // tham số THẬT; với tham số giả thì lỗi tham số đến trước và không nói lên gì.
        console.log(`✅ ${label} — có quyền (lỗi tham số: ${code})`);
      }
    }
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error('LỖI:', e?.message ?? e);
  process.exit(1);
});
