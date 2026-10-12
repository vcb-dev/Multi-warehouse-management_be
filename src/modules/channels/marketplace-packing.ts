import { PackingStatus, ShipmentStatus } from '@prisma/client';

/**
 * Trạng thái đóng gói của vận đơn đơn sàn (TikTok/Shopee) sau một lần đồng bộ.
 *
 * Sàn không biết kho đã gói hàng hay chưa — nó chỉ biết kiện đã được tạo. Vì vậy
 * `packed_status` là của KHO (màn "In & đóng gói"), đồng bộ không được ghi đè:
 * trước đây mỗi lần đồng bộ lại chép "đã đóng gói" theo sàn, xoá mất thao tác
 * của kho và làm tab "Chưa đóng gói" không bao giờ có đơn TikTok.
 *
 * Ngoại lệ duy nhất: hãng đã cầm hàng thì kiện chắc chắn đã gói xong, kể cả khi
 * kho quên bấm — để "chờ đóng gói" ở một kiện đang trên đường giao là vô nghĩa.
 */
export function syncedPackedStatus(
  shipmentStatus: ShipmentStatus | null,
  current: PackingStatus | null | undefined,
): PackingStatus {
  const waitingInWarehouse =
    shipmentStatus === null ||
    shipmentStatus === ShipmentStatus.pending ||
    shipmentStatus === ShipmentStatus.cancelled;
  if (!waitingInWarehouse) return PackingStatus.packed;
  return current ?? PackingStatus.unknown;
}
