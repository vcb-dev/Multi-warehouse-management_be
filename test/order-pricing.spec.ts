import { calcOrderTotals } from '../src/modules/orders/order-pricing';

describe('order-pricing', () => {
  it('tính subtotal và total', () => {
    const t = calcOrderTotals(
      [{ quantity: 2, price: 100000 }],
      0,
      20000,
    );
    expect(t.subTotalPrice).toBe(200000);
    expect(t.totalPrice).toBe(220000);
  });
});
