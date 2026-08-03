/**
 * Chạy thật mọi báo cáo trong registry để bắt lỗi SQL — `$queryRaw` hoàn toàn vô hình với
 * `tsc` (điểm mù đã ghi trong docs/sapo-schema-mapping.md).
 *
 * Chạy: npx ts-node --compiler-options '{"module":"CommonJS"}' scripts-tmp/smoke-reports.ts
 */
import { PrismaClient } from '@prisma/client';
import { listReports } from '../src/modules/reports/report-registry';
import type { ReportContext } from '../src/modules/reports/report.types';

const prisma = new PrismaClient();

async function main() {
  const locations = await prisma.location.findMany({ select: { id: true }, take: 50 });
  if (!locations.length) throw new Error('DB không có location nào để test');

  const to = new Date();
  const from = new Date(to.getTime() - 365 * 24 * 60 * 60 * 1000);

  let failed = 0;
  for (const def of listReports()) {
    const ctx = {
      prisma: prisma as unknown as ReportContext['prisma'],
      user: { userId: 1n, email: '', roles: [], locationIds: locations.map((l) => l.id) },
      locationIds: locations.map((l) => l.id),
      from,
      to,
      bucket: 'day',
      page: 1,
      pageSize: 5,
    } as ReportContext;

    try {
      const res = await def.run(ctx);
      const cols = def.columns.map((c) => c.key);
      // Mọi cột khai trong metadata phải có mặt ở dòng dữ liệu, nếu không bảng ở UI sẽ trống cột
      const missing = res.rows.length
        ? cols.filter((k) => !(k in res.rows[0]))
        : [];
      const missingInSummary = cols.filter(
        (k) => !(k in res.summary) && k !== 'label',
      );
      const flag =
        missing.length || missingInSummary.length ? '  ⚠ thiếu cột' : '';
      console.log(
        `✓ ${def.id.padEnd(30)} ${String(res.total).padStart(5)} dòng${flag}` +
          (missing.length ? ` rows:[${missing}]` : '') +
          (missingInSummary.length ? ` summary:[${missingInSummary}]` : ''),
      );
    } catch (e) {
      failed++;
      console.error(`✗ ${def.id}\n   ${(e as Error).message.split('\n').slice(0, 4).join('\n   ')}`);
    }
  }
  console.log(failed ? `\n❌ ${failed} báo cáo lỗi` : '\n✅ Tất cả báo cáo chạy được');
  process.exitCode = failed ? 1 : 0;
}

main().finally(() => prisma.$disconnect());
