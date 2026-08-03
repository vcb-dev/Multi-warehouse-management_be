import { Logger } from '@nestjs/common';
import { BusinessException } from '../../../common/exceptions/business.exception';
import { GhnClient } from './ghn.client';

/**
 * App lưu địa chỉ theo dữ liệu hành chính Việt Nam (`frontend/public/data/vn-address.json`,
 * mã GSO) còn GHN dùng `ProvinceID`/`DistrictID`/`WardCode` riêng của họ — hai bộ mã không
 * khớp nhau. Lớp này khớp theo TÊN để đổi sang ID của GHN ngay trước khi tạo vận đơn, nên
 * không cần lưu mã GHN vào DB (bảng `fulfillments` đang khớp Sapo, không nhét cột riêng hãng).
 */

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Tiền tố hành chính hai bên viết khác nhau ("Thành phố Hà Nội" vs "Hà Nội"). */
const ADMIN_PREFIXES = [
  'thanh pho',
  'tinh',
  'quan',
  'huyen',
  'thi xa',
  'thi tran',
  'phuong',
  'xa',
];

/** Cùng quy tắc bỏ dấu với `stripDiacritics` ở `frontend/src/components/common/address-fields.tsx`. */
function stripDiacritics(s: string) {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .toLowerCase();
}

function normalize(s: string) {
  return stripDiacritics(s)
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Bỏ tiền tố hành chính để "Quận Ba Đình" và "Ba Đình" khớp nhau. */
function core(s: string) {
  let out = normalize(s);
  for (const p of ADMIN_PREFIXES) {
    if (out.startsWith(`${p} `)) {
      out = out.slice(p.length + 1);
      break;
    }
  }
  return out;
}

type Named = { name: string; extensions?: string[] };

/**
 * Khớp `input` với danh sách của GHN: ưu tiên khớp nguyên văn, rồi khớp phần lõi (bỏ tiền
 * tố), cuối cùng mới chấp nhận khớp một phần và CHỈ khi duy nhất — khớp một phần trên nhiều
 * ứng viên là mơ hồ, thà báo lỗi còn hơn giao sai địa chỉ.
 */
function matchOne<T extends Named>(items: T[], input: string): T | null {
  const wanted = normalize(input);
  const wantedCore = core(input);

  const variants = (i: T) => [i.name, ...(i.extensions ?? [])];

  const exact = items.find((i) =>
    variants(i).some((v) => normalize(v) === wanted),
  );
  if (exact) return exact;

  const byCore = items.filter((i) =>
    variants(i).some((v) => core(v) === wantedCore),
  );
  if (byCore.length === 1) return byCore[0];

  const partial = items.filter((i) =>
    variants(i).some((v) => {
      const c = core(v);
      return c.length > 2 && (c.includes(wantedCore) || wantedCore.includes(c));
    }),
  );
  return partial.length === 1 ? partial[0] : null;
}

type Creds = { token: string; shopId?: string | number | null };

export class GhnLocationResolver {
  private readonly logger = new Logger(GhnLocationResolver.name);
  /** Master data địa chỉ là chung cho mọi shop nên cache theo tài nguyên, không theo token. */
  private cache = new Map<string, { at: number; value: unknown }>();

  constructor(private readonly client: GhnClient) {}

  private async cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value as T;
    const value = await load();
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  /**
   * Đổi tên tỉnh/huyện/xã sang `{ districtId, wardCode }` mà API tạo đơn của GHN cần.
   * Không khớp được cấp nào thì ném lỗi chỉ rõ cấp đó để người dùng sửa địa chỉ.
   */
  async resolve(
    input: {
      province: string | null;
      district: string | null;
      ward: string | null;
    },
    creds: Creds,
  ): Promise<{ districtId: number; wardCode: string }> {
    const { province, district, ward } = input;
    if (!province || !district || !ward) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        'Địa chỉ giao hàng phải có đủ Tỉnh/Thành, Quận/Huyện và Phường/Xã để tạo vận đơn GHN',
        422,
      );
    }

    const provinces = await this.cached('provinces', () =>
      this.client.getProvinces(creds),
    );
    const p = matchOne(
      provinces.map((x) => ({
        name: x.ProvinceName,
        extensions: x.NameExtension,
        id: x.ProvinceID,
      })),
      province,
    );
    if (!p) throw this.notFound('Tỉnh/Thành', province);

    const districts = await this.cached(`districts:${p.id}`, () =>
      this.client.getDistricts(p.id, creds),
    );
    const d = matchOne(
      districts.map((x) => ({
        name: x.DistrictName,
        extensions: x.NameExtension,
        id: x.DistrictID,
      })),
      district,
    );
    if (!d) throw this.notFound('Quận/Huyện', district);

    const wards = await this.cached(`wards:${d.id}`, () =>
      this.client.getWards(d.id, creds),
    );
    const w = matchOne(
      wards.map((x) => ({
        name: x.WardName,
        extensions: x.NameExtension,
        code: x.WardCode,
      })),
      ward,
    );
    if (!w) throw this.notFound('Phường/Xã', ward);

    return { districtId: d.id, wardCode: w.code };
  }

  private notFound(level: string, value: string) {
    this.logger.warn(`GHN không có ${level} khớp với "${value}"`);
    return new BusinessException(
      'CARRIER_ADDRESS_UNMATCHED',
      `GHN không nhận diện được ${level} "${value}". Vui lòng chọn lại địa chỉ giao hàng.`,
      422,
    );
  }
}
