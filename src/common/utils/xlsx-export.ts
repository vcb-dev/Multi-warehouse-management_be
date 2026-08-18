import type { Response } from 'express';
import * as ExcelJS from 'exceljs';

const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * Trần số dòng cho mọi file xuất. Dữ liệu thật có ~93k đơn, dựng cả workbook
 * trong RAM ở cỡ đó là treo request chắc chắn — nên vừa stream từng dòng vừa
 * chặn trần, thay vì để người dùng chờ tới lúc timeout.
 *
 * Vượt trần thì file vẫn hợp lệ, chỉ cắt bớt: FE cảnh báo trước khi xuất.
 */
export const EXPORT_ROW_LIMIT = 50_000;

/**
 * Một trường (cột) có thể xuất. Catalog của mỗi màn là mảng các trường này,
 * vừa dùng để dựng cột file vừa để sinh danh sách cho dialog chọn trường.
 */
export type ExportField<T> = {
  key: string;
  header: string;
  /** Nhóm trong dialog chọn trường, VD "Thông tin đơn hàng" */
  group: string;
  width?: number;
  /** Tick sẵn khi người dùng chưa tự chọn trường nào */
  default?: boolean;
  /** Luôn xuất, không bỏ tick được (cột định danh như STT / Mã đơn hàng) */
  locked?: boolean;
  value: (row: T) => ExcelJS.CellValue;
};

/** Mô tả trường trả cho FE dựng dialog "Tùy chọn trường dữ liệu xuất" */
export type ExportFieldMeta = {
  key: string;
  label: string;
  group: string;
  default: boolean;
  locked: boolean;
};

export function describeFields<T>(
  catalog: ExportField<T>[],
): ExportFieldMeta[] {
  return catalog.map((f) => ({
    key: f.key,
    label: f.header,
    group: f.group,
    default: f.default ?? false,
    locked: f.locked ?? false,
  }));
}

/**
 * Chọn và sắp thứ tự cột theo tham số `fields` (các key cách nhau bởi dấu phẩy,
 * thứ tự trong chuỗi chính là thứ tự cột trong file).
 *
 * Bỏ trống → lấy các trường `default`. Key lạ bị bỏ qua. Trường `locked` luôn
 * được chèn lại để file xuất không bao giờ mất cột định danh, kể cả khi FE gửi
 * lên danh sách cũ đã lưu từ trước.
 */
export function resolveFields<T>(
  catalog: ExportField<T>[],
  fields?: string,
): ExportField<T>[] {
  const byKey = new Map(catalog.map((f) => [f.key, f]));
  const requested = (fields ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const picked = requested.length
    ? requested
        .map((k) => byKey.get(k))
        .filter((f): f is ExportField<T> => f !== undefined)
    : catalog.filter((f) => f.default);

  // Không key nào hợp lệ → coi như không chọn gì, xuất trọn catalog còn hơn file rỗng cột
  const chosen = picked.length ? dedupe(picked) : catalog;
  const chosenKeys = new Set(chosen.map((f) => f.key));
  const missingLocked = catalog.filter(
    (f) => f.locked && !chosenKeys.has(f.key),
  );
  return [...missingLocked, ...chosen];
}

function dedupe<T>(fields: ExportField<T>[]): ExportField<T>[] {
  const seen = new Set<string>();
  return fields.filter((f) => (seen.has(f.key) ? false : seen.add(f.key)));
}

/**
 * Ghi thẳng .xlsx xuống response theo kiểu stream: chỉ giữ trong RAM đúng một
 * lô dòng tại một thời điểm. `batches` là async iterable để nơi gọi tự quyết
 * cách phân lô (cursor Prisma, chia trang…).
 *
 * Trả về số dòng đã ghi và `truncated` = đã dừng vì chạm trần. Trường hợp dữ
 * liệu dài ĐÚNG bằng trần cũng tính là `truncated`: muốn phân biệt thì phải nạp
 * thêm một lô nữa chỉ để biết nó rỗng, mà một lô ở đây là cả một vòng truy vấn
 * DB — không đáng, vì người dùng dù sao cũng cần lọc hẹp lại.
 */
export async function streamXlsx<T>(
  res: Response,
  opts: {
    filename: string;
    sheetName: string;
    fields: ExportField<T>[];
    batches: AsyncIterable<T[]>;
  },
): Promise<{ written: number; truncated: boolean }> {
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${opts.filename}"`,
  );
  res.setHeader('Content-Type', XLSX_MIME);

  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream: res,
    useStyles: false,
    useSharedStrings: false,
  });
  const sheet = workbook.addWorksheet(opts.sheetName);
  // Gán columns cho worksheet-writer sẽ tự ghi luôn hàng tiêu đề
  sheet.columns = opts.fields.map((f) => ({
    header: f.header,
    key: f.key,
    width: f.width ?? 18,
  }));

  let written = 0;
  let truncated = false;
  for await (const batch of opts.batches) {
    for (const row of batch) {
      if (written >= EXPORT_ROW_LIMIT) break;
      sheet.addRow(opts.fields.map((f) => f.value(row))).commit();
      written += 1;
    }
    // Chốt trần ở vòng NGOÀI: nếu chỉ chặn ở vòng trong thì lô cuối vừa khít
    // trần sẽ không kích hoạt điều kiện, và `for await` kéo thêm một lô nữa —
    // tức thêm nguyên một vòng truy vấn DB rồi vứt đi.
    if (written >= EXPORT_ROW_LIMIT) {
      truncated = true;
      break;
    }
  }

  sheet.commit();
  await workbook.commit();
  return { written, truncated };
}

/** Bọc một mảng đã nạp sẵn thành `batches` cho {@link streamXlsx} */
export async function* singleBatch<T>(rows: T[]): AsyncIterable<T[]> {
  yield rows;
}

/** Ngày giờ kiểu Việt cho ô Excel — để chuỗi cho chắc, tránh lệch timezone khi mở file */
export function vnDateTime(d: Date | null | undefined): string {
  if (!d) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Tên file kèm ngày xuất, VD `don-hang-17-08-2026.xlsx` */
export function exportFilename(prefix: string): string {
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${prefix}-${p(now.getDate())}-${p(now.getMonth() + 1)}-${now.getFullYear()}.xlsx`;
}
