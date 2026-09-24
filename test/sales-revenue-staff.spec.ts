import { Prisma } from '@prisma/client';
import { getReport } from '../src/modules/reports/report-registry';
import type { ReportContext } from '../src/modules/reports/report.types';
import { toStaffRevenueRow } from '../src/modules/reports/reports/sales-revenue.report';

describe('Doanh thu theo nhân viên — tách tiền hàng / huỷ / hoàn', () => {
  const report = getReport('sales-revenue-by-staff')!;

  it('có đủ 3 cột tiền Yến Ngọc yêu cầu và chart trỏ đúng key', () => {
    const keys = report.columns.map((c) => c.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        'sub_total_price',
        'cancelled_amount',
        'total_refunded',
        'cancelled_count',
        'returned_count',
      ]),
    );
    expect(report.chart?.y).toEqual([
      'sub_total_price',
      'cancelled_amount',
      'total_refunded',
    ]);
  });

  it('công thức dòng: doanh thu thuần = doanh thu − hoàn, không trừ huỷ', () => {
    const row = toStaffRevenueRow({
      label: 'An',
      order_count: 2,
      cancelled_count: 1,
      returned_count: 1,
      sub_total_price: new Prisma.Decimal(270),
      total_discounts: new Prisma.Decimal(10),
      total_tax: new Prisma.Decimal(0),
      total_shipping_price: new Prisma.Decimal(20),
      // 2 đơn còn hiệu lực: 100 + 200
      total_price: new Prisma.Decimal(300),
      // 1 đơn huỷ trước giao: 80 — tách riêng, không nằm trong total_price
      cancelled_amount: new Prisma.Decimal(80),
      // hoàn sau giao của 1 đơn còn hiệu lực
      total_refunded: new Prisma.Decimal(50),
      total_received: new Prisma.Decimal(180),
    });

    expect(row.sub_total_price).toBe(270);
    expect(row.cancelled_count).toBe(1);
    expect(row.returned_count).toBe(1);
    expect(row.cancelled_amount).toBe(80);
    expect(row.total_refunded).toBe(50);
    expect(row.total_price).toBe(300);
    expect(row.net_revenue).toBe(250);
    expect(row.outstanding).toBe(120);
  });

  it('run() map raw SQL → dòng + tổng cộng đúng công thức', async () => {
    const raw = [
      {
        label: 'An',
        order_count: 2n,
        cancelled_count: 1n,
        returned_count: 1n,
        sub_total_price: new Prisma.Decimal(270),
        total_discounts: new Prisma.Decimal(10),
        total_tax: new Prisma.Decimal(0),
        total_shipping_price: new Prisma.Decimal(20),
        total_price: new Prisma.Decimal(300),
        cancelled_amount: new Prisma.Decimal(80),
        total_refunded: new Prisma.Decimal(50),
        total_received: new Prisma.Decimal(180),
      },
      {
        label: '(Chưa gán)',
        order_count: 1n,
        cancelled_count: 2n,
        returned_count: 0n,
        sub_total_price: new Prisma.Decimal(40),
        total_discounts: new Prisma.Decimal(0),
        total_tax: new Prisma.Decimal(0),
        total_shipping_price: new Prisma.Decimal(0),
        total_price: new Prisma.Decimal(40),
        cancelled_amount: new Prisma.Decimal(90),
        total_refunded: new Prisma.Decimal(0),
        total_received: new Prisma.Decimal(0),
      },
    ];
    const prisma = { $queryRaw: jest.fn().mockResolvedValue(raw) };
    const ctx = {
      prisma,
      user: { userId: 1n, email: '', roles: [], locationIds: [1n] },
      locationIds: [1n],
      from: new Date('2026-09-01'),
      to: new Date('2026-09-22'),
      bucket: 'day',
      page: 1,
      pageSize: 20,
    } as unknown as ReportContext;

    const result = await report.run(ctx);

    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].net_revenue).toBe(250);
    expect(result.summary.order_count).toBe(3);
    expect(result.summary.cancelled_count).toBe(3);
    expect(result.summary.returned_count).toBe(1);
    expect(result.summary.sub_total_price).toBe(310);
    expect(result.summary.cancelled_amount).toBe(170);
    expect(result.summary.total_refunded).toBe(50);
    expect(result.summary.net_revenue).toBe(290);
  });
});
