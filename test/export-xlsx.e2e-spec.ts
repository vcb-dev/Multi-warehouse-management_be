/**
 * Xuất file danh sách (đơn hàng / sản phẩm / tồn kho).
 * Chạy: RUN_INTEGRATION_TESTS=1 npm test -- test/export-xlsx.e2e-spec.ts
 *
 * Toàn bộ test ở đây CHỈ ĐỌC — không tạo/sửa/xóa bản ghi nào, nên chạy thẳng
 * vào DB thật là an toàn.
 *
 * Chỉ giữ những gì phải có DB thật mới kiểm được (truy vấn Prisma, dữ liệu
 * Sapo thật). Logic dựng dòng/cột nằm ở các spec chạy không cần DB:
 * `xlsx-export.spec.ts`, `order-export.spec.ts`, `product-export.spec.ts`,
 * `inventory-export.spec.ts`.
 */
import { Writable } from 'node:stream';
import { Test, TestingModule } from '@nestjs/testing';
import * as ExcelJS from 'exceljs';
import type { Response } from 'express';
import { InventoryModule } from '../src/modules/inventory/inventory.module';
import { InventoryExportService } from '../src/modules/inventory/inventory-import-export.service';
import { OrdersModule } from '../src/modules/orders/orders.module';
import { OrderExportService } from '../src/modules/orders/order-export.service';
import { ProductsModule } from '../src/modules/products/products.module';
import { ProductExportService } from '../src/modules/products/product-export.service';
import { VouchersModule } from '../src/modules/vouchers/vouchers.module';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { adminAuth } from './helpers/auth';

const describeIfDb =
  process.env.DATABASE_URL && process.env.RUN_INTEGRATION_TESTS === '1'
    ? describe
    : describe.skip;

/** Response giả: hứng byte vào buffer để đọc lại bằng ExcelJS */
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

describeIfDb('Xuất file danh sách (integration)', () => {
  let moduleRef: TestingModule;
  let orders: OrderExportService;
  let products: ProductExportService;
  let inventory: InventoryExportService;
  let prisma: PrismaService;
  const user = adminAuth();

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        PrismaModule,
        VouchersModule,
        OrdersModule,
        ProductsModule,
        InventoryModule,
      ],
    }).compile();
    await moduleRef.init();
    orders = moduleRef.get(OrderExportService);
    products = moduleRef.get(ProductExportService);
    inventory = moduleRef.get(InventoryExportService);
    prisma = moduleRef.get(PrismaService);
  }, 60_000);

  afterAll(async () => {
    await moduleRef?.close();
  });

  it('đơn hàng — file tổng quan theo đơn: mỗi đơn đúng 1 dòng', async () => {
    const sample = await prisma.order.findMany({
      orderBy: [{ createdOn: 'desc' }, { id: 'desc' }],
      take: 5,
      select: { id: true, name: true },
    });
    expect(sample.length).toBeGreaterThan(0);

    const out = fakeResponse();
    await orders.export(
      { mode: 'order', ids: sample.map((o) => o.id.toString()).join(',') },
      user,
      out.res,
    );

    const { header, rowCount } = await readSheet(out.buffer());
    expect(out.headers['Content-Disposition']).toContain('don-hang');
    expect(header[0]).toBe('STT');
    expect(header[1]).toBe('Mã đơn hàng');
    // 1 hàng tiêu đề + đúng số đơn đã chọn
    expect(rowCount).toBe(sample.length + 1);
  }, 60_000);

  it('đơn hàng — file chi tiết: mỗi dòng hàng là một dòng file', async () => {
    const sample = await prisma.order.findMany({
      where: { items: { some: {} } },
      orderBy: [{ createdOn: 'desc' }, { id: 'desc' }],
      take: 5,
      select: { id: true, _count: { select: { items: true } } },
    });
    const expectedRows = sample.reduce((n, o) => n + o._count.items, 0);

    const out = fakeResponse();
    await orders.export(
      { mode: 'detail', ids: sample.map((o) => o.id.toString()).join(',') },
      user,
      out.res,
    );

    const { header, rowCount } = await readSheet(out.buffer());
    expect(header).toContain('Mã SKU');
    expect(header).toContain('Số lượng sản phẩm');
    expect(rowCount).toBe(expectedRows + 1);
  }, 60_000);

  it('đơn hàng — file theo sản phẩm: gộp theo SKU, tổng SL khớp dòng hàng', async () => {
    const sample = await prisma.order.findMany({
      where: { items: { some: {} } },
      orderBy: [{ createdOn: 'desc' }, { id: 'desc' }],
      take: 5,
      select: { id: true, items: { select: { sku: true, quantity: true } } },
    });
    const totalQty = sample.reduce(
      (n, o) => n + o.items.reduce((m, i) => m + i.quantity, 0),
      0,
    );
    const distinctSkus = new Set(
      sample.flatMap((o) => o.items.map((i) => i.sku)),
    );

    const out = fakeResponse();
    await orders.export(
      { mode: 'product', ids: sample.map((o) => o.id.toString()).join(',') },
      user,
      out.res,
    );

    const { sheet, header, rowCount } = await readSheet(out.buffer());
    expect(header[1]).toBe('Mã SKU');
    expect(rowCount).toBe(distinctSkus.size + 1);

    const qtyCol = header.indexOf('Số lượng bán') + 1;
    let sum = 0;
    for (let i = 2; i <= rowCount; i++) {
      sum += Number(sheet.getRow(i).getCell(qtyCol).value ?? 0);
    }
    expect(sum).toBe(totalQty);
  }, 60_000);

  it('đơn hàng — `fields` quyết định đúng tập cột và thứ tự cột', async () => {
    const sample = await prisma.order.findMany({
      orderBy: { id: 'desc' },
      take: 2,
      select: { id: true },
    });

    const out = fakeResponse();
    await orders.export(
      {
        mode: 'order',
        fields: 'total,customer_name,source',
        ids: sample.map((o) => o.id.toString()).join(','),
      },
      user,
      out.res,
    );

    const { header } = await readSheet(out.buffer());
    // STT + Mã đơn hàng là `locked` nên luôn được chèn lại, đứng trước
    expect(header).toEqual([
      'STT',
      'Mã đơn hàng',
      'Tổng tiền',
      'Tên khách hàng',
      'Nguồn',
    ]);
  }, 60_000);

  it('sản phẩm — bộ cột mặc định giữ nguyên 12 cột nhập lại được', async () => {
    const out = fakeResponse();
    await products.export(
      { page_size: 3, ids: await someProductIds(prisma) },
      out.res,
    );

    const { header } = await readSheet(out.buffer());
    expect(header).toEqual([
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
  }, 60_000);

  it('tồn kho — xuất được và có cột "Đang đóng gói" đúng dữ liệu', async () => {
    const level = await prisma.inventoryLevel.findFirst({
      orderBy: { packed: 'desc' },
      select: { variantId: true, locationId: true, packed: true },
    });
    expect(level).toBeTruthy();

    const out = fakeResponse();
    await inventory.export(
      {
        location_id: level!.locationId.toString(),
        variant_ids: level!.variantId.toString(),
      },
      user,
      out.res,
    );

    const { sheet, header, rowCount } = await readSheet(out.buffer());
    expect(header).toContain('Đang đóng gói');
    expect(rowCount).toBeGreaterThan(1);
    const col = header.indexOf('Đang đóng gói') + 1;
    expect(Number(sheet.getRow(2).getCell(col).value ?? 0)).toBe(level!.packed);
  }, 60_000);
});

async function someProductIds(prisma: PrismaService) {
  const rows = await prisma.product.findMany({
    orderBy: [{ modifiedOn: 'desc' }, { id: 'desc' }],
    take: 3,
    select: { id: true },
  });
  return rows.map((p) => p.id.toString()).join(',');
}
