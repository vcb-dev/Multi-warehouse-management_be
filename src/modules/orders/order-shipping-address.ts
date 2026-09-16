import type { Order } from '@prisma/client';
import type { ShippingAddressDto } from './order.dto';

/** Trường của Sapo `shipping_address` ↔ cột phẳng trên bảng orders */
const COLUMN = {
  name: 'shippingName',
  first_name: 'shippingFirstName',
  last_name: 'shippingLastName',
  phone: 'shippingPhone',
  address1: 'shippingAddress1',
  address2: 'shippingAddress2',
  ward: 'shippingWard',
  ward_code: 'shippingWardCode',
  district: 'shippingDistrict',
  district_code: 'shippingDistrictCode',
  province: 'shippingProvince',
  province_code: 'shippingProvinceCode',
  city: 'shippingCity',
  country: 'shippingCountry',
  country_code: 'shippingCountryCode',
  zip: 'shippingZip',
  company: 'shippingCompany',
} as const satisfies Record<keyof ShippingAddressDto, keyof Order>;

type Field = keyof typeof COLUMN;
type Column = (typeof COLUMN)[Field];

export type ShippingColumns = Pick<
  Order,
  Column | 'shippingLatitude' | 'shippingLongitude'
>;

export type ShippingAddressPatch = Partial<
  Record<Column, string | null> &
    Record<'shippingLatitude' | 'shippingLongitude', null>
>;

/**
 * Tên địa danh đổi mà không gửi kèm mã thì mã cũ không còn đúng nữa: màn sửa
 * đơn chỉ chọn theo tên, còn mã là do Sapo/sàn điền lúc đồng bộ.
 */
const DERIVED: [Field, Field[]][] = [
  ['name', ['first_name', 'last_name']],
  ['ward', ['ward_code']],
  ['district', ['district_code']],
  ['province', ['province_code']],
  ['country', ['country_code']],
];

/** Đổi một trong các phần này là toạ độ cũ trỏ sai chỗ */
const LOCATES: Field[] = ['address1', 'ward', 'district', 'province'];

/**
 * Sửa địa chỉ giao hàng của một đơn đã có — chỉ ghi những cột thực sự đổi.
 *
 * Trường không gửi thì giữ nguyên, gửi chuỗi rỗng là xoá. Không thay cả khối
 * như lúc tạo đơn: đơn đồng bộ từ Sapo có address2/zip/company mà form sửa không
 * hiện, thay cả khối là mất trắng những trường đó.
 */
export function buildShippingAddressPatch(
  current: ShippingColumns,
  dto: ShippingAddressDto,
): ShippingAddressPatch {
  const patch: ShippingAddressPatch = {};
  const changed = new Set<Field>();

  for (const field of Object.keys(COLUMN) as Field[]) {
    const raw = dto[field];
    if (raw === undefined) continue;
    const next = raw.trim() || null;
    if (next === (current[COLUMN[field]] ?? null)) continue;
    patch[COLUMN[field]] = next;
    changed.add(field);
  }

  for (const [source, dependents] of DERIVED) {
    if (!changed.has(source)) continue;
    for (const dep of dependents) {
      if (dto[dep] !== undefined || current[COLUMN[dep]] == null) continue;
      patch[COLUMN[dep]] = null;
    }
  }

  const moved = LOCATES.some((f) => changed.has(f));
  if (moved && current.shippingLatitude != null) patch.shippingLatitude = null;
  if (moved && current.shippingLongitude != null) {
    patch.shippingLongitude = null;
  }

  return patch;
}

/** Bản tóm tắt người nhận để ghi vào lịch sử đơn */
export function recipientSnapshot(o: ShippingColumns) {
  return {
    name: o.shippingName,
    phone: o.shippingPhone,
    address1: o.shippingAddress1,
    ward: o.shippingWard,
    district: o.shippingDistrict,
    province: o.shippingProvince,
  };
}
