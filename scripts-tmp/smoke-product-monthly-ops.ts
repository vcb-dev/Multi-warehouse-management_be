/**
 * Chạy thật `runProductMonthlyOps` để bắt lỗi SQL runtime (FILTER/LATERAL/enum...) — tsc
 * không kiểm tra được nội dung `$queryRaw`. Xem scripts-tmp/smoke-reports.ts cho lý do.
 *
 * Chạy: npx ts-node --compiler-options '{"module":"CommonJS"}' scripts-tmp/smoke-product-monthly-ops.ts
 */
import { PrismaClient } from '@prisma/client';
import { runProductMonthlyOps } from '../src/modules/reports/reports/product-monthly-ops.report';

const prisma = new PrismaClient();

async function main() {
  const locations = await prisma.location.findMany({ select: { id: true } });
  if (!locations.length) throw new Error('DB không có location nào để test');
  const locationIds = locations.map((l) => l.id);

  const category = await prisma.category.findFirst({ select: { id: true, name: true } });

  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), 1);
  const to = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const prevFrom = new Date(now.getFullYear(), now.getMonth() - 1, 1);

  console.log(`Tháng đang test: ${from.toISOString().slice(0, 10)} → ${to.toISOString().slice(0, 10)}`);
  console.log(`Số kho: ${locationIds.length}`);

  console.log('\n--- Không lọc danh mục ---');
  const r1 = await runProductMonthlyOps({
    prisma: prisma as any,
    from,
    to,
    prevFrom,
    locationIds,
    categoryId: undefined,
    topLimit: 10,
  });
  console.log(JSON.stringify(r1, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));

  if (category) {
    console.log(`\n--- Lọc danh mục "${category.name}" (id=${category.id}) ---`);
    const r2 = await runProductMonthlyOps({
      prisma: prisma as any,
      from,
      to,
      prevFrom,
      locationIds,
      categoryId: category.id,
      topLimit: 10,
    });
    console.log(JSON.stringify(r2, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
  } else {
    console.log('\n(Không có category nào trong DB để test nhánh lọc danh mục)');
  }

  console.log('\n✅ Chạy xong không lỗi');
}

main()
  .catch((e) => {
    console.error('❌ FAILED:', e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
