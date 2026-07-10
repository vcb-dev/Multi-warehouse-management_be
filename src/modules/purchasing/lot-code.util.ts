import type { Prisma } from '@prisma/client';

// Chuẩn hoá tiền tố mã lô: bỏ dấu, bỏ từ pháp lý (TNHH, Cổ phần...),
// lấy 2 ký tự đầu của từ có nghĩa cuối cùng trong tên NCC.
// VD: "VGEMS" -> "VG", "Công ty TNHH Thiết bị ABC" -> "AB".
const LEGAL_FORM_STOPWORDS = new Set([
  'CONG',
  'TY',
  'CTY',
  'TNHH',
  'CO',
  'PHAN',
  'CP',
  'DNTN',
  'DOANH',
  'NGHIEP',
  'TAP',
  'DOAN',
  'GROUP',
  'JSC',
  'LTD',
  'LIMITED',
  'CORP',
  'CORPORATION',
  'JOINT',
  'STOCK',
  'COMPANY',
]);

function stripDiacritics(input: string): string {
  return input
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

export function supplierLotPrefix(name: string): string {
  const normalized = stripDiacritics(name).toUpperCase();
  const tokens = normalized.split(/[^A-Z0-9]+/).filter(Boolean);
  const significant = tokens.filter((t) => !LEGAL_FORM_STOPWORDS.has(t));
  const pool = significant.length ? significant : tokens;
  const source = pool.length ? pool[pool.length - 1] : 'NCC';
  return source.slice(0, 2).padEnd(2, 'X');
}

export function generateSupplierLotCode(
  supplierName: string,
  sequence: number,
): string {
  return `${supplierLotPrefix(supplierName)}-${String(sequence).padStart(4, '0')}`;
}

type LotLookupClient = {
  lot: {
    findFirst: (args: {
      where: { code: { startsWith: string } };
      orderBy: { code: 'desc' };
      select: { code: true };
    }) => Promise<{ code: string } | null>;
  };
};

// Số thứ tự mã lô lấy theo mã lô lớn nhất đã cấp cho tiền tố này (không phải
// đếm số phiếu nhập còn lại) — để không bị cấp trùng sau khi phiếu nháp bị
// hủy hẳn (xóa khỏi DB).
export async function nextSupplierLotSequence(
  db: LotLookupClient | Prisma.TransactionClient,
  prefix: string,
): Promise<number> {
  const latest = await (db as LotLookupClient).lot.findFirst({
    where: { code: { startsWith: `${prefix}-` } },
    orderBy: { code: 'desc' },
    select: { code: true },
  });
  if (!latest) return 1;
  const seq = Number(latest.code.slice(prefix.length + 1));
  return Number.isFinite(seq) ? seq + 1 : 1;
}
