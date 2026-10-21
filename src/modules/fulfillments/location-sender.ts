/**
 * Tên + SĐT người gửi của một kho, dùng khi tạo vận đơn: chụp vào `origin_*` của
 * vận đơn (phiếu giao in từ đây) và gửi sang hãng (VTP SENDER_FULLNAME/PHONE).
 *
 * Sapo in thẳng tên chi nhánh; app tách riêng `sender_name`/`sender_phone` để tên
 * kho nội bộ ("Kho Đồ Da") không lộ ra với khách. Trống thì lùi về name/phone kho.
 */
export function locationSender(loc: {
  name: string;
  phone: string | null;
  senderName: string | null;
  senderPhone: string | null;
}): { name: string; phone: string | null } {
  return {
    name: loc.senderName?.trim() || loc.name,
    phone: loc.senderPhone?.trim() || loc.phone,
  };
}
