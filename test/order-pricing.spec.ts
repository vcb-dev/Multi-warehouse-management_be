import { calcOrderTotals } from '../src/modules/orders/order-pricing';

describe('order-pricing', () => {
  it('tính subtotal và total', () => {
    const t = calcOrderTotals(
      [{ quantity: 2, price: 100000 }],
      0,
      20000,
    );
    expect(t.subtotal).toBe(200000);
    expect(t.totalAmount).toBe(220000);
  });
});
