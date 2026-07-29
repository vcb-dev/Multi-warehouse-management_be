export type PricedLine = {
  quantity: number;
  price: number;
  discount?: number;
};

/** Tên field theo Sapo Order (sub_total_price / total_tax / total_price / ...) */
export type OrderTotals = {
  subTotalPrice: number;
  totalTax: number;
  totalPrice: number;
  subtotalLineItemsQuantity: number;
};

export function calcLineTotal(line: PricedLine): number {
  return line.quantity * line.price - (line.discount ?? 0);
}

export function calcOrderTotals(
  lines: PricedLine[],
  totalDiscounts = 0,
  totalShippingPrice = 0,
  taxRate = 0,
): OrderTotals {
  const subTotalPrice = lines.reduce((s, l) => s + calcLineTotal(l), 0);
  const taxable = Math.max(0, subTotalPrice - totalDiscounts);
  const totalTax = Math.round(taxable * taxRate);
  const totalPrice = taxable + totalTax + totalShippingPrice;
  const subtotalLineItemsQuantity = lines.reduce((s, l) => s + l.quantity, 0);
  return { subTotalPrice, totalTax, totalPrice, subtotalLineItemsQuantity };
}

/** Khôi phục tỷ lệ thuế từ totals đã lưu khi client không gửi tax_rate */
export function deriveTaxRate(
  subTotalPrice: number,
  totalDiscounts: number,
  totalTax: number,
): number {
  const taxable = Math.max(0, subTotalPrice - totalDiscounts);
  if (taxable <= 0 || totalTax <= 0) return 0;
  return totalTax / taxable;
}
