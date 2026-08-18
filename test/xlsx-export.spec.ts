/**
 * Lõi dùng chung của mọi file xuất: chọn/sắp cột và ghi .xlsx theo kiểu stream.
 * Chạy: npm test -- test/xlsx-export.spec.ts
 */
import { Writable } from 'node:stream';
import * as ExcelJS from 'exceljs';
import type { Response } from 'express';
import {
  EXPORT_ROW_LIMIT,
  describeFields,
  exportFilename,
  resolveFields,
  singleBatch,
  streamXlsx,
  vnDateTime,
  type ExportField,
} from '../src/common/utils/xlsx-export';

type Row = { a: string; b: number };

const catalog: ExportField<Row>[] = [
  {
    key: 'a',
    header: 'Cột A',
    group: 'Nhóm 1',
    locked: true,
    default: true,
    value: (r) => r.a,
  },
  {
    key: 'b',
    header: 'Cột B',
    group: 'Nhóm 1',
    default: true,
    width: 30,
    value: (r) => r.b,
  },
  { key: 'c', header: 'Cột C', group: 'Nhóm 2', value: () => 'c' },
];

/** Response giả: hứng byte để đọc lại bằng ExcelJS, kèm header đã set */
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
  return { sheet, header, rowCount: sheet.rowCount };
}

describe('resolveFields', () => {
  it('bỏ trống → dùng các trường default', () => {
    expect(resolveFields(catalog, undefined).map((f) => f.key)).toEqual([
      'a',
      'b',
    ]);
  });

  it('giữ đúng thứ tự người dùng gửi lên', () => {
    expect(resolveFields(catalog, 'c,b').map((f) => f.key)).toEqual([
      'a',
      'c',
      'b',
    ]);
  });

  it('bỏ qua key lạ và không nhân đôi trường trùng', () => {
    expect(resolveFields(catalog, 'c,xyz,c').map((f) => f.key)).toEqual([
      'a',
      'c',
    ]);
  });

  it('mọi key đều lạ → xuất trọn catalog thay vì file rỗng cột', () => {
    expect(resolveFields(catalog, 'xyz').map((f) => f.key)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('bỏ tick trường locked vẫn được chèn lại, đứng đầu', () => {
    // FE có thể gửi lên danh sách cũ đã lưu từ trước khi trường thành locked
    expect(resolveFields(catalog, 'c').map((f) => f.key)).toEqual(['a', 'c']);
  });

  it('trường locked người dùng tự sắp thì tôn trọng vị trí đó', () => {
    expect(resolveFields(catalog, 'c,a').map((f) => f.key)).toEqual(['c', 'a']);
  });

  it('khoảng trắng thừa trong chuỗi fields không làm mất cột', () => {
    expect(resolveFields(catalog, ' c , b ').map((f) => f.key)).toEqual([
      'a',
      'c',
      'b',
    ]);
  });
});

describe('describeFields', () => {
  it('trả nhãn/nhóm và chuẩn hoá default/locked về boolean', () => {
    expect(describeFields(catalog)).toEqual([
      {
        key: 'a',
        label: 'Cột A',
        group: 'Nhóm 1',
        default: true,
        locked: true,
      },
      {
        key: 'b',
        label: 'Cột B',
        group: 'Nhóm 1',
        default: true,
        locked: false,
      },
      {
        key: 'c',
        label: 'Cột C',
        group: 'Nhóm 2',
        default: false,
        locked: false,
      },
    ]);
  });
});

describe('streamXlsx', () => {
  it('ghi hàng tiêu đề rồi tới dữ liệu, đúng thứ tự cột đã chọn', async () => {
    const out = fakeResponse();
    const result = await streamXlsx(out.res, {
      filename: 'thu.xlsx',
      sheetName: 'Thu',
      fields: resolveFields(catalog, 'b,a'),
      batches: singleBatch([
        { a: 'x', b: 1 },
        { a: 'y', b: 2 },
      ]),
    });

    const { sheet, header, rowCount } = await readSheet(out.buffer());
    expect(sheet.name).toBe('Thu');
    expect(header).toEqual(['Cột B', 'Cột A']);
    expect(sheet.getRow(2).values).toEqual([undefined, 1, 'x']);
    expect(sheet.getRow(3).values).toEqual([undefined, 2, 'y']);
    expect(rowCount).toBe(3);
    expect(result).toEqual({ written: 2, truncated: false });
  });

  it('đặt header tải file cho trình duyệt', async () => {
    const out = fakeResponse();
    await streamXlsx(out.res, {
      filename: 'don-hang.xlsx',
      sheetName: 'S',
      fields: resolveFields(catalog),
      batches: singleBatch([{ a: 'x', b: 1 }]),
    });

    expect(out.headers['Content-Disposition']).toBe(
      'attachment; filename="don-hang.xlsx"',
    );
    expect(out.headers['Content-Type']).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
  });

  it('gộp nhiều lô thành một sheet liên tục', async () => {
    async function* batches() {
      yield [{ a: 'lô1-1', b: 1 }];
      yield [
        { a: 'lô2-1', b: 2 },
        { a: 'lô2-2', b: 3 },
      ];
    }

    const out = fakeResponse();
    const result = await streamXlsx(out.res, {
      filename: 'f.xlsx',
      sheetName: 'S',
      fields: resolveFields(catalog),
      batches: batches(),
    });

    const { sheet, rowCount } = await readSheet(out.buffer());
    expect(rowCount).toBe(4);
    expect(sheet.getRow(2).getCell(1).value).toBe('lô1-1');
    expect(sheet.getRow(4).getCell(1).value).toBe('lô2-2');
    expect(result.written).toBe(3);
  });

  it('lô rỗng vẫn ra file hợp lệ chỉ có hàng tiêu đề', async () => {
    const out = fakeResponse();
    const result = await streamXlsx(out.res, {
      filename: 'f.xlsx',
      sheetName: 'S',
      fields: resolveFields(catalog),
      batches: singleBatch([]),
    });

    const { header, rowCount } = await readSheet(out.buffer());
    expect(header).toEqual(['Cột A', 'Cột B']);
    expect(rowCount).toBe(1);
    expect(result).toEqual({ written: 0, truncated: false });
  });

  it('chạm trần thì cắt đúng EXPORT_ROW_LIMIT dòng và báo truncated', async () => {
    // Nguồn vô hạn: nếu quên chặn trần thì test này treo thay vì lặng lẽ sai
    async function* endless() {
      for (;;) {
        yield Array.from({ length: 1000 }, (_, i) => ({ a: 'x', b: i }));
      }
    }

    const out = fakeResponse();
    const result = await streamXlsx(out.res, {
      filename: 'f.xlsx',
      sheetName: 'S',
      fields: resolveFields(catalog),
      batches: endless(),
    });

    expect(result).toEqual({ written: EXPORT_ROW_LIMIT, truncated: true });
    const { rowCount } = await readSheet(out.buffer());
    expect(rowCount).toBe(EXPORT_ROW_LIMIT + 1);
  }, 60_000);

  it('ngừng đọc nguồn ngay khi chạm trần, không nạp thừa lô', async () => {
    let produced = 0;
    async function* counted() {
      for (;;) {
        produced += 1;
        yield Array.from({ length: EXPORT_ROW_LIMIT }, () => ({
          a: 'x',
          b: 1,
        }));
      }
    }

    const out = fakeResponse();
    await streamXlsx(out.res, {
      filename: 'f.xlsx',
      sheetName: 'S',
      fields: resolveFields(catalog),
      batches: counted(),
    });

    expect(produced).toBe(1);
  }, 60_000);
});

describe('vnDateTime', () => {
  it('định dạng ngày giờ kiểu Việt, có đệm số 0', () => {
    expect(vnDateTime(new Date(2026, 7, 5, 9, 3))).toBe('05/08/2026 09:03');
  });

  it('null/undefined thành ô rỗng chứ không phải chữ "null"', () => {
    expect(vnDateTime(null)).toBe('');
    expect(vnDateTime(undefined)).toBe('');
  });
});

describe('exportFilename', () => {
  it('gắn ngày xuất vào sau tiền tố', () => {
    jest.useFakeTimers().setSystemTime(new Date(2026, 7, 17, 10, 0));
    expect(exportFilename('don-hang')).toBe('don-hang-17-08-2026.xlsx');
    jest.useRealTimers();
  });
});
