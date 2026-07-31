/**
 * Canary cho một quyết định dễ bị "dọn dẹp" nhầm: `product:view`/`product:manage`
 * PHẢI là scope=location dù bản thân sản phẩm là entity toàn cục (không có
 * locationId) — vì `PriceList` (bảng giá) dùng CHUNG hai quyền này và CÓ
 * location_id tuỳ chọn (bảng giá theo kho). Đổi sang scope=system xoá mất
 * quyền đó khỏi bucket theo kho, khiến bất kỳ ai có product:manage (giờ toàn
 * cục) tạo được bảng giá cho MỌI kho, kể cả kho họ không liên quan gì —
 * đúng loại lỗ hổng chéo kho mà toàn bộ specs/009-cau-hinh đang đóng lại.
 *
 * Xem docs/03-tech/ke-hoach-sua-phan-quyen.md — Phase 6 (mục "phát hiện hồi quy").
 * Nếu bạn đang sửa test này vì muốn đổi scope: trước tiên hãy tự hỏi
 * PriceListService.create còn cần kiểm quyền theo location_id không.
 */
import { PermissionScope } from '@prisma/client';
import { PERMISSION_SCOPE } from '../src/modules/rbac/permission-catalog';

describe('PERMISSION_CATALOG — product:* phải giữ scope=location', () => {
  it('product:view là scope=location', () => {
    expect(PERMISSION_SCOPE['product:view']).toBe(PermissionScope.location);
  });

  it('product:manage là scope=location', () => {
    expect(PERMISSION_SCOPE['product:manage']).toBe(PermissionScope.location);
  });
});
