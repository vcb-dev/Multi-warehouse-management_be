import type { Response } from 'express';

const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * Trả file .xlsx về client. Trích ra vì 3 nơi đang lặp y hệt đoạn set header
 * (tồn kho, sản phẩm, báo cáo).
 *
 * Gửi nguyên buffer chứ không stream — các export hiện tại đều dựng workbook trong RAM
 * bằng exceljs nên đã có sẵn buffer.
 */
export function sendXlsx(res: Response, buffer: Buffer, filename: string) {
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', XLSX_MIME);
  res.send(buffer);
}
