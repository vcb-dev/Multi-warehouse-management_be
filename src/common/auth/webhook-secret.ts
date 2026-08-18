import { UnauthorizedException } from '@nestjs/common';

/**
 * Xác thực webhook của bên thứ 3 (hãng vận chuyển, sàn). Những endpoint đó đi qua
 * `@Public` nên đây là lớp bảo vệ duy nhất.
 *
 * Đóng khi THIẾU cấu hình, không phải mở: trước đây secret chỉ được kiểm "nếu có đặt
 * env", nghĩa là quên đặt biến là endpoint mở toang cho bất kỳ ai đẩy trạng thái vận
 * đơn giả — mà trạng thái giả kéo theo hủy vận đơn và hoàn tồn kho.
 *
 * Ném 401 thay vì để app chết lúc khởi động: thiếu secret của MỘT hãng không nên làm
 * sập toàn bộ API, chỉ cần đường webhook của hãng đó ngừng nhận.
 *
 * @param candidates Các vị trí secret có thể xuất hiện. Mỗi hãng đặt một kiểu — GHN
 *   dùng header riêng, ViettelPost thì tài liệu không nói rõ là header `Authorization`
 *   hay field `TOKEN` trong body, nên nhận cả hai và khớp một trong số đó là đủ.
 */
export function assertWebhookSecret(
  envKey: string,
  ...candidates: (string | undefined)[]
): void {
  const expected = process.env[envKey]?.trim();
  if (!expected) {
    throw new UnauthorizedException(
      `Webhook chưa được cấu hình (thiếu ${envKey})`,
    );
  }
  if (!candidates.some((c) => c && c === expected)) {
    throw new UnauthorizedException('Invalid webhook secret');
  }
}
