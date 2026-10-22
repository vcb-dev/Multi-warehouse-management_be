/**
 * Canary cho một quyết định dễ bị "dọn dẹp" nhầm: `price_list:view`/`price_list:manage`
 * PHẢI là scope=location dù sản phẩm là entity toàn cục (không có locationId) — vì
 * `PriceList` (bảng giá) CÓ location_id tuỳ chọn (bảng giá theo kho). Đổi sang
 * scope=system xoá mất quyền đó khỏi bucket theo kho, khiến bất kỳ ai có
 * price_list:manage (giờ toàn cục) tạo được bảng giá cho MỌI kho, kể cả kho họ không
 * liên quan gì — đúng loại lỗ hổng chéo kho mà toàn bộ specs/009-cau-hinh đang đóng lại.
 *
 * Xem docs/03-tech/ke-hoach-sua-phan-quyen.md — Phase 6 (mục "phát hiện hồi quy").
 * Nếu bạn đang sửa test này vì muốn đổi scope: trước tiên hãy tự hỏi
 * PriceListService.create còn cần kiểm quyền theo location_id không.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PermissionScope } from '@prisma/client';
import {
  DEFAULT_ROLE_PERMISSIONS,
  PERMISSION_CATALOG,
  PERMISSION_SCOPE,
} from '../src/modules/rbac/permission-catalog';

describe('PERMISSION_CATALOG — quyền bảng giá phải giữ scope=location', () => {
  it.each(['product:view', 'price_list:view', 'price_list:manage'])(
    '%s là scope=location',
    (key) => {
      expect(PERMISSION_SCOPE[key]).toBe(PermissionScope.location);
    },
  );
});

/** Mọi file .ts dưới src (trừ spec). */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
  });
}

describe('PERMISSION_CATALOG — khớp với code', () => {
  const keys = new Set(PERMISSION_CATALOG.map((p) => p.key));

  it('không trùng key', () => {
    expect(keys.size).toBe(PERMISSION_CATALOG.length);
  });

  // Gõ sai/sót một key ở @RequirePermission thì endpoint chỉ còn admin gọi được, và
  // màn phân quyền không có ô nào để tick — lỗi im lặng, chỉ lộ khi nhân viên báo.
  it('mọi key trong @RequirePermission đều có trong catalog', () => {
    const unknown: string[] = [];
    for (const file of sourceFiles(join(__dirname, '../src'))) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/@RequirePermission\(([^)]*)\)/g)) {
        for (const k of m[1].matchAll(/'([^']+)'/g)) {
          if (!keys.has(k[1])) unknown.push(`${k[1]} (${file})`);
        }
      }
    }
    expect(unknown).toEqual([]);
  });

  it('vai trò mặc định chỉ dùng key có trong catalog', () => {
    const unknown = Object.entries(DEFAULT_ROLE_PERMISSIONS).flatMap(
      ([code, def]) =>
        def.permissions === '*'
          ? []
          : def.permissions
              .filter((k) => !keys.has(k))
              .map((k) => `${code}: ${k}`),
    );
    expect(unknown).toEqual([]);
  });
});
