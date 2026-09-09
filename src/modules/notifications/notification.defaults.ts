import { NotificationTopic } from '@prisma/client';

/**
 * Người nhận mặc định cho từng topic — nguồn duy nhất, dùng chung cho `prisma/seed.ts`
 * (cài mới) và `scripts/seed-notification-config.ts` (DB đã có dữ liệu thật). Trước đây
 * hai file giữ hai bản chép tay giống hệt nhau; thêm topic mà quên một bên thì topic đó
 * im lặng vĩnh viễn vì `emit()` coi "chưa có dòng cấu hình" là TẮT.
 *
 * ⚠️ `recipientPermissions` ghép bằng **VÀ**, không phải HOẶC — xem
 * `RbacService.usersWithPermissions()`: `keys.every(...)`. Khai hai quyền nghĩa là chỉ ai
 * có ĐỦ CẢ HAI mới nhận, tức là THU HẸP người nhận chứ không mở rộng. Muốn gửi cho hai
 * nhóm khác nhau thì phải chọn một quyền mà cả hai nhóm đều có, không phải liệt kê ra.
 * (Admin luôn nhận mọi topic, không phụ thuộc danh sách này.)
 *
 * Nguyên tắc chọn người nhận: gửi cho người PHẢI LÀM GÌ ĐÓ khi sự kiện xảy ra, không gửi
 * cho mọi người nhìn thấy được đối tượng. `order:view` là quyền xem — dùng nó làm người
 * nhận thì mua hàng, quản lý, bán hàng đều nhận tin đóng gói không liên quan.
 */
export const NOTIFICATION_SETTING_DEFAULTS: {
  topic: NotificationTopic;
  recipientPermissions: string[];
}[] = [
  // Đơn về là việc của người đóng gói. 100% đơn 10 ngày qua là đơn sàn (421 TikTok +
  // 183 Shopee, 0 đơn tự tạo) — sàn đã chốt đơn xong, không ai khác phải quyết định gì.
  { topic: 'orders_create', recipientPermissions: ['order:pack'] },
  { topic: 'orders_paid', recipientPermissions: ['order:view'] },
  // Huỷ đơn: người cần biết gấp là người đang giữ kiện hàng, phải chặn trước khi hãng lấy.
  { topic: 'orders_cancelled', recipientPermissions: ['order:pack'] },
  { topic: 'orders_fulfilled', recipientPermissions: ['order:view'] },
  { topic: 'fulfillments_create', recipientPermissions: ['order:pack'] },
  { topic: 'fulfillments_update', recipientPermissions: ['order:pack'] },
  // Phiếu hoàn/trả là việc của CSKH chứ không phải của mọi người xem được đơn.
  { topic: 'refunds_create', recipientPermissions: ['order_return:manage'] },
  { topic: 'customers_create', recipientPermissions: ['customer:view'] },
  // Cảnh báo tồn kho — hai việc thuộc hai bộ phận khác nhau nên người nhận khác nhau:
  // "cần nhập hàng" là việc của mua hàng, "âm kho" là việc của nhân viên kho.
  { topic: 'inventory_low_stock', recipientPermissions: ['purchasing:manage'] },
  { topic: 'inventory_negative', recipientPermissions: ['inventory:view'] },
  // Đơn thiếu hàng: cách xử lý là nhập thêm hoặc điều chuyển từ kho khác — cùng một quyết
  // định với "cần nhập hàng" nên cùng người nhận. KHÔNG thêm `inventory:transfer` vào đây:
  // ghép VÀ sẽ chỉ còn ai có cả hai quyền, tức là ít người hơn chứ không nhiều hơn.
  { topic: 'orders_out_of_stock', recipientPermissions: ['purchasing:manage'] },
  // Kênh bán chết là việc của người quản trị kết nối, không phải của nghiệp vụ.
  { topic: 'channel_sync_failed', recipientPermissions: ['api_key:manage'] },
];
