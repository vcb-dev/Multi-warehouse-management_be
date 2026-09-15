/**
 * Quy tắc nhận diện khách hàng trùng khi tạo mới — hàm thuần, không chạm DB.
 *
 * SQL chỉ lọc thô ra một tập ỨNG VIÊN (luôn rộng hơn kết quả), còn quyết định
 * "trùng hay không" nằm hết ở đây để hai phía so sánh đi qua cùng một phép
 * chuẩn hoá và kiểm được bằng unit test.
 */

export type DuplicateReason = 'phone' | 'name' | 'address';

/** Bỏ dấu tiếng Việt, về chữ thường, chỉ giữ chữ-số cách nhau đúng 1 dấu cách. */
export function foldText(s: string | null | undefined): string {
  return (s ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Khoá SĐT: `+84 912…`, `84912…`, `912…` và `0912…` là cùng một số.
 * Cùng quy tắc với `repeat-customer-search.ts` (bản SQL).
 */
export function phoneKey(raw: string | null | undefined): string {
  const digits = (raw ?? '').replace(/\D/g, '');
  if (digits.startsWith('84') && digits.length === 11)
    return `0${digits.slice(2)}`;
  if (digits.length === 9) return `0${digits}`;
  return digits;
}

/**
 * Danh xưng hay dính vào tên khi nhập đơn ("Chị Nguyễn Thị Hà", "A Tuấn").
 * Cố ý bỏ "chú" vì trùng họ Chu.
 */
const HONORIFICS = new Set([
  'anh',
  'chi',
  'em',
  'co',
  'bac',
  'ong',
  'ba',
  'a',
  'c',
  'mr',
  'mrs',
  'ms',
]);

/**
 * Khoá họ tên. Dữ liệu Sapo thường dồn cả họ tên vào `first_name` và đôi khi
 * đặt danh xưng vào `last_name` ("Lan Phượng" + "Chị") — danh xưng đứng riêng
 * ở `last_name` hoặc đứng đầu tên đều bị bỏ.
 */
export function nameKey(
  firstName: string | null | undefined,
  lastName?: string | null,
): string {
  const last = foldText(lastName);
  const tokens = foldText(
    [firstName, HONORIFICS.has(last) ? '' : lastName].filter(Boolean).join(' '),
  )
    .split(' ')
    .filter(Boolean);
  while (tokens.length > 1 && HONORIFICS.has(tokens[0])) tokens.shift();
  return tokens.join(' ');
}

/** Tiền tố đơn vị hành chính — "Thành phố Hà Nội" (danh mục) và "Hà Nội" (Sapo) là một. */
const PLACE_PREFIX =
  /^(thanh pho|tp|tinh|quan|huyen|thi xa|tx|phuong|xa|thi tran|tt|p|q|h|x) /;

export function placeKey(s: string | null | undefined): string {
  return foldText(s).replace(PLACE_PREFIX, '');
}

function addressTokens(
  s: string | null | undefined,
  ignore?: Set<string>,
): Set<string> {
  return new Set(
    foldText(s)
      .split(' ')
      .filter((t) => t && !ignore?.has(t)),
  );
}

/** Từ hành chính người nhập hay chép lại vào dòng địa chỉ cụ thể. */
const ADMIN_WORDS = ['phuong', 'quan', 'huyen', 'tinh', 'tp'];

/**
 * Hai dòng địa chỉ cụ thể (số nhà, đường...) có phải một chỗ không.
 * Người nhập hay thêm bớt chữ ("Số 10 đường Gò Dầu" vs "10 Gò Dầu") nên so theo
 * độ bao phủ của chuỗi ngắn trong chuỗi dài; nhưng mọi con số của chuỗi ngắn phải
 * có mặt ở chuỗi dài để "Số 10" không bị coi là "Số 12".
 *
 * `ignore`: chữ của tên phường/quận/tỉnh — dòng địa chỉ hay chép lại chúng
 * ("Đại Mỗ" ở Phường Đại Mỗ), để lại thì hai địa chỉ không có số nhà vẫn "giống".
 */
export function isSimilarAddressLine(
  a: string | null | undefined,
  b: string | null | undefined,
  ignore?: Set<string>,
): boolean {
  const ta = addressTokens(a, ignore);
  const tb = addressTokens(b, ignore);
  const [shorter, longer] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  if (shorter.size < 2) return false;

  let shared = 0;
  for (const t of shorter) {
    if (longer.has(t)) shared++;
    else if (/^\d/.test(t)) return false;
  }
  return shared / shorter.size >= 0.8;
}

export type AddressInput = {
  address1?: string | null;
  ward?: string | null;
  district?: string | null;
  province?: string | null;
};

/**
 * Cùng địa chỉ = cùng tỉnh + cùng phường/xã + dòng địa chỉ giống nhau.
 * Quận/huyện chỉ loại khi CẢ HAI đều có mà khác nhau — địa chỉ sau sáp nhập
 * 2025 không còn cấp huyện.
 */
export function isSameAddress(
  input: AddressInput,
  candidate: AddressInput,
): boolean {
  const ward = placeKey(input.ward);
  const province = placeKey(input.province);
  if (!ward || !province) return false;
  if (placeKey(candidate.ward) !== ward) return false;
  if (placeKey(candidate.province) !== province) return false;
  const district = placeKey(input.district);
  const candidateDistrict = placeKey(candidate.district);
  if (district && candidateDistrict && district !== candidateDistrict)
    return false;

  const placeWords = new Set(
    [ward, province, district, candidateDistrict]
      .join(' ')
      .split(' ')
      .concat(ADMIN_WORDS),
  );
  return isSimilarAddressLine(input.address1, candidate.address1, placeWords);
}

/** Đủ dữ liệu để so địa chỉ chưa — thiếu phường/tỉnh thì tập ứng viên quá rộng. */
export function canMatchAddress(input: AddressInput): boolean {
  return (
    !!placeKey(input.ward) &&
    !!placeKey(input.province) &&
    addressTokens(input.address1).size >= 2
  );
}

/** Tên một chữ ("Hà", "Tuấn") trùng hàng trăm khách — không đủ làm tín hiệu. */
export function canMatchName(key: string): boolean {
  return key.split(' ').filter(Boolean).length >= 2;
}

/** SĐT trùng xếp đầu (chặn tạo), sau đó khớp nhiều tiêu chí hơn, rồi khách mua nhiều hơn. */
export function compareDuplicates(
  a: { matched: DuplicateReason[]; orders_count: number },
  b: { matched: DuplicateReason[]; orders_count: number },
): number {
  const phone =
    Number(b.matched.includes('phone')) - Number(a.matched.includes('phone'));
  if (phone) return phone;
  if (a.matched.length !== b.matched.length)
    return b.matched.length - a.matched.length;
  return b.orders_count - a.orders_count;
}
