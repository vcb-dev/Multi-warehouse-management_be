import { OrderStatus, Prisma, ShipmentStatus } from '@prisma/client';

/**
 * Kiện hàng còn "đang trên đường": đã tạo nhưng chưa tới kết cục (giao xong,
 * hoàn về, huỷ). Theo Sapo, đơn có kiện là `fulfillment_status = fulfilled`
 * ngay từ lúc tạo kiện — nên "đã giao xong" KHÔNG suy được từ `fulfilled` nữa,
 * phải loại các đơn còn kiện kiểu này.
 *
 * Nhánh `shipmentStatus = null` là phiếu mới ở bước đóng gói của app (chưa đẩy
 * vận chuyển). Phiếu `pick_up` của Sapo (khách nhận tại cửa hàng) cũng có
 * `shipment_status` NULL nhưng là giao xong, nên phải loại ra bằng `deliveryMethod`.
 */
export const IN_FLIGHT_FULFILLMENT_WHERE: Prisma.FulfillmentWhereInput = {
  status: { not: 'cancelled' },
  OR: [
    {
      shipmentStatus: {
        in: [
          ShipmentStatus.pending,
          ShipmentStatus.picked_up,
          ShipmentStatus.delivering,
          ShipmentStatus.retry_delivery,
          ShipmentStatus.returning,
        ],
      },
    },
    { shipmentStatus: null, closedAt: null, deliveryMethod: null },
  ],
};

/**
 * Đóng đơn ("Hoàn thành") nếu đã ĐỦ cả hai vế như Sapo: giao xong và thu đủ
 * tiền. Gọi sau khi khoản thanh toán cuối về; vế còn lại (giao xong khi tiền đã
 * đủ) nằm ở `FulfillmentService.applyShipmentStatus`.
 *
 * Chỉ áp cho đơn giao qua vận đơn. Đơn xuất hàng thẳng (không vận đơn) vẫn
 * đóng bằng thao tác "Hoàn thành" thủ công như trước.
 */
export async function closeOrderIfDeliveredAndPaid(
  tx: Prisma.TransactionClient,
  orderId: bigint,
): Promise<boolean> {
  const delivered = await tx.fulfillment.count({
    where: {
      orderId,
      status: { not: 'cancelled' },
      shipmentStatus: ShipmentStatus.delivered,
    },
  });
  if (!delivered) return false;
  const inFlight = await tx.fulfillment.count({
    where: { orderId, ...IN_FLIGHT_FULFILLMENT_WHERE },
  });
  if (inFlight) return false;
  const now = new Date();
  const { count } = await tx.order.updateMany({
    where: { id: orderId, status: OrderStatus.open },
    data: { status: OrderStatus.closed, closedOn: now, completedOn: now },
  });
  return count > 0;
}
