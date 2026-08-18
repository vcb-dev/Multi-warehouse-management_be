/**
 * Unit test cho notification.serializer.ts — thuần logic, không DB. Trọng tâm là
 * `resolveLink` (qua `serializeNotification`): đây là chỗ dễ vỡ nhất trong cả luồng
 * thông báo — link sai thì con số người dùng thấy sau khi bấm vào lệch với con số ghi
 * trên thông báo, và lỗi này KHÔNG lộ ra ở tsc hay ở test happy-path.
 */
import { NotificationRecipient, NotificationTopic } from '@prisma/client';
import {
  serializeNotification,
  serializeNotificationSetting,
  TOPIC_WIRE,
} from '../src/modules/notifications/notification.serializer';

type Notif = Parameters<typeof serializeNotification>[0]['notification'];

function makeRow(
  overrides: Partial<Notif> & { readOn?: Date | null } = {},
): Parameters<typeof serializeNotification>[0] {
  const { readOn = null, ...notifOverrides } = overrides;
  const notification: Notif = {
    id: 1n,
    topic: NotificationTopic.orders_create,
    subjectType: 'order',
    subjectId: 100n,
    locationId: 1n,
    title: 'Đơn hàng mới HK001',
    payload: null,
    createdOn: new Date('2026-08-17T00:00:00.000Z'),
    ...notifOverrides,
  };
  return {
    notificationId: notification.id,
    userId: 9n,
    channel: 'app',
    readOn,
    notification,
  } as unknown as Parameters<typeof serializeNotification>[0];
}

describe('serializeNotification — resolveLink theo subject_type', () => {
  it('order → /don-hang/[id]', () => {
    const row = makeRow({ subjectType: 'order', subjectId: 42n });
    expect(serializeNotification(row).link).toBe('/don-hang/42');
  });

  it('customer → /khach-hang/[id]', () => {
    const row = makeRow({
      subjectType: 'customer',
      subjectId: 7n,
      topic: NotificationTopic.customers_create,
    });
    expect(serializeNotification(row).link).toBe('/khach-hang/7');
  });

  it('fulfillment có tracking_code → lọc danh sách vận đơn theo mã, KHÔNG mở đơn hàng', () => {
    const row = makeRow({
      subjectType: 'fulfillment',
      subjectId: 5n,
      topic: NotificationTopic.fulfillments_create,
      payload: { order_id: '99', tracking_code: 'GHN-ABC 123' },
    });
    // encodeURIComponent bắt buộc — mã vận đơn có thể chứa khoảng trắng/ký tự đặc biệt
    expect(serializeNotification(row).link).toBe(
      '/van-chuyen/van-don?q=GHN-ABC%20123',
    );
  });

  it('fulfillment KHÔNG có tracking_code → fallback về đơn hàng qua order_id trong payload', () => {
    const row = makeRow({
      subjectType: 'fulfillment',
      subjectId: 5n,
      topic: NotificationTopic.fulfillments_update,
      payload: { order_id: '99' },
    });
    expect(serializeNotification(row).link).toBe('/don-hang/99');
  });

  it('fulfillment không có cả tracking_code lẫn order_id → null (không dựng được link)', () => {
    const row = makeRow({
      subjectType: 'fulfillment',
      subjectId: 5n,
      payload: {},
    });
    expect(serializeNotification(row).link).toBeNull();
  });

  it('order_refund → link về ĐƠN GỐC qua payload.order_id, KHÔNG dùng subjectId (đó là id refund)', () => {
    const row = makeRow({
      subjectType: 'order_refund',
      subjectId: 555n, // id của refund — cố tình khác order_id để phát hiện nhầm lẫn
      topic: NotificationTopic.refunds_create,
      payload: { order_id: '99' },
    });
    const link = serializeNotification(row).link;
    expect(link).toBe('/don-hang/99');
    expect(link).not.toContain('555');
  });

  it('order_refund thiếu order_id trong payload → null, không tự chế link sai từ subjectId', () => {
    const row = makeRow({
      subjectType: 'order_refund',
      subjectId: 555n,
      payload: {},
    });
    expect(serializeNotification(row).link).toBeNull();
  });

  it('location + stock_status=negative → dùng bộ lọc SQL thật, KHÔNG kèm variant_ids dù có', () => {
    const row = makeRow({
      subjectType: 'location',
      subjectId: 4n,
      topic: NotificationTopic.inventory_negative,
      // variant_ids cố tình có mặt để xác nhận nhánh negative bỏ qua nó
      payload: { stock_status: 'negative', variant_ids: '1,2,3' },
    });
    const link = serializeNotification(row).link;
    expect(link).toBe('/kho/ton-kho?locationId=4&stockStatus=negative');
    expect(link).not.toContain('variantIds');
    expect(link).not.toContain('low_stock');
  });

  it('location cần nhập (không phải negative) → liệt kê variant_ids, KHÔNG dùng low_stock=true', () => {
    const row = makeRow({
      subjectType: 'location',
      subjectId: 4n,
      topic: NotificationTopic.inventory_low_stock,
      payload: { variant_ids: '10,20,30' },
    });
    const link = serializeNotification(row).link;
    expect(link).toBe('/kho/ton-kho?locationId=4&variantIds=10%2C20%2C30');
    expect(link).not.toContain('low_stock=true');
    expect(link).not.toContain('stockStatus');
  });

  it('location không có variant_ids và không phải negative → vẫn trả link có locationId (không crash)', () => {
    const row = makeRow({
      subjectType: 'location',
      subjectId: 4n,
      topic: NotificationTopic.inventory_low_stock,
      payload: {},
    });
    expect(serializeNotification(row).link).toBe('/kho/ton-kho?locationId=4');
  });

  it('subject_type lạ (chưa từng khai) → null, không throw', () => {
    const row = makeRow({ subjectType: 'khong_ton_tai' });
    expect(serializeNotification(row).link).toBeNull();
  });

  it('payload null (chưa từng set) → không throw, coi như payload rỗng', () => {
    const row = makeRow({ subjectType: 'fulfillment', payload: null });
    expect(() => serializeNotification(row)).not.toThrow();
  });
});

describe('serializeNotification — các field còn lại', () => {
  it('topic trả ra ĐÚNG chuỗi Sapo (có dấu /), không phải tên enum Prisma', () => {
    const row = makeRow({ topic: NotificationTopic.fulfillments_update });
    expect(serializeNotification(row).topic).toBe('fulfillments/update');
  });

  it('is_read/read_on phản ánh đúng readOn — null nghĩa là chưa đọc', () => {
    const unread = serializeNotification(makeRow({}));
    expect(unread.is_read).toBe(false);
    expect(unread.read_on).toBeNull();

    const read = serializeNotification(
      makeRow({ readOn: new Date('2026-08-17T01:00:00.000Z') } as never),
    );
    expect(read.is_read).toBe(true);
    expect(read.read_on).toBe('2026-08-17T01:00:00.000Z');
  });

  it('id/subject_id là bigint đổi thành string — JSON không có kiểu bigint', () => {
    const row = makeRow({ subjectId: 42n });
    const out = serializeNotification(row);
    expect(typeof out.id).toBe('string');
    expect(typeof out.subject_id).toBe('string');
    expect(out.subject_id).toBe('42');
  });

  it('location_id null (sự kiện không thuộc kho nào, vd khách hàng mới) → null chứ không phải "null"', () => {
    const row = makeRow({
      subjectType: 'customer',
      locationId: null,
    });
    expect(serializeNotification(row).location_id).toBeNull();
  });
});

describe('TOPIC_WIRE — phủ đủ mọi giá trị enum, không sót topic mới', () => {
  it('mọi thành viên NotificationTopic đều có mapping wire tương ứng', () => {
    for (const topic of Object.values(NotificationTopic)) {
      expect(TOPIC_WIRE[topic]).toBeDefined();
      expect(typeof TOPIC_WIRE[topic]).toBe('string');
    }
  });

  it('8 topic đầu dùng đúng vocabulary Sapo (không dấu gạch dưới thay cho /)', () => {
    expect(TOPIC_WIRE.orders_create).toBe('orders/create');
    expect(TOPIC_WIRE.fulfillments_update).toBe('fulfillments/update');
  });

  it('2 topic tồn kho dùng tiền tố inventory/ — KHÔNG lẫn với inventory_levels/ của Sapo', () => {
    expect(TOPIC_WIRE.inventory_low_stock.startsWith('inventory/')).toBe(true);
    expect(TOPIC_WIRE.inventory_negative.startsWith('inventory/')).toBe(true);
  });
});

describe('serializeNotificationSetting', () => {
  it('map đủ field và trả topic dạng wire', () => {
    const out = serializeNotificationSetting({
      id: 1n,
      topic: NotificationTopic.inventory_negative,
      appEnabled: true,
      emailEnabled: false,
      recipientPermissions: ['inventory:view'],
      createdOn: new Date('2026-08-17T00:00:00.000Z'),
      modifiedOn: new Date('2026-08-17T02:00:00.000Z'),
    });
    expect(out).toEqual({
      topic: 'inventory/negative',
      topic_label: 'Âm kho',
      group: 'Tồn kho',
      app_enabled: true,
      email_enabled: false,
      recipient_permissions: ['inventory:view'],
      modified_on: '2026-08-17T02:00:00.000Z',
    });
  });
});
