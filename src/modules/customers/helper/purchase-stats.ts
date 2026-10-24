import { OrderStatus } from '@prisma/client';
import { netCustomerSpent } from './net-customer-spent';

export interface PurchaseStats {
  orders_count: number;
  total_spent: number;
  last_order_id: string | null;
  last_order_name: string | null;
}

export const emptyPurchaseStats: PurchaseStats = {
  orders_count: 0,
  total_spent: 0,
  last_order_id: null,
  last_order_name: null,
};

export const purchaseOrderSelect = {
  customerId: true,
  status: true,
  createdOn: true,
  id: true,
  name: true,
  totalReceived: true,
  totalRefunded: true,
  refunds: { select: { totalRefunded: true } },
} as const;

export interface OrderForPurchaseStats {
  customerId: bigint | null;
  status: OrderStatus;
  createdOn: Date;
  id: bigint;
  name: string;
  totalReceived: unknown;
  totalRefunded: unknown;
  refunds: { totalRefunded: unknown }[];
}

/** Cùng quy tắc với chi tiết khách: số đơn bỏ huỷ; chi tiêu = thu − hoàn mọi đơn. */
export function purchaseStatsFromOrders(
  orders: OrderForPurchaseStats[],
): PurchaseStats {
  // Lọc ra các đơn hàng không bị huỷ
  const active = orders.filter((o) => o.status !== OrderStatus.cancelled);
  // Tìm đơn hàng mới nhất
  let last: OrderForPurchaseStats | undefined;
  // Duyệt qua các đơn hàng hoạt động và tìm đơn hàng mới nhất
  for (const o of active) {
    if (!last || o.createdOn > last.createdOn) last = o;
  }
  return {
    orders_count: active.length,
    total_spent: netCustomerSpent(orders),
    last_order_id: last?.id.toString() ?? null,
    last_order_name: last?.name ?? null,
  };
}
/** Lấy thông tin chi tiết về tổng số đơn và tổng chi tiêu của từng khách hàng
 * List — một trang ~20 khách, không query từng người (N+1). Một query: “mọi đơn của các id trên trang này”, rồi chia nhóm theo customerId
 */
export function purchaseStatsByCustomerId(
  orders: OrderForPurchaseStats[],
): Map<string, PurchaseStats> {
  const grouped = new Map<string, OrderForPurchaseStats[]>();
  for (const o of orders) {
    if (o.customerId == null) continue;
    const key = o.customerId.toString();
    const list = grouped.get(key);
    if (list) list.push(o);
    else grouped.set(key, [o]);
  }
  const out = new Map<string, PurchaseStats>();
  for (const [id, rows] of grouped) {
    out.set(id, purchaseStatsFromOrders(rows));
  }
  return out;
}
