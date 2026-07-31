/**
 * SC-002: "100% số liệu báo cáo khớp dữ liệu nguồn".
 * Đối chiếu tổng của báo cáo với aggregate trực tiếp trên bảng nguồn.
 */
import { PrismaClient } from '@prisma/client';
import { getReport } from '../src/modules/reports/report-registry';
import type { ReportContext } from '../src/modules/reports/report.types';

const prisma = new PrismaClient();

async function main() {
  const locations = await prisma.location.findMany({ select: { id: true } });
  const locationIds = locations.map((l) => l.id);
  const to = new Date();
  const from = new Date(to.getTime() - 365 * 24 * 60 * 60 * 1000);

  const ctx = {
    prisma: prisma as unknown as ReportContext['prisma'],
    user: { userId: 1n, email: '', roles: [], locationIds },
    locationIds,
    from,
    to,
    bucket: 'day',
    page: 1,
    pageSize: 1000,
  } as ReportContext;

  const problems: string[] = [];
  const eq = (label: string, a: number, b: number) => {
    // so sánh tiền với sai số 0.01 cho phép làm tròn Decimal
    const ok = Math.abs(a - b) < 0.01;
    console.log(`${ok ? '✓' : '✗'} ${label.padEnd(46)} báo cáo=${a}  nguồn=${b}`);
    if (!ok) problems.push(label);
  };

  // --- Nguồn sự thật: aggregate thẳng trên orders, cùng điều kiện lọc ---
  const where = {
    status: { not: 'cancelled' as const },
    createdOn: { gte: from, lt: to },
    locationId: { in: locationIds },
  };
  const src = await prisma.order.aggregate({
    where,
    _count: true,
    _sum: { totalPrice: true, subTotalPrice: true, totalReceived: true, totalDiscounts: true },
  });

  const byTime = await getReport('doanh-thu-theo-thoi-gian')!.run(ctx);
  eq('doanh thu theo thời gian: số đơn', Number(byTime.summary.order_count), src._count);
  eq('doanh thu theo thời gian: total_price', Number(byTime.summary.total_price), Number(src._sum.totalPrice ?? 0));
  eq('doanh thu theo thời gian: tiền hàng', Number(byTime.summary.sub_total_price), Number(src._sum.subTotalPrice ?? 0));
  eq('doanh thu theo thời gian: đã thu', Number(byTime.summary.total_received), Number(src._sum.totalReceived ?? 0));

  // Mọi chiều phân tích cùng kỳ phải ra CÙNG một tổng doanh thu
  for (const id of [
    'doanh-thu-theo-chi-nhanh',
    'doanh-thu-theo-kenh-ban',
    'doanh-thu-theo-nhan-vien',
    'doanh-thu-theo-khach-hang',
    'doanh-thu-theo-thue',
  ]) {
    const r = await getReport(id)!.run(ctx);
    eq(`${id}: total_price`, Number(r.summary.total_price), Number(src._sum.totalPrice ?? 0));
    eq(`${id}: số đơn`, Number(r.summary.order_count), src._count);
  }

  // --- Đơn huỷ PHẢI bị loại ---
  const cancelled = await prisma.order.aggregate({
    where: { status: 'cancelled', createdOn: { gte: from, lt: to }, locationId: { in: locationIds } },
    _count: true,
    _sum: { totalPrice: true },
  });
  console.log(`\nĐơn huỷ trong kỳ: ${cancelled._count} đơn / ${Number(cancelled._sum.totalPrice ?? 0)}đ (phải KHÔNG nằm trong số trên)`);
  const allOrders = await prisma.order.aggregate({
    where: { createdOn: { gte: from, lt: to }, locationId: { in: locationIds } },
    _sum: { totalPrice: true },
  });
  eq(
    'tổng gồm cả đơn huỷ khác tổng báo cáo',
    Number(byTime.summary.total_price) + Number(cancelled._sum.totalPrice ?? 0),
    Number(allOrders._sum.totalPrice ?? 0),
  );

  // --- Sổ kho: tồn cuối = đầu kỳ + nhập - xuất (bất biến nội tại của báo cáo) ---
  const ledger = await getReport('so-kho')!.run({ ...ctx, all: true });
  eq(
    'sổ kho: tồn cuối = đầu kỳ + nhập - xuất',
    Number(ledger.summary.closing),
    Number(ledger.summary.opening) + Number(ledger.summary.qty_in) - Number(ledger.summary.qty_out),
  );

  // Sổ kho dựng từ ledger `inventory_movements`, còn màn tồn kho đọc `inventory_levels`.
  // Hai nguồn lệch nhau là lỗi DỮ LIỆU (xem scripts/audit-flows.js), không phải lỗi báo cáo
  // — cảnh báo chứ không fail, vì báo cáo vẫn phản ánh đúng ledger.
  const levels = await prisma.inventoryLevel.aggregate({
    where: { locationId: { in: locationIds } },
    _sum: { onHand: true },
  });
  const levelsTotal = Number(levels._sum.onHand ?? 0);
  const ledgerTotal = Number(ledger.summary.closing);
  if (Math.abs(levelsTotal - ledgerTotal) >= 0.01) {
    console.log(
      `\n⚠  Dữ liệu lệch (KHÔNG phải lỗi báo cáo): ledger on_hand=${ledgerTotal} nhưng ` +
        `inventory_levels.on_hand=${levelsTotal}. Màn tồn kho và sổ kho sẽ hiện số khác nhau.\n` +
        `   Chạy scripts/audit-flows.js để xem chi tiết.`,
    );
  }

  // --- Lợi nhuận: lãi gộp = doanh thu - giá vốn ---
  const profit = await getReport('loi-nhuan-tong-hop')!.run(ctx);
  eq(
    'lợi nhuận: lãi gộp = doanh thu - giá vốn',
    Number(profit.summary.profit),
    Number(profit.summary.revenue) - Number(profit.summary.cost),
  );

  console.log(problems.length ? `\n❌ ${problems.length} chỗ lệch` : '\n✅ Tất cả khớp nguồn');
  process.exitCode = problems.length ? 1 : 0;
}

main().finally(() => prisma.$disconnect());
