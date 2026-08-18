#!/usr/bin/env tsx
/**
 * Đồng bộ đơn TikTok theo khoảng ngày — dành cho vá những khoảng cron đã hụt.
 *
 * Chạy: npx tsx scripts/sync-tiktok-orders.ts --from=2026-05-01 --to=2026-05-31 [--by=created]
 *
 * Vì sao cần script chứ không bấm nút trên UI: HTTP mất ~0,7 giây/đơn nên khoảng dài
 * (cả tháng ≈ 1.400 đơn ≈ 16 phút) vượt timeout của proxy. Script không có timeout đó.
 *
 * `--by=updated` (mặc định) lọc theo NGÀY CẬP NHẬT — đúng thứ cần cho việc vá trạng thái:
 * một đơn đặt tháng 6 mà TikTok chốt COMPLETED tháng 7 sẽ nằm ở khoảng tháng 7, không
 * phải tháng 6. Dùng `--by=created` khi muốn lấy đơn MỚI của đúng khoảng ngày đó.
 *
 * Dựng service bằng `new` thay vì Nest DI: `AppModule` kéo theo `JwtStrategy` cần
 * `ConfigService` mà context standalone không có. Bộ thông báo là stub rỗng — backfill
 * hàng nghìn đơn cũ mà bắn chuông thì mỗi nhân viên nhận vài nghìn thông báo
 * (`SYNC_NOTIFY_MAX_AGE_HOURS` cũng đã chặn, đây là lớp thứ hai).
 */
import 'dotenv/config';
import { PrismaClient, UserRole } from '@prisma/client';
import { NotificationService } from '../src/modules/notifications/notification.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { TiktokAuthService } from '../src/modules/channels/tiktok/tiktok-auth.service';
import { TiktokOrderSyncService } from '../src/modules/channels/tiktok/tiktok-order-sync.service';

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
}

async function main() {
  const from = arg('from');
  const to = arg('to');
  const by = (arg('by') ?? 'updated') as 'created' | 'updated';
  if (!from || !to) {
    console.error(
      'Thiếu tham số. Ví dụ: npx tsx scripts/sync-tiktok-orders.ts --from=2026-05-01 --to=2026-05-31',
    );
    process.exit(1);
  }

  const prisma = new PrismaClient() as unknown as PrismaService;
  const notifications = {
    emit: async () => undefined,
  } as unknown as NotificationService;
  const sync = new TiktokOrderSyncService(
    prisma,
    new TiktokAuthService(prisma),
    notifications,
  );

  // Cùng cách chọn người tạo với `TiktokWebhookService.resolveActor()`: ưu tiên tài khoản
  // cron rồi mới lùi về admin bất kỳ — `orders.user_id` là cột bắt buộc.
  const actor =
    (await prisma.user.findFirst({
      where: { email: 'admin@local.dev', active: true },
      select: { id: true },
    })) ??
    (await prisma.user.findFirst({
      where: { active: true, roles: { has: UserRole.admin } },
      orderBy: { id: 'asc' },
      select: { id: true },
    }));
  if (!actor) throw new Error('Không tìm thấy tài khoản admin nào để gán làm người tạo đơn');

  console.log(`Đồng bộ TikTok ${from} → ${to} (lọc theo ${by})…`);
  const started = Date.now();
  const r = await sync.syncOrders({ from, to, filterBy: by, createdById: actor.id });
  const secs = Math.round((Date.now() - started) / 1000);

  console.log(
    `Xong sau ${secs}s — ${r.fetched} đơn: ${r.created} mới, ${r.updated} cập nhật, ` +
      `${r.skipped_lines} dòng bỏ qua, ${r.unmatched_skus} SKU chưa khớp, ` +
      `${r.kept_existing_lines} đơn giữ nguyên dòng hàng cũ, ${r.failed} đơn lỗi`,
  );
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error('LỖI:', e?.message ?? e);
  process.exit(1);
});
