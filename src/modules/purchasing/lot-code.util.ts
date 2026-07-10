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
