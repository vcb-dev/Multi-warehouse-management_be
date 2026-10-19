import type {
  SapoOption,
  SapoProduct,
  SapoVariant,
} from '../products/sapo-sync/sapo-client';

/**
 * Nhóm hàng tính là trang sức — so khớp CHÍNH XÁC phần trước `>>` của `product_type`
 * Sapo (VD `NHẪN >> Bạc` → `NHẪN`). So khớp chính xác chứ không `includes` để `CHARM DA`
 * (đồ da) không lọt vào, và người dùng đã chốt loại `CHARM`, `VẬT PHẨM, QUÀ TẶNG`.
 */
export const JEWELRY_GROUPS = [
  'NHẪN',
  'BÔNG TAI',
  'DÂY CHUYỀN',
  'MẶT DÂY CHUYỀN',
  'LẮC',
  'KIỀNG',
  'VÒNG',
  'ĐÁ QUÝ',
  'MẶT LẮC TAY',
] as const;

const JEWELRY_SET = new Set<string>(JEWELRY_GROUPS);

/** Lệch giờ VN so với UTC — ngày snapshot và số ngày tồn tính theo lịch cửa hàng. */
const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Chuẩn hoá tên nhóm: NFC (Sapo trả lẫn NFD/NFC), gộp khoảng trắng, viết hoa. */
export function normalizeGroup(raw: string): string {
  return raw.normalize('NFC').trim().replace(/\s+/g, ' ').toUpperCase();
}

/** `NHẪN >> Bạc` → `NHẪN`; rỗng → null. */
export function productGroup(productType?: string | null): string | null {
  if (!productType) return null;
  const group = normalizeGroup(productType.split('>>')[0]);
  return group || null;
}

export function isJewelryGroup(group: string | null): group is string {
  return group !== null && JEWELRY_SET.has(group);
}

/** Bỏ dấu tiếng Việt + viết thường, để so tên option gõ tay (`Màu Sắc`, `màu`, `Kích thước`). */
function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

const SIZE_OPTION_NAMES = new Set(['size', 'kich thuoc', 'kich co', 'co']);

function isSizeOption(name: string): boolean {
  return SIZE_OPTION_NAMES.has(fold(name));
}

function isColorOption(name: string): boolean {
  const f = fold(name);
  return f.startsWith('mau') || f === 'color';
}

/** Placeholder của Sapo cho hàng không phân loại — không phải giá trị thật. */
const isPlaceholder = (v: string | null | undefined): boolean =>
  !v || v.trim() === '' || v === 'Default Title';

/**
 * Lấy size/màu của một phiên bản. Sapo xếp `option1/2/3` theo thứ tự `position` của
 * `options` — giống cách `SapoProductSyncService` lưu `variant_option_values`.
 */
export function pickSizeColor(
  options: Pick<SapoOption, 'name' | 'position'>[] | null | undefined,
  variant: Pick<SapoVariant, 'option1' | 'option2' | 'option3'>,
): { size: string | null; color: string | null } {
  const sorted = [...(options ?? [])].sort(
    (a, b) => (a.position ?? 0) - (b.position ?? 0),
  );
  const values = [variant.option1, variant.option2, variant.option3];
  let size: string | null = null;
  let color: string | null = null;
  sorted.forEach((o, i) => {
    const value = values[i];
    if (!o?.name || isPlaceholder(value)) return;
    if (size === null && isSizeOption(o.name)) size = value!.trim();
    else if (color === null && isColorOption(o.name)) color = value!.trim();
  });
  return { size, color };
}

/**
 * Mã SKU theo "QUY TẮC ĐẶT MÃ MỚI CHO TRANG SỨC" (sheet `QUY ƯỚC MÃ MỚI` trong
 * `Màn_Tồn_Kho.xlsx`): `[chữ cái][4 số]-[size]-[chất liệu]-[màu]`, VD `N0001-05-S-WH`.
 * Hàng không chia phiên bản (~930/1.756 dòng còn hàng 17/10/2026) không có option size/màu,
 * nên đây là nguồn dự phòng — option của Sapo luôn được ưu tiên. Mã kiểu cũ
 * (`N700426`, `B400271-3`) không theo quy ước nào thống nhất nên không đoán.
 */
const NEW_SKU = /^[A-Z]\d{4}-(\d{2})-[A-Z]{1,2}\d{0,2}(?:-([A-Z]{2}))?$/;

const SKU_COLORS: Record<string, string> = {
  WH: 'Trắng',
  BK: 'Đen',
  BL: 'Xanh dương',
  GN: 'Xanh lá',
  RD: 'Đỏ',
  PK: 'Hồng',
  YL: 'Vàng',
  RB: 'Cầu vồng',
};

/** Màu từ đuôi SKU mã mới; mã màu lạ trả nguyên ký hiệu. */
export function colorFromSku(sku: string | null | undefined): string | null {
  const code = sku?.trim().match(NEW_SKU)?.[2];
  return code ? (SKU_COLORS[code] ?? code) : null;
}

/**
 * Size từ SKU mã mới — CHỈ khi mã không mơ hồ. Đối chiếu 325 dòng có cả option lẫn SKU
 * (17/10/2026) thấy số size không phải lúc nào cũng là số đo: lắc nửa cm dùng số thứ tự
 * (`L0014-03` = 16.5 cm), nhẫn 10.5 ghi `15`. Nên chỉ đọc các dạng đã khớp 100%:
 * `00` = Free size; nhẫn 04–12 và x5 ≥ 45 (55 → 5.5); dây chuyền ≥ 30 và lắc ≥ 10 là cm;
 * kiềng ≥ 40 là mm. Còn lại (bông tai `50`, lắc `03`, nhẫn `15`…) để trống.
 */
export function sizeFromSku(
  sku: string | null | undefined,
  group: string,
): string | null {
  const code = sku?.trim().match(NEW_SKU)?.[1];
  if (!code) return null;
  if (code === '00') return 'Free size';
  const n = Number(code);
  switch (group) {
    case 'NHẪN':
      if (n >= 4 && n <= 12) return String(n);
      if (n >= 45 && n % 10 === 5) return `${(n - 5) / 10}.5`;
      return null;
    case 'DÂY CHUYỀN':
      return n >= 30 ? `${n} cm` : null;
    case 'LẮC':
      return n >= 10 ? `${n} cm` : null;
    case 'KIỀNG':
      return n >= 40 ? `${n} mm` : null;
    default:
      return null;
  }
}

/** Tên phiên bản để hiển thị; `Default Title` (hàng không phân loại) → null. */
export function variantTitle(title: string | null | undefined): string | null {
  return isPlaceholder(title) ? null : title!.trim();
}

/** Ảnh riêng của phiên bản nếu có, không thì ảnh đại diện sản phẩm. */
export function pickImage(
  product: Pick<SapoProduct, 'images' | 'image'>,
  variant: Pick<SapoVariant, 'image_id'>,
): string | null {
  const images = product.images ?? [];
  if (variant.image_id != null) {
    const own = images.find((img) => img.id === variant.image_id);
    if (own?.src) return own.src;
  }
  if (product.image?.src) return product.image.src;
  const first = [...images].sort((a, b) => a.position - b.position)[0];
  return first?.src ?? null;
}

/** Ngày theo lịch VN của một thời điểm, dạng `YYYY-MM-DD`. */
export function vnDateKey(d: Date): string {
  return new Date(d.getTime() + VN_OFFSET_MS).toISOString().slice(0, 10);
}

/** Số ngày lịch VN từ `since` tới ngày `asOf` (`YYYY-MM-DD`); không âm. */
export function daysSince(since: Date, asOf: string): number {
  const diff =
    (Date.parse(`${asOf}T00:00:00Z`) -
      Date.parse(`${vnDateKey(since)}T00:00:00Z`)) /
    DAY_MS;
  return Math.max(0, Math.round(diff));
}

/**
 * Khung `[min, max)` của `days` ngày lịch VN tròn TRƯỚC ngày `asOf` (không gồm hôm nay):
 * snapshot ngày 18 đếm đơn từ 0h ngày 18 tháng trước tới 0h ngày 18. Chạy giữa ngày
 * ra cùng con số, không lẫn nửa ngày hôm nay.
 */
export function salesWindow(
  asOf: string,
  days: number,
): { min: Date; max: Date } {
  const max = new Date(Date.parse(`${asOf}T00:00:00Z`) - VN_OFFSET_MS);
  return { min: new Date(max.getTime() - days * DAY_MS), max };
}

export interface SapoOrderForSales {
  status?: string | null;
  cancelled_on?: string | null;
  line_items?: {
    variant_id?: number | null;
    quantity?: number | string | null;
    current_quantity?: number | string | null;
    deleted?: boolean | null;
  }[];
}

/**
 * Số lượng bán của từng phiên bản trong một đơn Sapo — cùng quy ước "Bán 30 ngày" của màn
 * NXT: bỏ đơn huỷ; dòng `deleted` (Sapo vẫn trả về) không tính; số lượng là
 * `current_quantity` (đã trừ phần trả/bớt), thiếu thì mới dùng `quantity`.
 */
export function orderSoldQty(order: SapoOrderForSales): Map<number, number> {
  const out = new Map<number, number>();
  if (order.status === 'cancelled' || order.cancelled_on) return out;
  for (const li of order.line_items ?? []) {
    if (li.deleted || li.variant_id == null) continue;
    const qty = Math.round(Number(li.current_quantity ?? li.quantity ?? 0));
    if (qty <= 0) continue;
    out.set(li.variant_id, (out.get(li.variant_id) ?? 0) + qty);
  }
  return out;
}

export interface ReceiptLot {
  receivedOn: Date;
  qty: number;
}

export type LayerSource = 'receipt' | 'created';

export interface StockLayer {
  since: Date;
  qty: number;
  source: LayerSource;
}

/**
 * Tách tồn hiện tại thành các lớp theo ngày nhập, giả định nhập trước xuất trước (FIFO):
 * hàng đã bán là hàng cũ, nên số còn lại ứng với các phiếu nhập MỚI NHẤT. Đi từ phiếu mới
 * về cũ, lấy dần tới khi đủ `onHand`; trả về các lớp theo thứ tự mới → cũ.
 *
 * Phần tồn không phiếu nhập nào phủ được (tồn đầu kỳ lúc lên Sapo 09/2025, hàng trả về,
 * kiểm kho tăng…) nằm TRƯỚC mọi phiếu theo FIFO, nên mốc của nó là `fallbackSince` (ngày
 * tạo phiên bản Sapo) nhưng không muộn hơn phiếu cũ nhất đã dùng. Đây là cận dưới — tuổi
 * thật có thể lâu hơn.
 *
 * Phiếu nhập tính trên TOÀN CÔNG TY chứ không theo kho: Sapo không mở API chuyển kho
 * (403), nên hàng chuyển sang kho khác không có phiếu ở kho mới mà vẫn phải giữ tuổi.
 */
export function fifoLayers(
  onHand: number,
  receipts: ReceiptLot[],
  fallbackSince: Date,
): StockLayer[] {
  if (onHand <= 0) return [];
  const newestFirst = receipts
    .filter((r) => r.qty > 0)
    .sort((a, b) => b.receivedOn.getTime() - a.receivedOn.getTime());

  const layers: StockLayer[] = [];
  let left = onHand;
  for (const r of newestFirst) {
    if (left <= 0) break;
    const qty = Math.min(left, r.qty);
    layers.push({ since: r.receivedOn, qty, source: 'receipt' });
    left -= qty;
  }

  if (left > 0) {
    const oldestUsed = layers.at(-1)?.since;
    const since =
      oldestUsed && oldestUsed.getTime() < fallbackSince.getTime()
        ? oldestUsed
        : fallbackSince;
    layers.push({ since, qty: left, source: 'created' });
  }
  return layers;
}

/** Số lượng thuộc các lớp đã tồn ít nhất `minDays` ngày tính tới `asOf`. */
export function agedQty(
  layers: Pick<StockLayer, 'since' | 'qty'>[],
  minDays: number,
  asOf: string,
): number {
  return layers.reduce(
    (sum, l) => (daysSince(l.since, asOf) >= minDays ? sum + l.qty : sum),
    0,
  );
}
