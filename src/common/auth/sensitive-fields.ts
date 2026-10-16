import type { AuthUser } from '../decorators/current-user.decorator';
import { hasSystemPermission } from './access';

/**
 * Dữ liệu nhạy cảm mà Sapo tách thành quyền riêng (đối chiếu
 * `GET /admin/users.json` của shop, 13/10/2026): chỉ 45/213 tài khoản có
 * `read_cost_price`, 29 tài khoản có `total_profit_reports`.
 *
 * Giá vốn và lợi nhuận lộ ra ở rất nhiều response (sản phẩm, tồn kho, chuyển
 * kho, kiểm hàng, báo cáo, file xuất). Che theo TÊN TRƯỜNG ở một chỗ thay vì sửa
 * từng serializer: thêm một màn mới trả `cost` thì nó tự được che, quên mới là lộ.
 */
export const VIEW_COST_PERMISSION = 'product:view_cost';
export const VIEW_PROFIT_PERMISSION = 'report:view_profit';

/** Trường mang giá vốn hoặc số suy ra trực tiếp từ giá vốn. */
export const COST_KEYS: ReadonlySet<string> = new Set(['cost', 'stock_value']);

/** Trường mang lợi nhuận. Kèm `cost`: có doanh thu và giá vốn là tính ra lợi nhuận. */
export const PROFIT_KEYS: ReadonlySet<string> = new Set([
  'profit',
  'profit_margin',
  'avg_profit_per_order',
  'gross_profit',
  'missing_cost_lines',
  'cost',
]);

export function canViewCost(user: AuthUser): boolean {
  return hasSystemPermission(user, VIEW_COST_PERMISSION);
}

export function canViewProfit(user: AuthUser): boolean {
  return hasSystemPermission(user, VIEW_PROFIT_PERMISSION);
}

/** Dòng lịch sử giá của riêng trường giá vốn (`{ field: 'cost', old_value, new_value }`). */
function isCostHistoryRow(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { field?: unknown }).field === 'cost' &&
    'new_value' in value
  );
}

/**
 * Trả bản sao của `value` với mọi trường thuộc `keys` bị đặt về `null` (đệ quy).
 * Đặt `null` chứ không xoá khoá để hình dạng response giữ nguyên — giao diện
 * hiện "—" thay vì vỡ vì thiếu trường.
 */
export function redactKeys<T>(value: T, keys: ReadonlySet<string>): T {
  if (Array.isArray(value)) {
    const items = keys.has('cost')
      ? value.filter((item) => !isCostHistoryRow(item))
      : value;
    return items.map((item) => redactKeys(item, keys)) as unknown as T;
  }
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = keys.has(k) ? null : redactKeys(v, keys);
  }
  return out as T;
}

/**
 * Xoá tại chỗ mọi trường thuộc `keys` khỏi body request (đệ quy). Người không
 * xem được giá vốn thì cũng không được ghi nó: form của họ nhận `cost = null`,
 * gửi lại thành 0 sẽ xoá sạch giá vốn thật nếu không chặn ở đây.
 */
export function stripKeys(value: unknown, keys: ReadonlySet<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) stripKeys(item, keys);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  const obj = value as Record<string, unknown>;
  for (const k of Object.keys(obj)) {
    if (keys.has(k)) delete obj[k];
    else stripKeys(obj[k], keys);
  }
}

/** Bỏ các cột giá vốn khỏi danh mục cột của file xuất / báo cáo. */
export function withoutCostColumns<T extends { key: string }>(
  columns: T[],
  user: AuthUser,
): T[] {
  return canViewCost(user)
    ? columns
    : columns.filter((c) => !COST_KEYS.has(c.key));
}
