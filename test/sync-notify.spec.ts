/**
 * Chốt chặn chống ngập chuông của các luồng đồng bộ kênh bán.
 * Chạy: npm test -- test/sync-notify.spec.ts
 *
 * Đây là thứ đứng giữa "thông báo hữu ích" và "vài nghìn thông báo về việc xảy ra từ tháng
 * trước". Cả ba luồng sync (Sapo, đơn TikTok, hoàn TikTok) đều đi qua đúng hàm này.
 */
import { OrderStatus } from '@prisma/client';
import {
  SYNC_NOTIFY_MAX_AGE_HOURS,
  isWithinNotifyWindow,
  shouldNotifyCancelled,
} from '../src/modules/channels/sync-notify';

const NOW = new Date('2026-09-09T12:00:00Z').getTime();
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000);

describe('isWithinNotifyWindow', () => {
  it('mặc định cửa sổ 24 giờ khi không set biến môi trường', () => {
    expect(SYNC_NOTIFY_MAX_AGE_HOURS).toBe(24);
  });

  it('sự kiện vừa xảy ra thì báo', () => {
    expect(isWithinNotifyWindow(hoursAgo(0.5), NOW)).toBe(true);
  });

  it('đúng biên vẫn báo, quá biên thì thôi', () => {
    expect(isWithinNotifyWindow(hoursAgo(24), NOW)).toBe(true);
    expect(isWithinNotifyWindow(hoursAgo(24.1), NOW)).toBe(false);
  });

  it('backfill tháng trước bị chặn — đây là lý do hàm này tồn tại', () => {
    expect(isWithinNotifyWindow(hoursAgo(24 * 30), NOW)).toBe(false);
  });

  it('không có mốc thời gian thì KHÔNG báo, chứ không coi là vừa xảy ra', () => {
    // Ngược lại sẽ là lỗi tệ nhất có thể: mọi bản ghi thiếu dữ liệu đều thành thông báo.
    expect(isWithinNotifyWindow(null, NOW)).toBe(false);
    expect(isWithinNotifyWindow(undefined, NOW)).toBe(false);
  });
});

describe('shouldNotifyCancelled', () => {
  const cancelled = (cancelledOn: Date | null) => ({
    status: OrderStatus.cancelled,
    cancelledOn,
  });
  /** Ký hiệu cho vế "đơn đã có kiện hàng thật". */
  const CO_VAN_DON = true;
  const CHUA_DONG_GOI = false;

  it('đơn đã có vận đơn mà vừa bị huỷ: báo', () => {
    expect(
      shouldNotifyCancelled(
        OrderStatus.open,
        cancelled(hoursAgo(1)),
        CO_VAN_DON,
        NOW,
      ),
    ).toBe(true);
  });

  it('đơn chưa đóng gói mà huỷ: KHÔNG báo', () => {
    // Phần lớn trong 22 đơn huỷ/ngày rơi vào đây — khách huỷ trước khi kho động tay,
    // sàn tự xử lý xong. Báo thì chỉ là tin để biết, không phải việc phải làm.
    expect(
      shouldNotifyCancelled(
        OrderStatus.open,
        cancelled(hoursAgo(1)),
        CHUA_DONG_GOI,
        NOW,
      ),
    ).toBe(false);
  });

  it('đơn đã cancelled sẵn trong DB: KHÔNG báo lại', () => {
    // Cron 30 phút và webhook quét lại đơn cũ liên tục — thiếu vế này là báo mãi mãi.
    expect(
      shouldNotifyCancelled(
        OrderStatus.cancelled,
        cancelled(hoursAgo(1)),
        CO_VAN_DON,
        NOW,
      ),
    ).toBe(false);
  });

  it('đơn vẫn đang mở: không có gì để báo', () => {
    expect(
      shouldNotifyCancelled(
        OrderStatus.open,
        { status: OrderStatus.open, cancelledOn: null },
        CO_VAN_DON,
        NOW,
      ),
    ).toBe(false);
  });

  it('closed → cancelled cũng là chuyển trạng thái, vẫn báo', () => {
    expect(
      shouldNotifyCancelled(
        OrderStatus.closed,
        cancelled(hoursAgo(2)),
        CO_VAN_DON,
        NOW,
      ),
    ).toBe(true);
  });

  it('đơn huỷ từ tháng trước mà DB còn giữ trạng thái cũ: KHÔNG báo', () => {
    // Đúng tình huống của lần deploy đầu tiên — DB có 5.717 đơn TikTok đã huỷ mà chưa
    // từng sinh thông báo nào; không chặn thì lượt sync kế tiếp dội hết vào chuông.
    expect(
      shouldNotifyCancelled(
        OrderStatus.open,
        cancelled(hoursAgo(24 * 30)),
        CO_VAN_DON,
        NOW,
      ),
    ).toBe(false);
  });

  it('cancelled nhưng TikTok không trả mốc huỷ: không báo', () => {
    expect(
      shouldNotifyCancelled(OrderStatus.open, cancelled(null), CO_VAN_DON, NOW),
    ).toBe(false);
  });
});
