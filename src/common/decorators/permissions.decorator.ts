import { SetMetadata } from '@nestjs/common';

export const PERMISSION_KEY = 'requiredPermissions';

/**
 * Yêu cầu user có ít nhất MỘT trong các quyền liệt kê.
 * Quyền scope=warehouse được kiểm tra theo kho trong request (params/query/body location_id).
 */
export const RequirePermission = (...permissions: string[]) =>
  SetMetadata(PERMISSION_KEY, permissions);

export const LOCATION_OPTIONAL_KEY = 'locationOptional';

/**
 * Đánh dấu endpoint GHI thao tác trên dữ liệu không thuộc kho nào (sản phẩm,
 * danh mục, bảng giá, nhà cung cấp...). Không có nhãn này, hành động ghi cần
 * quyền `scope=location` mà không khai được kho sẽ bị từ chối (spec §5).
 *
 * Quyền vẫn phải có ở ít nhất một kho — nhãn này chỉ bỏ yêu cầu *khai* kho.
 */
export const LocationOptional = () => SetMetadata(LOCATION_OPTIONAL_KEY, true);
