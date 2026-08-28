import {
  OrderFinancialStatus,
  OrderRefundStatus,
  OrderRestockStatus,
  OrderReturnStatus,
  Prisma,
  RestockType,
} from '@prisma/client';

/**
 * Tính lại `return_status` / `refund_status` / `restock_status` của đơn từ toàn
 * bộ bản ghi `order_refunds` — đúng cách Sapo suy ra 3 trường này.
 *
 * Dùng chung cho cả hai luồng vì Sapo cũng dùng chung bảng `refunds`:
 *  - trả hàng: refund có `return_id`, dòng hàng `restock_type` = return_item/no_restock
 *  - huỷ đơn:  refund không có `return_id`, dòng hàng `restock_type` = cancel
 *
 * Dòng `cancel` KHÔNG tính vào `return_status` (hàng chưa từng ra khỏi kho nên
 * không phải "khách trả"), nhưng vẫn tính vào `refund_status` (tiền có trả lại).
 */
export async function recomputeOrderRefundStatuses(
  tx: Prisma.TransactionClient,
  orderId: bigint,
) {
  const order = await tx.order.findUniqueOrThrow({
    where: { id: orderId },
    select: { totalPrice: true, items: { select: { quantity: true } } },
  });
  const totalOrderedQty = order.items.reduce((s, i) => s + i.quantity, 0);

  const lines = await tx.orderRefundLineItem.findMany({
    where: { refund: { orderId } },
    select: { quantity: true, restockType: true },
  });

  // --- return_status: chỉ đếm hàng khách thực sự trả về ---
  const returnedQty = lines
    .filter((l) => l.restockType !== RestockType.cancel)
    .reduce((s, l) => s + l.quantity, 0);
  const returnStatus =
    returnedQty === 0
      ? OrderReturnStatus.no_return
      : returnedQty >= totalOrderedQty
        ? OrderReturnStatus.returned
        : OrderReturnStatus.in_progress;

  // --- refund_status: tính trên tổng tiền đã hoàn (mọi loại refund) ---
  const agg = await tx.orderRefund.aggregate({
    where: { orderId },
    _sum: { totalRefunded: true },
  });
  const totalRefunded = Number(agg._sum.totalRefunded ?? 0);
  const refundStatus =
    totalRefunded <= 0
      ? OrderRefundStatus.no_refund
      : totalRefunded >= Number(order.totalPrice)
        ? OrderRefundStatus.refunded
        : OrderRefundStatus.partial;

  // --- restock_status: bao nhiêu dòng thực sự được nhập lại kho ---
  const restockable = lines.filter((l) => l.restockType !== RestockType.cancel);
  const restockedQty = restockable
    .filter((l) => l.restockType === RestockType.return_item)
    .reduce((s, l) => s + l.quantity, 0);
  const restockableQty = restockable.reduce((s, l) => s + l.quantity, 0);
  const restockStatus =
    restockableQty === 0 || restockedQty === 0
      ? OrderRestockStatus.no_restock
      : restockedQty >= restockableQty
        ? OrderRestockStatus.restocked
        : OrderRestockStatus.partial;

  // --- financial_status: tiền đã hoàn ghi đè trạng thái thu ---
  // Trước đây chỉ luồng huỷ đơn tự set trường này, còn luồng trả hàng thì không —
  // đơn hoàn tiền toàn bộ qua phiếu trả vẫn hiện `paid`. Cùng một sự kiện (tiền chạy
  // ngược về khách) nên phải suy ở một chỗ cho cả hai. `totalRefunded === 0` thì
  // KHÔNG đụng tới, để nguyên pending/partially_paid/paid do đường thanh toán quản.
  const financialStatus =
    totalRefunded <= 0
      ? undefined
      : totalRefunded >= Number(order.totalPrice)
        ? OrderFinancialStatus.refunded
        : OrderFinancialStatus.partially_refunded;

  await tx.order.update({
    where: { id: orderId },
    data: {
      returnStatus,
      refundStatus,
      restockStatus,
      ...(financialStatus ? { financialStatus } : {}),
    },
  });

  return {
    returnStatus,
    refundStatus,
    restockStatus,
    financialStatus,
    totalRefunded,
  };
}
