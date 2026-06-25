export type PricedLine = {
  quantity: number;
  price: number;
  discount?: number;
};

export type OrderTotals = {
  subtotal: number;
  taxTotal: number;
  totalAmount: number;
  totalQuantity: number;
};

export function calcLineTotal(line: PricedLine): number {
  return line.quantity * line.price - (line.discount ?? 0);
}

export function calcOrderTotals(
  lines: PricedLine[],
  discountTotal = 0,
  shippingFee = 0,
  taxRate = 0,
): OrderTotals {
  const subtotal = lines.reduce((s, l) => s + calcLineTotal(l), 0);
  const taxable = Math.max(0, subtotal - discountTotal);
  const taxTotal = Math.round(taxable * taxRate);
  const totalAmount = taxable + taxTotal + shippingFee;
  const totalQuantity = lines.reduce((s, l) => s + l.quantity, 0);
  return { subtotal, taxTotal, totalAmount, totalQuantity };
}

/** Khôi phục tỷ lệ thuế từ totals đã lưu khi client không gửi tax_rate */
export function deriveTaxRate(
  subtotal: number,
  discountTotal: number,
  taxTotal: number,
): number {
  const taxable = Math.max(0, subtotal - discountTotal);
  if (taxable <= 0 || taxTotal <= 0) return 0;
  return taxTotal / taxable;
}
