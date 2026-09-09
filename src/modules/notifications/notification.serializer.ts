import {
  Notification,
  NotificationRecipient,
  NotificationSetting,
  NotificationTopic,
} from '@prisma/client';

/**
 * Nhãn tiếng Việt cho từng topic. Key là giá trị enum Prisma (`orders_create`),
 * còn giá trị lưu DB / trả ra wire là chuỗi Sapo (`orders/create`) — xem
 * `NotificationTopic` trong schema.prisma.
 */
export const NOTIFICATION_TOPIC_LABELS: Record<NotificationTopic, string> = {
  orders_create: 'Đơn hàng mới',
  orders_paid: 'Đơn hàng đã thanh toán',
  orders_cancelled: 'Đơn hàng bị hủy',
  orders_fulfilled: 'Đơn hàng đã giao xong',
  fulfillments_create: 'Vận đơn mới',
  fulfillments_update: 'Cập nhật vận đơn',
  refunds_create: 'Hoàn tiền',
  customers_create: 'Khách hàng mới',
  inventory_low_stock: 'Cần nhập hàng',
  inventory_negative: 'Âm kho',
  orders_out_of_stock: 'Đơn thiếu hàng',
  channel_sync_failed: 'Đồng bộ kênh lỗi',
};

/** Nhóm hiển thị ở /settings/notifications — chia theo đúng cách Sapo chia Cấu hình > Thông báo. */
export const NOTIFICATION_TOPIC_GROUPS: Record<NotificationTopic, string> = {
  orders_create: 'Đơn hàng',
  orders_paid: 'Đơn hàng',
  orders_cancelled: 'Đơn hàng',
  orders_fulfilled: 'Đơn hàng',
  fulfillments_create: 'Vận chuyển',
  fulfillments_update: 'Vận chuyển',
  refunds_create: 'Đơn hàng',
  customers_create: 'Khách hàng',
  inventory_low_stock: 'Tồn kho',
  inventory_negative: 'Tồn kho',
  orders_out_of_stock: 'Đơn hàng',
  // Nhóm riêng: đây là sức khoẻ hệ thống, không phải nghiệp vụ bán hàng.
  channel_sync_failed: 'Hệ thống',
};

/**
 * Chuỗi topic đúng như Sapo dùng ở `/admin/webhooks.json`. Prisma enum không cho phép
 * ký tự `/` trong tên thành viên nên phải map ngược lại khi trả ra wire — client và
 * (sau này) webhook Sapo cùng nói một thứ tiếng.
 */
export const TOPIC_WIRE: Record<NotificationTopic, string> = {
  orders_create: 'orders/create',
  orders_paid: 'orders/paid',
  orders_cancelled: 'orders/cancelled',
  orders_fulfilled: 'orders/fulfilled',
  fulfillments_create: 'fulfillments/create',
  fulfillments_update: 'fulfillments/update',
  refunds_create: 'refunds/create',
  customers_create: 'customers/create',
  // Hai cái dưới KHÔNG phải topic Sapo — xem ghi chú ở enum trong schema.prisma
  inventory_low_stock: 'inventory/low_stock',
  inventory_negative: 'inventory/negative',
  orders_out_of_stock: 'orders/out_of_stock',
  channel_sync_failed: 'channel/sync_failed',
};

/** Chiều ngược lại, cho param `:topic` trên URL cấu hình. */
export const TOPIC_FROM_WIRE = new Map<string, NotificationTopic>(
  Object.entries(TOPIC_WIRE).map(([k, v]) => [v, k as NotificationTopic]),
);

/**
 * Đường dẫn frontend để click vào thông báo là nhảy đúng chỗ. Trả null khi không dựng
 * được link — client render item không bấm được, thay vì điều hướng tới route 404.
 *
 * Chỉ `/orders/[id]` và `/customers/[id]` là trang chi tiết thật; vận đơn không có
 * trang riêng nên trỏ về danh sách đã lọc sẵn theo mã vận đơn (`?q=` được
 * `useQueryParams` đọc từ URL ở shipping/shipments/page.tsx).
 */
function resolveLink(
  subjectType: string,
  subjectId: bigint,
  payload: Record<string, unknown>,
): string | null {
  const orderId =
    typeof payload.order_id === 'string' ? payload.order_id : null;

  switch (subjectType) {
    case 'order':
      return `/orders/${subjectId.toString()}`;
    case 'customer':
      return `/customers/${subjectId.toString()}`;
    case 'fulfillment': {
      // Người đóng gói cần thấy vận đơn trong danh sách hơn là mở đơn hàng.
      const code =
        typeof payload.tracking_code === 'string'
          ? payload.tracking_code
          : null;
      if (code) return `/shipping/shipments?q=${encodeURIComponent(code)}`;
      return orderId ? `/orders/${orderId}` : null;
    }
    case 'order_refund':
      // Hoàn tiền không có trang riêng và `subjectId` là id của refund, không phải
      // của đơn — chỉ `payload.order_id` mới dựng được link đúng.
      return orderId ? `/orders/${orderId}` : null;
    case 'location': {
      // Cảnh báo tồn kho tổng hợp theo kho. Tuyệt đối KHÔNG dùng `low_stock=true` sẵn
      // có: filter đó là `available <= 5`, khớp 96% số dòng, bấm vào sẽ ra con số hoàn
      // toàn khác con số ghi trên thông báo.
      const params = new URLSearchParams({
        locationId: subjectId.toString(),
      });

      // Âm kho biểu diễn được bằng SQL ⇒ dùng bộ lọc thật, không giới hạn số dòng.
      if (payload.stock_status === 'negative') {
        params.set('stockStatus', 'negative');
        return `/warehouse/inventory?${params.toString()}`;
      }

      // "Cần nhập" tính từ bán 15/30/90 ngày, không viết được thành điều kiện SQL ⇒
      // liệt kê thẳng id các SKU đã đếm.
      const variantIds =
        typeof payload.variant_ids === 'string' ? payload.variant_ids : null;
      if (variantIds) params.set('variantIds', variantIds);
      return `/warehouse/inventory?${params.toString()}`;
    }
    case 'order_shortage': {
      // Digest gom theo kho ⇒ `subjectId` là id KHO, không phải id đơn. Trỏ về danh sách
      // đơn đã bật sẵn tab "Thiếu hàng" của đúng kho đó, để con số bấm vào khớp con số
      // ghi trên thông báo — cùng nguyên tắc với cảnh báo tồn kho ở nhánh `location`.
      const params = new URLSearchParams({
        stock_status: 'thieu_hang',
        location_ids: subjectId.toString(),
      });
      // BẮT BUỘC kèm mốc ngày: cảnh báo chỉ đếm đơn trong cửa sổ gần đây, còn tab
      // "Thiếu hàng" không giới hạn thời gian. Thiếu tham số này thì thông báo ghi 16 đơn
      // mà bấm vào ra 1.244 — phần lớn là đơn Sapo cũ đã giao nhưng không bao giờ đóng.
      const createdOnMin =
        typeof payload.created_on_min === 'string'
          ? payload.created_on_min
          : null;
      if (createdOnMin) params.set('created_on_min', createdOnMin);
      return `/orders?${params.toString()}`;
    }
    case 'channel':
      // Kênh chết thì việc phải làm là vào màn Kênh bán nối lại/ủy quyền lại. `subjectId`
      // ở đây không định danh được gì (Sapo không có dòng `channel_connections`), tên kênh
      // nằm ở `payload.channel`.
      return '/settings/sales-channels';
    default:
      return null;
  }
}

type Row = NotificationRecipient & { notification: Notification };

export function serializeNotification(row: Row) {
  const n = row.notification;
  const payload = (n.payload ?? {}) as Record<string, unknown>;
  const link = resolveLink(n.subjectType, n.subjectId, payload);

  return {
    id: n.id.toString(),
    topic: TOPIC_WIRE[n.topic],
    topic_label: NOTIFICATION_TOPIC_LABELS[n.topic],
    subject_type: n.subjectType,
    subject_id: n.subjectId.toString(),
    location_id: n.locationId?.toString() ?? null,
    title: n.title,
    payload: n.payload,
    link,
    is_read: row.readOn !== null,
    read_on: row.readOn?.toISOString() ?? null,
    created_on: n.createdOn.toISOString(),
  };
}

export function serializeNotificationSetting(s: NotificationSetting) {
  return {
    topic: TOPIC_WIRE[s.topic],
    topic_label: NOTIFICATION_TOPIC_LABELS[s.topic],
    group: NOTIFICATION_TOPIC_GROUPS[s.topic],
    app_enabled: s.appEnabled,
    email_enabled: s.emailEnabled,
    recipient_permissions: s.recipientPermissions,
    modified_on: s.modifiedOn.toISOString(),
  };
}
