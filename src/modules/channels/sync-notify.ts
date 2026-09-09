import { OrderStatus } from '@prisma/client';

/**
 * Chốt chặn chống ngập chuông cho mọi luồng đồng bộ kênh bán.
 *
 * Vấn đề chung của cả ba luồng (Sapo / TikTok đơn / TikTok hoàn): một lượt sync bù khoảng
 * đã hụt kéo về hàng nghìn bản ghi cũ cùng lúc. Không có chặn này thì mỗi nhân viên nhận
 * vài nghìn thông báo về việc đã xảy ra từ tháng trước — chuông thành vô dụng vĩnh viễn.
 *
 * Hằng số nằm riêng ở đây vì trước đó đã bị chép ra hai chỗ; thêm luồng thứ ba là chắc chắn
 * có bản lệch nhau khi ai đó chỉnh một nơi.
 */
export const SYNC_NOTIFY_MAX_AGE_HOURS = Number(
  process.env.SYNC_NOTIFY_MAX_AGE_HOURS ?? 24,
);

/**
 * Sự kiện có đủ mới để bắn thông báo không.
 *
 * `at` phải là thời điểm **sự kiện xảy ra**, không phải thời điểm sync thấy nó: đơn đặt
 * tuần trước nhưng vừa huỷ sáng nay thì mốc so là lúc huỷ, nên vẫn báo.
 *
 * Không có mốc thời gian ⇒ không báo. Thà thiếu một thông báo còn hơn coi bản ghi thiếu dữ
 * liệu là "vừa xảy ra" và dội cả lượt backfill vào chuông.
 */
export function isWithinNotifyWindow(
  at: Date | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!at) return false;
  return (now - at.getTime()) / 3_600_000 <= SYNC_NOTIFY_MAX_AGE_HOURS;
}

/**
 * Đơn vừa chuyển sang trạng thái huỷ ⇒ có bắn `orders/cancelled` không.
 *
 * Bốn điều kiện, thiếu một cái là hỏng theo bốn kiểu khác nhau:
 *
 * 1. `next.status` phải là `cancelled` — hiển nhiên.
 * 2. `previousStatus` phải KHÁC `cancelled`. Sync sàn quét lại theo `update_time` và
 *    webhook còn đẩy lại từng đơn, nên đơn đã huỷ sẵn trong DB vẫn đi qua đây đều đặn;
 *    bỏ vế này là mỗi đơn huỷ bắn thông báo mãi mãi.
 * 3. `hasFulfillment` — phải CÓ kiện hàng thật thì mới đáng báo. Phần lớn trong 22 đơn
 *    huỷ mỗi ngày là khách huỷ trước khi kho đóng gói: sàn tự xử lý xong, không ai phải
 *    động tay. Chỉ khi vận đơn đã tồn tại mới có việc để làm — chặn kiện trước khi hãng
 *    lấy. Đây là vế biến thông báo này từ "tin để biết" thành "việc phải làm".
 * 4. Việc huỷ phải vừa xảy ra — xem {@link isWithinNotifyWindow}. Lần deploy đầu tiên,
 *    DB đang giữ trạng thái cũ của hàng nghìn đơn đã huỷ từ lâu; không có vế này thì lượt
 *    sync kế tiếp dội hết chỗ đó vào chuông.
 *
 * Đặt ở file dùng chung chứ không nằm trong service của một kênh: mọi kênh sàn đều có cùng
 * mô hình create/update nên phải dùng chung một quy tắc, để mỗi kênh một bản là chúng trôi
 * khỏi nhau.
 */
export function shouldNotifyCancelled(
  previousStatus: OrderStatus,
  next: { status: OrderStatus; cancelledOn?: Date | null },
  hasFulfillment: boolean,
  now: number = Date.now(),
): boolean {
  if (next.status !== OrderStatus.cancelled) return false;
  if (previousStatus === OrderStatus.cancelled) return false;
  if (!hasFulfillment) return false;
  return isWithinNotifyWindow(next.cancelledOn, now);
}
