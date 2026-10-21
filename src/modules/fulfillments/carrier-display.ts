/**
 * Tên đơn vị giao hàng để hiển thị trên UI.
 *
 * Vì sao cần hàm này thay vì đọc thẳng `provider.name`: `provider_id` chỉ có với hãng
 * TÍCH HỢP trong app (ViettelPost — do mình đẩy đơn sang). Đơn đồng bộ từ Sapo thì
 * hãng đã do sàn/Sapo chỉ định nên `provider_id` luôn NULL, tên hãng thật nằm ở
 * `carrier_name` ('J&T Express') hoặc `tracking_company` ('Standard shipping').
 *
 * Trên dữ liệu thật (2026-08-14) có ~69.000 vận đơn `provider_id IS NULL` mà vẫn có tên
 * hãng — đọc thẳng `provider.name` làm cột "Đối tác giao hàng" trống ở gần như mọi đơn
 * đồng bộ, dù Sapo vẫn hiện tên hãng bình thường.
 */
export function carrierDisplayName(f: {
  provider?: { name: string } | null;
  carrierName?: string | null;
  trackingCompany?: string | null;
  carrier?: string | null;
}): string | null {
  // Hãng tích hợp ưu tiên nhất: là bản ghi có thật trong app, tên đã chuẩn hoá.
  // Sau đó tới tên hãng do sàn trả về, cuối cùng mới tới tên dịch vụ vận chuyển.
  return (
    f.provider?.name?.trim() ||
    f.carrierName?.trim() ||
    f.trackingCompany?.trim() ||
    f.carrier?.trim() ||
    null
  );
}

/** Trang tra cứu hành trình ViettelPost — đúng mẫu Sapo ghi vào `tracking_url` (11k vận đơn VTP trong bản backup 14/09/2026). */
export function vtpTrackingUrl(trackingNumber: string): string {
  return `https://viettelpost.vn/thong-tin-don-hang?peopleTracking=sender&orderNumber=${encodeURIComponent(trackingNumber)}`;
}

/**
 * Link xem hành trình vận đơn trên trang của hãng.
 *
 * Ưu tiên `tracking_url` đã lưu (Sapo/sàn trả về). Vận đơn ViettelPost do app tạo trước
 * khi adapter ghi link thì `tracking_url` trống — dựng lại từ mã vận đơn.
 */
export function carrierTrackingUrl(f: {
  trackingUrl?: string | null;
  trackingNumber?: string | null;
  provider?: { code: string } | null;
  carrier?: string | null;
  carrierName?: string | null;
}): string | null {
  const stored = f.trackingUrl?.trim();
  if (stored) return stored;
  const trackingNumber = f.trackingNumber?.trim();
  if (!trackingNumber) return null;
  const isVtp =
    f.provider?.code === 'viettel_post' ||
    f.carrier === 'VIETTEL_POST' ||
    /viettel\s*post/i.test(f.carrierName ?? '');
  return isVtp ? vtpTrackingUrl(trackingNumber) : null;
}
