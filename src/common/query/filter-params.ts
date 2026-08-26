/**
 * Tiện ích đọc tham số lọc cho các màn danh sách (đơn hàng, tồn kho, sản phẩm,
 * vận đơn). Mọi màn dùng chung một hợp đồng query param — bám theo Sapo Open API:
 *
 * - chọn nhiều  → `status=open,closed`          (các giá trị là HOẶC)
 * - khoảng số   → `available_min` / `available_max`  (bao gồm cả hai đầu mút)
 * - khoảng ngày → `created_on_min` / `created_on_max` (đặt tên theo sự kiện)
 * - thực thể    → `customer_ids=17,42`          (tên số nhiều, danh sách id)
 * - có/không    → `printed=true`
 *
 * Các tiêu chí khác nhau nối bằng VÀ.
 */

/**
 * Lệch phút so với UTC của múi giờ cửa hàng. Mặc định +07:00 (Việt Nam).
 *
 * Ngày dạng `YYYY-MM-DD` người dùng gõ là ngày theo giờ cửa hàng, không phải
 * giờ UTC — thiếu phần bù này thì "đến hết 26/08" sẽ cắt mất 7 tiếng cuối ngày
 * và đơn tạo lúc 20h tối rơi ra ngoài kết quả.
 */
function storeOffsetMinutes(): number {
  const raw = process.env.STORE_UTC_OFFSET_MINUTES?.trim();
  if (!raw) return 420;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 420;
}

/** Tách chuỗi ngăn bằng dấu phẩy → mảng đã trim, bỏ phần tử rỗng. */
export function parseList(raw?: string | null): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  const list = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length ? list : undefined;
}

/**
 * Như {@link parseList} nhưng lọc bỏ giá trị không thuộc `allowed`.
 *
 * Trả `[]` (chứ không phải `undefined`) khi tham số có gửi lên mà không giá trị
 * nào hợp lệ: `{ in: [] }` cho ra 0 dòng, đúng ý "lọc theo thứ không tồn tại".
 * Bỏ qua bộ lọc trong trường hợp đó sẽ hiện ra toàn bộ danh sách — sai và khó thấy.
 */
export function parseEnumList<T extends string>(
  raw: string | null | undefined,
  allowed: readonly T[],
): T[] | undefined {
  const list = parseList(raw);
  if (!list) return undefined;
  const set = new Set<string>(allowed);
  return list.filter((v): v is T => set.has(v));
}

/** Danh sách id → bigint[]. Bỏ qua phần tử không phải số nguyên. */
export function parseIdList(raw?: string | null): bigint[] | undefined {
  const list = parseList(raw);
  if (!list) return undefined;
  const ids = list.filter((v) => /^\d+$/.test(v)).map((v) => BigInt(v));
  return ids.length ? ids : undefined;
}

/**
 * Khoảng số cho Prisma. Bao gồm cả hai đầu mút, nên `min=0&max=0` tìm đúng
 * những dòng bằng 0 — trường hợp dùng nhiều nhất ở màn tồn kho (hết sạch hàng).
 * Nhận số âm vì tồn kho âm là dữ liệu có thật.
 */
export function parseIntRange(
  min?: number | string | null,
  max?: number | string | null,
): { gte?: number; lte?: number } | undefined {
  const range: { gte?: number; lte?: number } = {};
  const lo = toFiniteNumber(min);
  const hi = toFiniteNumber(max);
  if (lo !== undefined) range.gte = lo;
  if (hi !== undefined) range.lte = hi;
  return range.gte === undefined && range.lte === undefined ? undefined : range;
}

function toFiniteNumber(value?: number | string | null): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number(value.trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Khoảng ngày cho Prisma, quy đổi theo giờ cửa hàng.
 *
 * `YYYY-MM-DD` được nở ra trọn ngày: `_min` lấy 00:00:00.000, `_max` lấy
 * 23:59:59.999. Chuỗi có kèm giờ thì giữ nguyên, không nở.
 */
export function parseDateRange(
  min?: string | null,
  max?: string | null,
): { gte?: Date; lte?: Date } | undefined {
  const range: { gte?: Date; lte?: Date } = {};
  const from = parseBoundary(min, 'start');
  const to = parseBoundary(max, 'end');
  if (from) range.gte = from;
  if (to) range.lte = to;
  return !range.gte && !range.lte ? undefined : range;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseBoundary(
  raw: string | null | undefined,
  edge: 'start' | 'end',
): Date | undefined {
  const value = raw?.trim();
  if (!value) return undefined;

  const dateOnly = DATE_ONLY.exec(value);
  if (dateOnly) {
    const [, y, m, d] = dateOnly;
    const utcMs =
      edge === 'start'
        ? Date.UTC(Number(y), Number(m) - 1, Number(d), 0, 0, 0, 0)
        : Date.UTC(Number(y), Number(m) - 1, Number(d), 23, 59, 59, 999);
    return new Date(utcMs - storeOffsetMinutes() * 60_000);
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/** `?printed=true` / `false`. Giá trị lạ coi như không lọc. */
export function parseBool(raw?: string | boolean | null): boolean | undefined {
  if (typeof raw === 'boolean') return raw;
  const value = raw?.trim().toLowerCase();
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return undefined;
}

/**
 * Nối thêm một mệnh đề vào `where.AND`.
 *
 * Bắt buộc dùng cho mọi bộ lọc có sinh ra `OR`: `listShipments` đã gán
 * `where.OR` cho ô tìm kiếm và `buildListWhere` của đơn hàng gán `where.OR`
 * cho `status=closed` — gán trực tiếp thêm lần nữa sẽ đè mất cái trước.
 */
export function appendAnd<W extends { AND?: unknown }>(
  where: W,
  clause: object,
): void {
  (where as { AND?: unknown[] }).AND = [
    ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
    clause,
  ];
}

/**
 * Mệnh đề khớp một phần, không phân biệt hoa thường, cho một cột văn bản —
 * nhiều giá trị nối bằng HOẶC.
 *
 * Dùng cho những tiêu chí mà giao diện cho gõ tay (nhãn hiệu, loại sản phẩm):
 * chưa có endpoint trả danh sách giá trị phân biệt nên không thể bắt người dùng
 * gõ trúng từng ký tự. Tiêu chí nào chọn từ danh sách thật thì dùng `in` cho
 * khớp chính xác.
 */
export function textContainsAny(
  field: string,
  values: string[],
): { OR: Record<string, { contains: string; mode: 'insensitive' }>[] } {
  return {
    OR: values.map((value) => ({
      [field]: { contains: value, mode: 'insensitive' as const },
    })),
  };
}

/** Lấy giá trị đầu tiên có mặt — dùng cho cặp tên mới / tên cũ tương thích ngược. */
export function firstDefined<T>(
  ...values: (T | undefined | null)[]
): T | undefined {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}
