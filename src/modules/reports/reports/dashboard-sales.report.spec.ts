import {
  ClosedCell,
  CloseRate,
  buildLocationRows,
  buildStaffRows,
  derive,
  sumCells,
} from './dashboard-sales.report';

/**
 * Phần cộng gộp của màn Tổng quan: các khối (tổng, kho, nhân viên, online/quầy) đều dựng
 * từ cùng một bộ ô nên phải khớp nhau, và tỷ lệ chốt không bao giờ vượt 100%.
 */
function cell(overrides: Partial<ClosedCell>): ClosedCell {
  return {
    locationId: '1',
    staffId: '10',
    isPos: false,
    orders: 1,
    revenue: 1_000_000,
    discount: 0,
    quantity: 1,
    cost: 400_000,
    missingCost: 0,
    ...overrides,
  };
}

const CELLS: ClosedCell[] = [
  cell({
    locationId: '1',
    staffId: '10',
    orders: 3,
    revenue: 3_000_000,
    discount: 200_000,
    quantity: 4,
    cost: 1_200_000,
  }),
  cell({
    locationId: '1',
    staffId: null,
    orders: 2,
    revenue: 1_000_000,
    quantity: 2,
    cost: 0,
    missingCost: 2,
  }),
  cell({
    locationId: '2',
    staffId: '10',
    isPos: true,
    orders: 1,
    revenue: 500_000,
    discount: 50_000,
    quantity: 1,
    cost: 300_000,
  }),
];

describe('dashboard-sales', () => {
  it('dải KPI: doanh số = doanh thu + chiết khấu, các số trung bình chia cho đơn chốt', () => {
    const d = derive(sumCells(CELLS));

    expect(d.revenue).toBe(4_500_000);
    expect(d.discount).toBe(250_000);
    expect(d.gross_sales).toBe(4_750_000);
    expect(d.profit).toBe(3_000_000);
    expect(d.closed_orders).toBe(6);
    expect(d.avg_order_value).toBe(750_000);
    expect(d.items_sold).toBe(7);
    expect(d.avg_items_per_order).toBe(1.17);
    expect(d.avg_profit_per_order).toBe(500_000);
  });

  it('không có đơn chốt thì mọi số trung bình là 0 chứ không NaN', () => {
    const d = derive(sumCells([]));

    expect(d.avg_order_value).toBe(0);
    expect(d.avg_items_per_order).toBe(0);
    expect(d.avg_profit_per_order).toBe(0);
  });

  it('online + tại quầy = tổng', () => {
    const total = sumCells(CELLS);
    const pos = sumCells(CELLS, (c) => c.isPos);
    const online = sumCells(CELLS, (c) => !c.isPos);

    expect(pos.revenue).toBe(500_000);
    expect(pos.revenue + online.revenue).toBe(total.revenue);
    expect(pos.orders + online.orders).toBe(total.orders);
  });

  it('bảng kho: cộng các kho ra đúng tổng, xếp theo doanh thu, giữ kho chỉ có số kỳ trước', () => {
    const prev = [cell({ locationId: '3', revenue: 900_000 })];
    const rows = buildLocationRows(CELLS, prev, [
      { id: '1', name: 'Kho A' },
      { id: '2', name: 'Kho B' },
    ]);

    expect(rows.map((r) => r.name)).toEqual([
      'Kho A',
      'Kho B',
      '(Không xác định)',
    ]);
    expect(rows.reduce((s, r) => s + r.revenue.value, 0)).toBe(4_500_000);
    expect(rows[0].closed_orders.value).toBe(5);
    expect(rows[0].avg_order_value.value).toBe(800_000);
    expect(rows[2].revenue).toEqual({
      value: 0,
      previous: 900_000,
      change_pct: -100,
    });
  });

  it('bảng nhân viên: đơn không gán gom vào "Hệ thống" và không có tỷ lệ chốt', () => {
    const rates = new Map<string, CloseRate>([['10', { total: 8, closed: 4 }]]);
    const prevRates = new Map<string, CloseRate>([
      ['10', { total: 10, closed: 4 }],
    ]);
    const rows = buildStaffRows(CELLS, [], rates, prevRates, [
      { id: '10', name: 'Linh' },
    ]);

    expect(rows.map((r) => r.name)).toEqual(['Linh', 'Hệ thống']);
    expect(rows[0].revenue.value).toBe(3_500_000);
    expect(rows[0].close_rate).toEqual({
      value: 50,
      previous: 40,
      change_pct: 25,
    });
    expect(rows[1].staff_id).toBeNull();
    expect(rows[1].close_rate).toBeNull();
    expect(rows.reduce((s, r) => s + r.revenue.value, 0)).toBe(4_500_000);
  });

  it('nhân viên có đơn phát sinh nhưng chưa chốt đơn nào vẫn hiện với tỷ lệ 0%', () => {
    const rates = new Map<string, CloseRate>([['11', { total: 3, closed: 0 }]]);
    const rows = buildStaffRows([], [], rates, new Map(), [
      { id: '11', name: 'Mai' },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0].closed_orders.value).toBe(0);
    expect(rows[0].close_rate?.value).toBe(0);
  });
});
