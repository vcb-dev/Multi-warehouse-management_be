/** Tiền khách thực chi: đã thu − hoàn. Lấy max(cột Sapo, tổng phiếu OMS) từng đơn để không đếm 2 lần cũng không sót. */
export function netCustomerSpent(
  orders: {
    totalReceived: unknown;
    totalRefunded: unknown;
    refunds: { totalRefunded: unknown }[];
  }[],
): number {
  return orders.reduce((sum, o) => {
    const received = Number(o.totalReceived ?? 0);
    const fromRows = o.refunds.reduce(
      (s, r) => s + Number(r.totalRefunded ?? 0),
      0,
    );
    const fromCol = Number(o.totalRefunded ?? 0);
    return sum + Math.max(0, received - Math.max(fromRows, fromCol));
  }, 0);
}
