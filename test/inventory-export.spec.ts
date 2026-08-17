/**
 * Xuất file danh sách tồn kho.
 * Chạy: npm test -- test/inventory-export.spec.ts
 *
 * Toàn bộ mock, KHÔNG chạm DB.
 */
import { Writable } from 'node:stream';
import * as ExcelJS from 'exceljs';
import type { Response } from 'express';
import { InventoryExportService } from '../src/modules/inventory/inventory-import-export.service';
import type { InventoryQueryService } from '../src/modules/inventory/inventory-query.service';
import { EXPORT_ROW_LIMIT } from '../src/common/utils/xlsx-export';
import { adminAuth } from './helpers/auth';

const user = adminAuth();

function fakeResponse() {
  const chunks: Buffer[] = [];
  const headers: Record<string, string> = {};
  const res = new Writable({
    write(chunk: Buffer, _enc, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    },
  }) as Writable & { setHeader: (k: string, v: string) => void };
  res.setHeader = (k, v) => {
    headers[k] = v;
  };
  return {
    res: res as unknown as Response,
    headers,
    buffer: () => Buffer.concat(chunks),
  };
}

async function readSheet(buffer: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const sheet = wb.worksheets[0];
  const header = (sheet.getRow(1).values as unknown[]).slice(1).map(String);
  const rows: unknown[][] = [];
  for (let i = 2; i <= sheet.rowCount; i++) {
    rows.push((sheet.getRow(i).values as unknown[]).slice(1));
  }
  return { header, rows, rowCount: sheet.rowCount };
}

function cell(header: string[], row: unknown[], column: string) {
  const idx = header.indexOf(column);
  if (idx < 0) throw new Error(`Không có cột "${column}" trong file`);
  return row[idx];
}

/** Một dòng tồn đã qua serialize + enrich NXT, đúng hình dạng `exportRows` trả về */
function makeRow(over: Record<string, unknown> = {}) {
  return {
    variant_id: '10',
    location_id: '1',
    product_id: '100',
    sku: 'SKU-1',
    product_name: 'Áo thun',
    image_url: null,
    unit: 'Cái',
    location_code: 'KHN',
    location_name: 'Kho HN',
    on_hand: 20,
    committed: 2,
    packed: 3,
    unavailable: 1,
    incoming: 5,
    available: 15,
    price: '150000',
    cost: '100000',
    updated_at: '2026-08-17T00:00:00.000Z',
    ma_sp: 'SKU',
    ton_dau_ky: 10,
    sl_nhap: 15,
    sl_xuat: 5,
    ban_15: 4,
    ban_30: 9,
    ban_90: 20,
    nk_dang_ve: 0,
    ck_dang_ve: 0,
    dm_ton_min_15: 4.33,
    can_nhap_15: 0,
    isr: 2.22,
    xep_loai_ban: 'Bán CHẬM',
    tinh_trang_code: 'B1',
    tinh_trang: 'Bán CHẬM-Tồn AN TOÀN',
    ncc: 'NCC A',
    nhom_hang_1: 'Thời trang',
    nhom_hang_2: null,
    nhom_hang_3: null,
    ...over,
  };
}

function makeService(rows: ReturnType<typeof makeRow>[]) {
  const exportRows = jest.fn().mockResolvedValue(rows);
  const service = new InventoryExportService({
    exportRows,
  } as unknown as InventoryQueryService);
  return { service, exportRows };
}

describe('InventoryExportService.fields', () => {
  it('bộ mặc định giữ nguyên các cột NXT của màn Tồn kho', () => {
    const { service } = makeService([]);
    const defaults = service
      .fields()
      .data.filter((f) => f.default)
      .map((f) => f.label);

    expect(defaults).toEqual([
      'Mã SP',
      'Mã SKU',
      'Sản phẩm',
      'Giá bán',
      'Giá vốn',
      'Đơn vị tính',
      'Tồn đầu kì',
      'SL Nhập',
      'SL Xuất',
      'Tồn kho',
      'Có thể bán',
      'Bán 15 ngày',
      'Bán 30 ngày',
      'Bán 90 ngày',
      'Hàng đặt',
      'Hàng NK đang về',
      'Chuyển kho đang về',
      'ĐM tồn MIN 15 ngày',
      'Cần nhập đủ bán 15 ngày',
      'Tồn/Bán (ISR)',
      'Tình trạng',
      'NCC',
      'Nhóm hàng 1',
      'Nhóm hàng 2',
      'Nhóm hàng 3',
      'Đang đóng gói',
      'Không thể bán',
    ]);
  });

  it('có cột kho để phân biệt dòng khi xuất nhiều kho cùng lúc', () => {
    const { service } = makeService([]);
    const keys = service.fields().data.map((f) => f.key);
    expect(keys).toEqual(
      expect.arrayContaining(['location_name', 'location_code']),
    );
  });
});

describe('InventoryExportService.export', () => {
  it('chặn trần ngay ở tầng truy vấn thay vì chỉ cắt lúc ghi', async () => {
    // Nạp thừa rồi mới cắt là kéo về dữ liệu vứt đi — enrich NXT rất đắt
    const { service, exportRows } = makeService([makeRow()]);

    const out = fakeResponse();
    await service.export({ location_id: '1' }, user, out.res);

    expect(exportRows).toHaveBeenCalledWith(
      expect.objectContaining({
        location_id: '1',
        page: 1,
        page_size: EXPORT_ROW_LIMIT,
      }),
      user,
    );
  });

  it('cột "Đang đóng gói" lấy đúng field `packed` của API', async () => {
    // Từng trỏ nhầm sang `packing` nên cột này luôn trống ở cả bảng lẫn file
    const { service } = makeService([makeRow({ packed: 7 })]);

    const out = fakeResponse();
    await service.export({}, user, out.res);

    const { header, rows } = await readSheet(out.buffer());
    expect(cell(header, rows[0], 'Đang đóng gói')).toBe(7);
  });

  it('giá bán/giá vốn ra số dù API trả chuỗi', async () => {
    const { service } = makeService([
      makeRow({ price: '150000', cost: '100000' }),
    ]);

    const out = fakeResponse();
    await service.export({}, user, out.res);

    const { header, rows } = await readSheet(out.buffer());
    expect(cell(header, rows[0], 'Giá bán')).toBe(150_000);
    expect(cell(header, rows[0], 'Giá vốn')).toBe(100_000);
  });

  it('ISR null (chưa bán được gì) để trống thay vì ghi chữ "null"', async () => {
    const { service } = makeService([makeRow({ isr: null })]);

    const out = fakeResponse();
    await service.export({}, user, out.res);

    const { header, rows } = await readSheet(out.buffer());
    expect(cell(header, rows[0], 'Tồn/Bán (ISR)')).toBeUndefined();
  });

  it('nhóm hàng thiếu cấp thì để trống, không ghi "null"', async () => {
    const { service } = makeService([
      makeRow({ nhom_hang_1: 'Thời trang', nhom_hang_2: null }),
    ]);

    const out = fakeResponse();
    await service.export({}, user, out.res);

    const { header, rows } = await readSheet(out.buffer());
    expect(cell(header, rows[0], 'Nhóm hàng 1')).toBe('Thời trang');
    expect(cell(header, rows[0], 'Nhóm hàng 2')).toBeUndefined();
  });

  it('`fields` chọn được cột ngoài bộ mặc định, cột locked vẫn còn', async () => {
    const { service } = makeService([makeRow()]);

    const out = fakeResponse();
    await service.export({ fields: 'location_name,on_hand' }, user, out.res);

    const { header, rows } = await readSheet(out.buffer());
    expect(header).toEqual(['Mã SKU', 'Kho', 'Tồn kho']);
    expect(cell(header, rows[0], 'Kho')).toBe('Kho HN');
  });

  it('không có dòng tồn nào thì vẫn ra file hợp lệ', async () => {
    const { service } = makeService([]);

    const out = fakeResponse();
    await service.export({}, user, out.res);

    const { rowCount } = await readSheet(out.buffer());
    expect(rowCount).toBe(1);
    expect(out.headers['Content-Disposition']).toContain('ton-kho-');
  });
});
