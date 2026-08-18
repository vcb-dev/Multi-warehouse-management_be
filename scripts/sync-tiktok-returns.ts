#!/usr/bin/env tsx
/**
 * Đồng bộ phiếu hoàn/trả TikTok theo khoảng ngày.
 *
 * Chạy: npx tsx scripts/sync-tiktok-returns.ts --from=2026-05-01 --to=2026-08-18 [--by=created]
 *
 * `--by=updated` (mặc định) lọc theo NGÀY CẬP NHẬT — phiếu hoàn sống rất lâu (đo 2026-08-18:
 * phiếu tạo tháng 5 vẫn đang chờ khách gửi hàng), lọc theo ngày tạo sẽ bỏ sót mọi thay đổi
 * trạng thái về sau.
 */
import 'dotenv/config';
import { PrismaClient, UserRole } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { TiktokAuthService } from '../src/modules/channels/tiktok/tiktok-auth.service';
import { TiktokReturnSyncService } from '../src/modules/channels/tiktok/tiktok-return-sync.service';

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
}

async function main() {
  const from = arg('from');
  const to = arg('to');
  const by = (arg('by') ?? 'updated') as 'created' | 'updated';
  if (!from || !to) {
    console.error('Ví dụ: npx tsx scripts/sync-tiktok-returns.ts --from=2026-05-01 --to=2026-08-18');
    process.exit(1);
  }

  const prisma = new PrismaClient() as unknown as PrismaService;
  const sync = new TiktokReturnSyncService(prisma, new TiktokAuthService(prisma));

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
  if (!actor) throw new Error('Không tìm thấy tài khoản admin nào');

  console.log(`Đồng bộ phiếu hoàn TikTok ${from} → ${to} (lọc theo ${by})…`);
  const started = Date.now();
  const r = await sync.syncReturns({ from, to, filterBy: by, createdById: actor.id });
  const secs = Math.round((Date.now() - started) / 1000);

  console.log(
    `Xong sau ${secs}s — ${r.fetched} phiếu: ${r.orders_updated} đơn đổi trạng thái, ` +
      `${r.returns_saved} phiếu ghi vào order_returns, ${r.unmatched_orders} đơn chưa có trong DB`,
  );
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error('LỖI:', e?.message ?? e);
  process.exit(1);
});
