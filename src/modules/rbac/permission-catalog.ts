import { PermissionScope } from '@prisma/client';

export type PermissionDef = {
  key: string;
  group: string;
  label: string;
  scope: PermissionScope;
};

/**
 * Danh mục quyền tĩnh (catalog). Seed vào bảng `permissions`.
 * scope=system: áp dụng toàn hệ thống; scope=warehouse: áp dụng theo kho được gán.
 */
export const PERMISSION_CATALOG: PermissionDef[] = [
  // Hệ thống
  { key: 'dashboard:view', group: 'Hệ thống', label: 'Xem trang chủ', scope: PermissionScope.system },
  { key: 'config:access', group: 'Hệ thống', label: 'Truy cập cấu hình', scope: PermissionScope.system },
  { key: 'staff:manage', group: 'Hệ thống', label: 'Quản lý nhân viên', scope: PermissionScope.system },
  { key: 'role:manage', group: 'Hệ thống', label: 'Quản lý vai trò & phân quyền', scope: PermissionScope.system },
  { key: 'report:view', group: 'Hệ thống', label: 'Xem báo cáo', scope: PermissionScope.system },

  // Đơn hàng (theo kho)
  { key: 'order:view', group: 'Đơn hàng', label: 'Xem đơn hàng', scope: PermissionScope.warehouse },
  { key: 'order:create', group: 'Đơn hàng', label: 'Tạo đơn hàng', scope: PermissionScope.warehouse },
  { key: 'order:update', group: 'Đơn hàng', label: 'Cập nhật đơn hàng', scope: PermissionScope.warehouse },
  { key: 'order:cancel', group: 'Đơn hàng', label: 'Hủy đơn hàng', scope: PermissionScope.warehouse },
  { key: 'order:pack', group: 'Đơn hàng', label: 'Đóng gói & giao hàng', scope: PermissionScope.warehouse },

  // Đơn nháp (theo kho)
  { key: 'draft_order:view', group: 'Đơn hàng nháp', label: 'Xem đơn nháp', scope: PermissionScope.warehouse },
  { key: 'draft_order:manage', group: 'Đơn hàng nháp', label: 'Tạo & cập nhật đơn nháp', scope: PermissionScope.warehouse },

  // Trả hàng (theo kho)
  { key: 'order_return:view', group: 'Trả hàng', label: 'Xem trả hàng', scope: PermissionScope.warehouse },
  { key: 'order_return:manage', group: 'Trả hàng', label: 'Tạo & xử lý trả hàng', scope: PermissionScope.warehouse },

  // Sản phẩm (theo kho)
  { key: 'product:view', group: 'Sản phẩm', label: 'Xem sản phẩm', scope: PermissionScope.warehouse },
  { key: 'product:manage', group: 'Sản phẩm', label: 'Tạo & cập nhật sản phẩm', scope: PermissionScope.warehouse },

  // Quản lý kho (theo kho)
  { key: 'inventory:view', group: 'Quản lý kho', label: 'Xem tồn kho', scope: PermissionScope.warehouse },
  { key: 'inventory:adjust', group: 'Quản lý kho', label: 'Điều chỉnh tồn kho', scope: PermissionScope.warehouse },
  { key: 'inventory:transfer', group: 'Quản lý kho', label: 'Chuyển kho', scope: PermissionScope.warehouse },
  { key: 'inventory:receive', group: 'Quản lý kho', label: 'Nhập hàng', scope: PermissionScope.warehouse },
  { key: 'purchasing:manage', group: 'Quản lý kho', label: 'Đặt hàng nhập & NCC', scope: PermissionScope.warehouse },

  // Khách hàng (hệ thống)
  { key: 'customer:view', group: 'Khách hàng', label: 'Xem khách hàng', scope: PermissionScope.system },
  { key: 'customer:manage', group: 'Khách hàng', label: 'Tạo & cập nhật khách hàng', scope: PermissionScope.system },
];

/** Map key -> scope, dùng cho PermissionGuard xác định cách kiểm tra. */
export const PERMISSION_SCOPE: Record<string, PermissionScope> = Object.fromEntries(
  PERMISSION_CATALOG.map((p) => [p.key, p.scope]),
);

/** Tập quyền mặc định cho từng role seed (theo ma trận docs/00-tong-quan/vai-tro-phan-quyen.md). */
export const DEFAULT_ROLE_PERMISSIONS: Record<
  string,
  { name: string; isSystem?: boolean; permissions: string[] | '*' }
> = {
  admin: { name: 'Quản trị hệ thống', isSystem: true, permissions: '*' },
  store_manager: {
    name: 'Quản lý cửa hàng',
    permissions: [
      'dashboard:view', 'report:view',
      'order:view', 'order:create', 'order:update', 'order:cancel', 'order:pack',
      'draft_order:view', 'draft_order:manage',
      'order_return:view', 'order_return:manage',
      'product:view', 'product:manage',
      'inventory:view', 'inventory:adjust', 'inventory:transfer', 'inventory:receive',
      'customer:view', 'customer:manage',
    ],
  },
  sales: {
    name: 'Nhân viên bán hàng',
    permissions: [
      'dashboard:view',
      'order:view', 'order:create', 'order:update',
      'draft_order:view', 'draft_order:manage',
      'order_return:view',
      'product:view',
      'inventory:view',
      'customer:view', 'customer:manage',
    ],
  },
  warehouse_staff: {
    name: 'Nhân viên kho',
    permissions: [
      'dashboard:view',
      'order:view', 'order:pack',
      'product:view',
      'inventory:view', 'inventory:adjust', 'inventory:transfer', 'inventory:receive',
    ],
  },
  purchasing: {
    name: 'Nhân viên mua hàng',
    permissions: [
      'dashboard:view',
      'product:view',
      'inventory:view', 'inventory:receive', 'purchasing:manage',
    ],
  },
};
