import { Prisma } from '@prisma/client';
import { toCompletedOrderLineRow } from './completed-order-revenue.report';

const base = {
  order_name: 'SON001',
  completed_on: '07/10/2026 21:22',
  location: 'Kho Đồ Da',
  customer: null,
  product: 'Ví da',
  sku: 'VD-01',
  price: new Prisma.Decimal(500000),
  total_discount: new Prisma.Decimal(100000),
  revenue: new Prisma.Decimal(900000),
  unit_cost: new Prisma.Decimal(200000),
  total: 1,
};

describe('toCompletedOrderLineRow', () => {
  it('tổng giá vốn = giá vốn đơn vị × số lượng, lãi gộp = doanh thu − tổng giá vốn', () => {
    const row = toCompletedOrderLineRow({ ...base, quantity: 2 });
    expect(row.cost).toBe(400000);
    expect(row.profit).toBe(500000);
  });

  it('thiếu giá vốn thì coi là 0, khách trống thì ghi Khách lẻ', () => {
    const row = toCompletedOrderLineRow({ ...base, quantity: 1, unit_cost: null });
    expect(row.cost).toBe(0);
    expect(row.profit).toBe(900000);
    expect(row.customer).toBe('(Khách lẻ)');
  });
});
