import { PermissionScope } from '@prisma/client';

export type PermissionDef = {
  key: string;
  group: string;
  label: string;
  scope: PermissionScope;
};

/**
 * Danh mục quyền tĩnh (catalog). Seed vào bảng `permissions`.
 * scope=system: áp dụng toàn hệ thống; scope=location: áp dụng theo kho được gán.
 */
export const PERMISSION_CATALOG: PermissionDef[] = [
  // Hệ thống
  {
    key: 'dashboard:view',
    group: 'Hệ thống',
    label: 'Xem trang chủ',
    scope: PermissionScope.system,
  },
  {
    key: 'staff:manage',
    group: 'Hệ thống',
    label: 'Quản lý nhân viên',
    scope: PermissionScope.system,
  },
  {
    key: 'role:manage',
    group: 'Hệ thống',
    label: 'Quản lý vai trò & phân quyền',
    scope: PermissionScope.system,
  },
  {
    key: 'report:view',
    group: 'Hệ thống',
    label: 'Xem báo cáo',
    scope: PermissionScope.system,
  },
  {
    key: 'shipping:manage',
    group: 'Hệ thống',
    label: 'Cấu hình vận chuyển',
    scope: PermissionScope.system,
  },
  {
    key: 'api_key:manage',
    group: 'Hệ thống',
    label: 'Quản lý API key đối tác',
    scope: PermissionScope.system,
  },
  // Chỉ chi phối trang /cau-hinh/thong-bao (bật/tắt topic, chọn người nhận).
  // ĐỌC thông báo của chính mình KHÔNG cần quyền này — ai cũng có chuông.
  {
    key: 'notification:manage',
    group: 'Hệ thống',
    label: 'Cấu hình thông báo',
    scope: PermissionScope.system,
  },

  // Kết nối sàn (Shopee/TikTok), đồng bộ kênh. Sapo: `channels` — shop thật chỉ
  // 2/213 tài khoản có. Trước đây dùng nhờ `order:create` nên nhân viên bán hàng
  // nào cũng kết nối/ngắt gian hàng được.
  {
    key: 'channel:manage',
    group: 'Hệ thống',
    label: 'Kết nối & đồng bộ kênh bán',
    scope: PermissionScope.system,
  },
  // Sổ quỹ (phiếu thu/chi). Sapo: `read_vouchers`. Trước đây dùng nhờ
  // `report:view` / `purchasing:manage`.
  {
    key: 'voucher:view',
    group: 'Hệ thống',
    label: 'Xem sổ quỹ',
    scope: PermissionScope.system,
  },
  // Lợi nhuận tách khỏi báo cáo thường. Sapo: `total_profit_reports`.
  {
    key: 'report:view_profit',
    group: 'Hệ thống',
    label: 'Xem báo cáo lợi nhuận',
    scope: PermissionScope.system,
  },
  // Giá vốn. Sapo: `read_cost_price` (45/213 tài khoản). scope=system vì giá vốn
  // hiện ra ở cả những chỗ không gắn kho (sản phẩm, báo cáo).
  {
    key: 'product:view_cost',
    group: 'Sản phẩm',
    label: 'Xem & sửa giá vốn',
    scope: PermissionScope.system,
  },

  // Đơn hàng (theo kho)
  {
    key: 'order:view',
    group: 'Đơn hàng',
    label: 'Xem đơn hàng',
    scope: PermissionScope.location,
  },
  {
    key: 'order:create',
    group: 'Đơn hàng',
    label: 'Tạo đơn hàng',
    scope: PermissionScope.location,
  },
  {
    key: 'order:update',
    group: 'Đơn hàng',
    label: 'Cập nhật đơn hàng',
    scope: PermissionScope.location,
  },
  // Sapo `override_item_price`: 141/213 tài khoản có. Không có thì chỉ bán theo
  // giá niêm yết (giá gốc hoặc giá trong bảng giá đang bật).
  {
    key: 'order:override_price',
    group: 'Đơn hàng',
    label: 'Sửa giá bán khi tạo đơn',
    scope: PermissionScope.location,
  },
  {
    key: 'order:cancel',
    group: 'Đơn hàng',
    label: 'Hủy đơn hàng',
    scope: PermissionScope.location,
  },
  {
    key: 'order:pack',
    group: 'Đơn hàng',
    label: 'Đóng gói & giao hàng',
    scope: PermissionScope.location,
  },

  // Trả hàng (theo kho)
  {
    key: 'order_return:view',
    group: 'Trả hàng',
    label: 'Xem trả hàng',
    scope: PermissionScope.location,
  },
  {
    key: 'order_return:manage',
    group: 'Trả hàng',
    label: 'Tạo & xử lý trả hàng',
    scope: PermissionScope.location,
  },

  // Sản phẩm (theo kho)
  {
    key: 'product:view',
    group: 'Sản phẩm',
    label: 'Xem sản phẩm',
    scope: PermissionScope.location,
  },
  {
    key: 'product:manage',
    group: 'Sản phẩm',
    label: 'Tạo & cập nhật sản phẩm',
    scope: PermissionScope.location,
  },

  // Quản lý kho (theo kho)
  {
    key: 'inventory:view',
    group: 'Quản lý kho',
    label: 'Xem tồn kho',
    scope: PermissionScope.location,
  },
  {
    key: 'inventory:transfer',
    group: 'Quản lý kho',
    label: 'Chuyển kho',
    scope: PermissionScope.location,
  },
  {
    key: 'inventory:receive',
    group: 'Quản lý kho',
    label: 'Nhập hàng',
    scope: PermissionScope.location,
  },
  {
    key: 'inventory:stocktake',
    group: 'Quản lý kho',
    label: 'Kiểm hàng',
    scope: PermissionScope.location,
  },
  {
    key: 'purchasing:manage',
    group: 'Quản lý kho',
    label: 'Đặt hàng nhập & NCC',
    scope: PermissionScope.location,
  },

  // Khách hàng (hệ thống)
  {
    key: 'customer:view',
    group: 'Khách hàng',
    label: 'Xem khách hàng',
    scope: PermissionScope.system,
  },
  {
    key: 'customer:manage',
    group: 'Khách hàng',
    label: 'Tạo & cập nhật khách hàng',
    scope: PermissionScope.system,
  },
];

/** Map key -> scope, dùng cho PermissionGuard xác định cách kiểm tra. */
export const PERMISSION_SCOPE: Record<string, PermissionScope> =
  Object.fromEntries(PERMISSION_CATALOG.map((p) => [p.key, p.scope]));

/** Tập quyền mặc định cho từng role seed (theo ma trận docs/00-tong-quan/vai-tro-phan-quyen.md). */
export const DEFAULT_ROLE_PERMISSIONS: Record<
  string,
  { name: string; isSystem?: boolean; permissions: string[] | '*' }
> = {
  admin: { name: 'Quản trị hệ thống', isSystem: true, permissions: '*' },
  store_manager: {
    name: 'Quản lý cửa hàng',
    permissions: [
      'dashboard:view',
      'report:view',
      'report:view_profit',
      'voucher:view',
      'channel:manage',
      'product:view_cost',
      'shipping:manage',
      'notification:manage',
      'order:view',
      'order:create',
      'order:update',
      'order:override_price',
      'order:cancel',
      'order:pack',
      'order_return:view',
      'order_return:manage',
      'product:view',
      'product:manage',
      'inventory:view',
      'inventory:transfer',
      'inventory:receive',
      'inventory:stocktake',
      'customer:view',
      'customer:manage',
    ],
  },
  sales: {
    name: 'Nhân viên bán hàng',
    permissions: [
      'dashboard:view',
      'order:view',
      'order:create',
      'order:update',
      'order:override_price',
      'order_return:view',
      'product:view',
      'inventory:view',
      'customer:view',
      'customer:manage',
    ],
  },
  // Ba vai trò dưới đây theo các kiểu vai trò đang dùng thật trên Sapo của shop
  // (gom 213 tài khoản theo bộ quyền, 13/10/2026).
  // 48 tài khoản: bán hàng nhưng không có `override_item_price`.
  sales_fixed_price: {
    name: 'Nhân viên bán hàng (không sửa giá)',
    permissions: [
      'dashboard:view',
      'order:view',
      'order:create',
      'order:update',
      'order_return:view',
      'product:view',
      'inventory:view',
      'customer:view',
      'customer:manage',
    ],
  },
  // 5 tài khoản: bán hàng + xử lý đơn, xem báo cáo toàn bộ kể cả lợi nhuận, quản
  // lý nhân viên — nhưng không cấu hình cửa hàng, không huỷ đơn, không xem giá vốn.
  team_lead: {
    name: 'Trưởng nhóm',
    permissions: [
      'dashboard:view',
      'report:view',
      'report:view_profit',
      'staff:manage',
      'order:view',
      'order:create',
      'order:update',
      'order:override_price',
      'order:pack',
      'order_return:view',
      'product:view',
      'inventory:view',
      'customer:view',
      'customer:manage',
    ],
  },
  // 11 tài khoản: chỉ có quyền đọc.
  viewer: {
    name: 'Chỉ xem',
    permissions: [
      'dashboard:view',
      'order:view',
      'order_return:view',
      'product:view',
      'inventory:view',
      'customer:view',
    ],
  },
  warehouse_staff: {
    name: 'Nhân viên kho',
    permissions: [
      'dashboard:view',
      'order:view',
      'order:pack',
      'product:view',
      'inventory:view',
      'inventory:transfer',
      'inventory:receive',
      'inventory:stocktake',
    ],
  },
  purchasing: {
    name: 'Nhân viên mua hàng',
    permissions: [
      'dashboard:view',
      'product:view',
      'inventory:view',
      'inventory:receive',
      'purchasing:manage',
      // Đặt hàng nhập cần giá vốn để điền giá mua; sổ quỹ để theo dõi công nợ NCC
      'product:view_cost',
      'voucher:view',
    ],
  },
};
