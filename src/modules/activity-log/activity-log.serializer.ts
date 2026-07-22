import { ActivityLog, User } from '@prisma/client';

// Nhãn tiếng Việt cho từng action — key theo convention "entity.verb" đã dùng
// trong toàn bộ codebase khi ghi activityLog.create(...).
export const ACTIVITY_ACTION_LABELS: Record<string, string> = {
  'goods_receipt.create': 'Thêm mới đơn nhập hàng',
  'goods_receipt.confirm': 'Xác nhận nhập kho đơn nhập',
  'goods_receipt.pay': 'Thanh toán đơn nhập hàng',
  'goods_receipt.cancel': 'Hủy đơn nhập hàng',
  'purchase_order.create': 'Thêm mới đơn đặt hàng nhập',
  'purchase_order.update': 'Cập nhật đơn đặt hàng nhập',
  'purchase_order.submit': 'Duyệt đơn đặt hàng nhập',
  'purchase_order.close': 'Hoàn tất đơn đặt hàng nhập',
  'purchase_order.cancel': 'Hủy đơn đặt hàng nhập',
  'purchase_order.auto_complete': 'Hoàn tất đơn đặt hàng nhập',
  'stock_transfer.create': 'Thêm mới phiếu chuyển kho',
  'stock_transfer.update': 'Cập nhật phiếu chuyển kho',
  'stock_transfer.submit': 'Duyệt phiếu chuyển kho',
  'stock_transfer.ship': 'Xuất kho phiếu chuyển',
  'stock_transfer.receive': 'Xác nhận nhận hàng chuyển kho',
  'stock_transfer.cancel': 'Hủy phiếu chuyển kho',
  'purchase_return.create': 'Thêm mới đơn trả hàng nhập',
  'purchase_return.confirm_refund': 'Xác nhận đã nhận hoàn tiền',
  'order.create': 'Tạo đơn hàng',
  'order.update': 'Cập nhật đơn hàng',
  'order.transition_processing': 'Chuyển đơn sang xử lý',
  'order.complete': 'Hoàn thành đơn hàng',
  'order.cancel': 'Hủy đơn hàng',
  'order.pay': 'Thanh toán đơn hàng',
};

type LogWithUser = ActivityLog & {
  user: Pick<User, 'name' | 'email'> | null;
};

export function serializeActivityLog(entry: LogWithUser) {
  const metadata = (entry.metadata ?? {}) as Record<string, unknown>;
  return {
    id: entry.id.toString(),
    action: entry.action,
    action_label: ACTIVITY_ACTION_LABELS[entry.action] ?? entry.action,
    actor_name: entry.user?.name ?? entry.user?.email ?? 'Hệ thống',
    reference_code: typeof metadata.code === 'string' ? metadata.code : null,
    amount: typeof metadata.amount === 'number' ? metadata.amount : null,
    created_at: entry.createdAt.toISOString(),
  };
}
