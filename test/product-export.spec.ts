/**
 * Xuất file danh sách sản phẩm — bộ cột mặc định phải nhập ngược lại được.
 * Chạy: npm test -- test/product-export.spec.ts
 *
 * Toàn bộ mock, KHÔNG chạm DB.
 */
import { Writable } from 'node:stream';
import { Prisma } from '@prisma/client';
import * as ExcelJS from 'exceljs';
import type { Response } from 'express';
import { ProductExportService } from '../src/modules/products/product-export.service';
import type { ProductService } from '../src/modules/products/product.service';
import type { ProductRepository } from '../src/modules/products/product.repository';

const BASE_WHERE = { status: 'active' };

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

const dec = (n: number) => new Prisma.Decimal(n);

type VariantOverride = Partial<{
  sku: string;
  unit: string | null;
  price: number;
  cost: number;
  compareAtPrice: number | null;
  barcode: string | null;
  title: string | null;
}>;

function makeVariant(over: VariantOverride = {}) {
  return {
    id: 100n,
    sku: over.sku ?? 'SKU-1',
    title: over.title ?? null,
    unit: over.unit === undefined ? 'Cái' : over.unit,
    price: dec(over.price ?? 150_000),
    cost: dec(over.cost ?? 100_000),
    compareAtPrice:
      over.compareAtPrice == null ? null : dec(over.compareAtPrice),
    barcode: over.barcode === undefined ? null : over.barcode,
  };
}

function makeProduct(
  over: Partial<{
    id: bigint;
    name: string;
    alias: string;
    vendor: string | null;
    productType: string | null;
    tags: string[];
    status: string;
    content: string | null;
    variants: ReturnType<typeof makeVariant>[];
  }> = {},
) {
  return {
    id: over.id ?? 1n,
    alias: over.alias ?? 'ao-thun',
    name: over.name ?? 'Áo thun',
    vendor: over.vendor === undefined ? 'Local' : over.vendor,
    productType: over.productType === undefined ? 'Áo' : over.productType,
    tags: over.tags ?? [],
    status: over.status ?? 'active',
    content: over.content === undefined ? null : over.content,
    createdOn: new Date(2026, 0, 1, 8, 0),
    modifiedOn: new Date(2026, 7, 17, 9, 30),
    variants: over.variants ?? [makeVariant()],
  };
}

function makeService(products: ReturnType<typeof makeProduct>[]) {
  const findMany = jest.fn().mockResolvedValue(products);
  const buildListWhere = jest.fn().mockResolvedValue({ ...BASE_WHERE });

  const service = new ProductExportService(
    { buildListWhere } as unknown as ProductService,
    { client: { product: { findMany } } } as unknown as ProductRepository,
  );
  return { service, findMany, buildListWhere };
}

describe('ProductExportService.fields', () => {
  it('bộ mặc định đúng 12 cột theo thứ tự file nhập của Sapo', () => {
    // File xuất mặc định phải nhập lại được qua SAPO_PRODUCT_HEADERS — đổi thứ tự
    // hay bỏ cột ở đây là làm hỏng vòng xuất-sửa-nhập của người dùng.
    const { service } = makeService([]);
    const defaults = service
      .fields()
      .data.filter((f) => f.default)
      .map((f) => f.label);

    expect(defaults).toEqual([
      'Đường dẫn/Alias',
      'Tên sản phẩm*',
      'Nhãn hiệu',
      'Loại sản phẩm',
      'Tags',
      'Đơn vị tính',
      'Hiển thị*',
      'Mã SKU',
      'Giá',
      'Giá so sánh',
      'Giá vốn',
      'Barcode',
    ]);
  });

  it('có thêm cột nâng cao ngoài bộ mặc định để người dùng tự chọn', () => {
    const { service } = makeService([]);
    const keys = service.fields().data.map((f) => f.key);
    expect(keys).toEqual(
      expect.arrayContaining(['id', 'variant_id', 'description']),
    );
  });
});

describe('ProductExportService.export', () => {
  it('mỗi phiên bản là một dòng, cột cấp sản phẩm lặp lại', async () => {
    const { service } = makeService([
      makeProduct({
        name: 'Áo thun',
        variants: [
          makeVariant({ sku: 'AT-S', price: 100_000 }),
          makeVariant({ sku: 'AT-M', price: 120_000 }),
        ],
      }),
    ]);

    const out = fakeResponse();
    await service.export({}, out.res);

    const { header, rows } = await readSheet(out.buffer());
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => cell(header, r, 'Mã SKU'))).toEqual([
      'AT-S',
      'AT-M',
    ]);
    expect(rows.map((r) => cell(header, r, 'Tên sản phẩm*'))).toEqual([
      'Áo thun',
      'Áo thun',
    ]);
    expect(rows.map((r) => cell(header, r, 'Giá'))).toEqual([100_000, 120_000]);
  });

  it('sản phẩm chưa có phiên bản vẫn ra một dòng, không bị bỏ sót', async () => {
    const { service } = makeService([
      makeProduct({ name: 'SP chưa có SKU', variants: [] }),
    ]);

    const out = fakeResponse();
    await service.export({}, out.res);

    const { header, rows } = await readSheet(out.buffer());
    expect(rows).toHaveLength(1);
    expect(cell(header, rows[0], 'Tên sản phẩm*')).toBe('SP chưa có SKU');
    expect(cell(header, rows[0], 'Mã SKU')).toBeUndefined();
    expect(cell(header, rows[0], 'Giá')).toBe(0);
  });

  it('cột Hiển thị ra chữ Có/Không đúng như file nhập mong đợi', async () => {
    const { service } = makeService([
      makeProduct({ id: 1n, status: 'active' }),
      makeProduct({ id: 2n, status: 'draft' }),
    ]);

    const out = fakeResponse();
    await service.export({}, out.res);

    const { header, rows } = await readSheet(out.buffer());
    expect(rows.map((r) => cell(header, r, 'Hiển thị*'))).toEqual([
      'Có',
      'Không',
    ]);
  });

  it('tags nối bằng dấu phẩy, sản phẩm không tag thì để trống', async () => {
    const { service } = makeService([
      makeProduct({ id: 1n, tags: ['hot', 'sale'] }),
      makeProduct({ id: 2n, tags: [] }),
    ]);

    const out = fakeResponse();
    await service.export({}, out.res);

    const { header, rows } = await readSheet(out.buffer());
    expect(cell(header, rows[0], 'Tags')).toBe('hot, sale');
    expect(cell(header, rows[1], 'Tags')).toBeUndefined();
  });

  it('cột Mô tả bóc thẻ HTML để không đổ markup vào ô Excel', async () => {
    const { service } = makeService([
      makeProduct({
        content: '<p>Chất liệu <b>cotton</b></p>\n<ul><li>Co giãn</li></ul>',
      }),
    ]);

    const out = fakeResponse();
    await service.export({ fields: 'description' }, out.res);

    const { header, rows } = await readSheet(out.buffer());
    expect(cell(header, rows[0], 'Mô tả')).toBe('Chất liệu cotton Co giãn');
  });

  it('`ids` chỉ thu hẹp thêm bộ lọc màn hình', async () => {
    const { service, findMany } = makeService([makeProduct()]);

    const out = fakeResponse();
    await service.export({ ids: '5,6' }, out.res);

    expect(findMany.mock.calls[0][0].where).toEqual({
      AND: [BASE_WHERE, { id: { in: [5n, 6n] } }],
    });
  });

  it('`ids` rỗng thì giữ nguyên bộ lọc, không ra file trắng', async () => {
    const { service, findMany } = makeService([makeProduct()]);

    const out = fakeResponse();
    await service.export({ ids: '  ' }, out.res);

    expect(findMany.mock.calls[0][0].where).toEqual(BASE_WHERE);
  });

  it('sắp cùng thứ tự với bảng danh sách (sửa gần nhất trước)', async () => {
    const { service, findMany } = makeService([makeProduct()]);

    const out = fakeResponse();
    await service.export({}, out.res);

    expect(findMany.mock.calls[0][0].orderBy).toEqual([
      { modifiedOn: 'desc' },
      { id: 'desc' },
    ]);
  });

  it('tên file có tiền tố san-pham', async () => {
    const { service } = makeService([makeProduct()]);

    const out = fakeResponse();
    await service.export({}, out.res);

    expect(out.headers['Content-Disposition']).toContain('san-pham-');
  });
});
