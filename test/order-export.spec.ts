/**
 * Xuất file danh sách đơn hàng — 3 loại file, chọn cột, phạm vi xuất.
 * Chạy: npm test -- test/order-export.spec.ts
 *
 * Toàn bộ mock, KHÔNG chạm DB: chỉ kiểm phần logic dựng dòng/cột và bộ lọc mà
 * service tự quyết. Phần chạy thật vào DB nằm ở test/export-xlsx.e2e-spec.ts.
 */
import { Writable } from 'node:stream';
import { Prisma } from '@prisma/client';
import * as ExcelJS from 'exceljs';
import type { Response } from 'express';
import { OrderExportService } from '../src/modules/orders/order-export.service';
import type { OrderService } from '../src/modules/orders/order.service';
import type { OrderRepository } from '../src/modules/orders/order.repository';
import { adminAuth } from './helpers/auth';

const user = adminAuth();
const BASE_WHERE = { locationId: { in: [1n] } };

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

/** Lấy ô theo tên cột, để test không vỡ khi thêm cột mới vào catalog */
function cell(header: string[], row: unknown[], column: string) {
  const idx = header.indexOf(column);
  if (idx < 0) throw new Error(`Không có cột "${column}" trong file`);
  return row[idx];
}

const dec = (n: number) => new Prisma.Decimal(n);

type ItemOverride = Partial<{
  name: string;
  sku: string;
  variantTitle: string | null;
  quantity: number;
  price: number;
  totalDiscount: number;
  discountedTotal: number;
  unit: string | null;
}>;

function makeItem(over: ItemOverride = {}) {
  return {
    name: over.name ?? 'Áo thun',
    variantTitle: over.variantTitle ?? null,
    sku: over.sku ?? 'SKU-1',
    quantity: over.quantity ?? 1,
    price: dec(over.price ?? 100_000),
    totalDiscount: dec(over.totalDiscount ?? 0),
    discountedTotal: dec(over.discountedTotal ?? 100_000),
    variant: { unit: over.unit ?? 'Cái' },
  };
}

type OrderOverride = Partial<{
  id: bigint;
  name: string;
  status: string;
  sourceName: string | null;
  financialStatus: string;
  fulfillmentStatus: string | null;
  totalPrice: number;
  note: string | null;
  tags: string[];
  items: ReturnType<typeof makeItem>[];
  fulfillments: unknown[];
  customer: unknown;
  assignedTo: unknown;
  createdOn: Date;
  shipping: Record<string, string | null>;
}>;

/** Đơn tối thiểu đủ để mọi hàm `value` trong catalog chạy được */
function makeOrder(over: OrderOverride = {}) {
  return {
    id: over.id ?? 1n,
    name: over.name ?? 'DH001',
    status: over.status ?? 'open',
    sourceName: over.sourceName === undefined ? 'facebook' : over.sourceName,
    financialStatus: over.financialStatus ?? 'pending',
    fulfillmentStatus:
      over.fulfillmentStatus === undefined ? null : over.fulfillmentStatus,
    returnStatus: 'no_return',
    createdOn: over.createdOn ?? new Date(2026, 7, 17, 14, 5),
    confirmedOn: null,
    completedOn: null,
    cancelledOn: null,
    note: over.note ?? null,
    tags: over.tags ?? [],
    email: null,
    phone: '0900000000',
    gateway: null,
    subtotalLineItemsQuantity: 1,
    subTotalPrice: dec(100_000),
    totalDiscounts: dec(0),
    totalTax: dec(0),
    totalShippingPrice: dec(0),
    totalPrice: dec(over.totalPrice ?? 100_000),
    totalReceived: dec(0),
    unpaidAmount: dec(0),
    shippingMethod: null,
    deliveryNote: null,
    shippingName: null,
    shippingFirstName: null,
    shippingLastName: null,
    shippingPhone: null,
    shippingAddress1: null,
    shippingWard: null,
    shippingDistrict: null,
    shippingProvince: null,
    ...(over.shipping ?? {}),
    location: { name: 'Kho HN' },
    createdBy: { firstName: 'Nguyễn', lastName: 'An', email: 'an@local.dev' },
    assignedTo: over.assignedTo ?? null,
    customer:
      over.customer === undefined
        ? { firstName: 'Trần', lastName: 'Bình', phone: '0911', email: null }
        : over.customer,
    items: over.items ?? [makeItem()],
    fulfillments: over.fulfillments ?? [],
  };
}

/** Service với repo giả trả về đúng các đơn cho trước, gom lại lời gọi findMany */
function makeService(orders: ReturnType<typeof makeOrder>[]) {
  const findMany = jest.fn().mockResolvedValue(orders);
  const buildListWhere = jest.fn().mockResolvedValue({ ...BASE_WHERE });
  const filterByStockStatus = jest.fn().mockResolvedValue([7n, 8n]);

  const service = new OrderExportService(
    { buildListWhere, filterByStockStatus } as unknown as OrderService,
    { client: { order: { findMany } } } as unknown as OrderRepository,
  );
  return { service, findMany, buildListWhere, filterByStockStatus };
}

describe('OrderExportService.fields', () => {
  const { service } = makeService([]);

  it('loại "chi tiết" có thêm nhóm cột sản phẩm so với loại "theo đơn"', () => {
    const order = service.fields('order').data.map((f) => f.key);
    const detail = service.fields('detail').data.map((f) => f.key);

    expect(order).not.toContain('item_sku');
    expect(detail).toContain('item_sku');
    // Chi tiết = trọn bộ cột cấp đơn + cột dòng hàng, không bỏ cột nào
    expect(detail.slice(0, order.length)).toEqual(order);
  });

  it('loại "theo sản phẩm" là catalog riêng, không dính cột cấp đơn', () => {
    const keys = service.fields('product').data.map((f) => f.key);
    expect(keys).toContain('sku');
    expect(keys).toContain('quantity');
    expect(keys).not.toContain('customer_name');
  });

  it('mọi catalog đều có ít nhất một cột locked làm định danh', () => {
    for (const mode of ['order', 'detail', 'product'] as const) {
      expect(service.fields(mode).data.some((f) => f.locked)).toBe(true);
    }
  });
});

describe('OrderExportService.export — loại file', () => {
  it('mặc định là "theo đơn": mỗi đơn đúng một dòng dù có nhiều dòng hàng', async () => {
    const { service } = makeService([
      makeOrder({
        id: 1n,
        name: 'DH001',
        items: [makeItem({ sku: 'A' }), makeItem({ sku: 'B' })],
      }),
      makeOrder({ id: 2n, name: 'DH002' }),
    ]);

    const out = fakeResponse();
    await service.export({}, user, out.res);

    const { header, rows } = await readSheet(out.buffer());
    expect(rows).toHaveLength(2);
    expect(cell(header, rows[0], 'Mã đơn hàng')).toBe('DH001');
    expect(cell(header, rows[1], 'Mã đơn hàng')).toBe('DH002');
    expect(cell(header, rows[0], 'STT')).toBe(1);
    expect(cell(header, rows[1], 'STT')).toBe(2);
  });

  it('loại "chi tiết": bung mỗi dòng hàng thành một dòng, STT chạy liên tục', async () => {
    const { service } = makeService([
      makeOrder({
        id: 1n,
        name: 'DH001',
        items: [
          makeItem({ sku: 'A', quantity: 2 }),
          makeItem({ sku: 'B', quantity: 3 }),
        ],
      }),
      makeOrder({ id: 2n, name: 'DH002', items: [makeItem({ sku: 'C' })] }),
    ]);

    const out = fakeResponse();
    await service.export({ mode: 'detail' }, user, out.res);

    const { header, rows } = await readSheet(out.buffer());
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => cell(header, r, 'Mã SKU'))).toEqual(['A', 'B', 'C']);
    expect(rows.map((r) => cell(header, r, 'STT'))).toEqual([1, 2, 3]);
    // Cột cấp đơn lặp lại trên từng dòng hàng của cùng một đơn
    expect(rows.slice(0, 2).map((r) => cell(header, r, 'Mã đơn hàng'))).toEqual(
      ['DH001', 'DH001'],
    );
  });

  it('loại "chi tiết": đơn không có dòng hàng vẫn ra đúng một dòng', async () => {
    // Đơn đồng bộ từ sàn có thể chưa kịp về order_items — không được rơi mất đơn
    const { service } = makeService([
      makeOrder({ id: 1n, name: 'DH-TRONG', items: [] }),
    ]);

    const out = fakeResponse();
    await service.export({ mode: 'detail' }, user, out.res);

    const { header, rows } = await readSheet(out.buffer());
    expect(rows).toHaveLength(1);
    expect(cell(header, rows[0], 'Mã đơn hàng')).toBe('DH-TRONG');
    expect(cell(header, rows[0], 'Mã SKU')).toBeUndefined();
    expect(cell(header, rows[0], 'Số lượng sản phẩm')).toBe(0);
  });

  it('loại "theo sản phẩm": gộp theo SKU, cộng dồn SL/doanh thu, đếm số đơn', async () => {
    const { service } = makeService([
      makeOrder({
        id: 1n,
        items: [
          makeItem({ sku: 'A', quantity: 2, discountedTotal: 200_000 }),
          makeItem({ sku: 'B', quantity: 1, discountedTotal: 50_000 }),
        ],
      }),
      makeOrder({
        id: 2n,
        items: [makeItem({ sku: 'A', quantity: 3, discountedTotal: 300_000 })],
      }),
    ]);

    const out = fakeResponse();
    await service.export({ mode: 'product' }, user, out.res);

    const { header, rows } = await readSheet(out.buffer());
    expect(rows).toHaveLength(2);

    const a = rows.find((r) => cell(header, r, 'Mã SKU') === 'A')!;
    expect(cell(header, a, 'Số lượng bán')).toBe(5);
    expect(cell(header, a, 'Doanh thu')).toBe(500_000);
    expect(cell(header, a, 'Số đơn hàng')).toBe(2);

    const b = rows.find((r) => cell(header, r, 'Mã SKU') === 'B')!;
    expect(cell(header, b, 'Số đơn hàng')).toBe(1);
  });

  it('loại "theo sản phẩm": sắp giảm dần theo số lượng bán', async () => {
    const { service } = makeService([
      makeOrder({
        id: 1n,
        items: [
          makeItem({ sku: 'IT', quantity: 1 }),
          makeItem({ sku: 'NHIEU', quantity: 9 }),
          makeItem({ sku: 'VUA', quantity: 5 }),
        ],
      }),
    ]);

    const out = fakeResponse();
    await service.export({ mode: 'product' }, user, out.res);

    const { header, rows } = await readSheet(out.buffer());
    expect(rows.map((r) => cell(header, r, 'Mã SKU'))).toEqual([
      'NHIEU',
      'VUA',
      'IT',
    ]);
    expect(rows.map((r) => cell(header, r, 'STT'))).toEqual([1, 2, 3]);
  });

  it('tên file khác nhau theo loại để không đè lên nhau trong thư mục tải về', async () => {
    const cases: [Parameters<OrderExportService['export']>[0], string][] = [
      [{ mode: 'order' }, 'don-hang-'],
      [{ mode: 'detail' }, 'don-hang-chi-tiet-'],
      [{ mode: 'product' }, 'don-hang-theo-san-pham-'],
    ];

    for (const [query, prefix] of cases) {
      const { service } = makeService([makeOrder()]);
      const out = fakeResponse();
      await service.export(query, user, out.res);
      expect(out.headers['Content-Disposition']).toContain(prefix);
    }
  });
});

describe('OrderExportService.export — nội dung cột', () => {
  it('dịch mã trạng thái sang nhãn tiếng Việt', async () => {
    const { service } = makeService([
      makeOrder({ id: 1n, status: 'open' }),
      makeOrder({ id: 2n, status: 'closed' }),
      makeOrder({ id: 3n, status: 'cancelled' }),
    ]);

    const out = fakeResponse();
    await service.export({ fields: 'status' }, user, out.res);

    const { header, rows } = await readSheet(out.buffer());
    expect(rows.map((r) => cell(header, r, 'Trạng thái đơn hàng'))).toEqual([
      'Đang xử lý',
      'Đã hoàn thành',
      'Đã hủy',
    ]);
  });

  it('trạng thái lạ (Sapo thêm mới) thì ghi nguyên mã thay vì để trống', async () => {
    const { service } = makeService([
      makeOrder({ status: 'trang_thai_moi_cua_sapo' }),
    ]);

    const out = fakeResponse();
    await service.export({ fields: 'status' }, user, out.res);

    const { header, rows } = await readSheet(out.buffer());
    expect(cell(header, rows[0], 'Trạng thái đơn hàng')).toBe(
      'trang_thai_moi_cua_sapo',
    );
  });

  it('chưa giao hàng (fulfillment_status NULL) hiện nhãn rõ ràng, không bỏ trống', async () => {
    const { service } = makeService([makeOrder({ fulfillmentStatus: null })]);

    const out = fakeResponse();
    await service.export({ fields: 'fulfillment_status' }, user, out.res);

    const { header, rows } = await readSheet(out.buffer());
    expect(cell(header, rows[0], 'Trạng thái giao hàng')).toBe(
      'Chưa giao hàng',
    );
  });

  it('hãng vận chuyển lấy được cả với đơn sàn (provider NULL, tên ở carrier_name)', async () => {
    const { service } = makeService([
      makeOrder({
        fulfillments: [
          {
            trackingNumber: 'VD123',
            provider: null,
            carrierName: 'J&T Express',
            trackingCompany: 'Standard shipping',
            carrier: null,
            codAmount: dec(250_000),
          },
        ],
      }),
    ]);

    const out = fakeResponse();
    await service.export(
      { fields: 'carrier,tracking_number,cod_amount' },
      user,
      out.res,
    );

    const { header, rows } = await readSheet(out.buffer());
    expect(cell(header, rows[0], 'Hãng vận chuyển')).toBe('J&T Express');
    expect(cell(header, rows[0], 'Mã vận đơn')).toBe('VD123');
    expect(cell(header, rows[0], 'Tiền thu hộ (COD)')).toBe(250_000);
  });

  it('đơn chưa có vận đơn thì các cột giao hàng rỗng chứ không lỗi', async () => {
    const { service } = makeService([makeOrder({ fulfillments: [] })]);

    const out = fakeResponse();
    await service.export(
      { fields: 'carrier,tracking_number,cod_amount' },
      user,
      out.res,
    );

    const { header, rows } = await readSheet(out.buffer());
    expect(cell(header, rows[0], 'Hãng vận chuyển')).toBeUndefined();
    expect(cell(header, rows[0], 'Tiền thu hộ (COD)')).toBe(0);
  });

  it('địa chỉ giao ghép từ các mảnh có thật, bỏ mảnh trống', async () => {
    const { service } = makeService([
      makeOrder({
        shipping: {
          shippingAddress1: '12 Lê Lợi',
          shippingWard: null,
          shippingDistrict: 'Quận 1',
          shippingProvince: 'TP.HCM',
        },
      }),
    ]);

    const out = fakeResponse();
    await service.export({ fields: 'shipping_address' }, user, out.res);

    const { header, rows } = await readSheet(out.buffer());
    expect(cell(header, rows[0], 'Địa chỉ giao hàng')).toBe(
      '12 Lê Lợi, Quận 1, TP.HCM',
    );
  });

  it('đơn khách vãng lai (customer NULL) không làm hỏng cột tên khách', async () => {
    const { service } = makeService([makeOrder({ customer: null })]);

    const out = fakeResponse();
    await service.export({ fields: 'customer_name' }, user, out.res);

    const { header, rows } = await readSheet(out.buffer());
    expect(cell(header, rows[0], 'Tên khách hàng')).toBeUndefined();
  });

  it('tiền ra số để Excel tính được, không phải chuỗi', async () => {
    const { service } = makeService([makeOrder({ totalPrice: 1_234_500 })]);

    const out = fakeResponse();
    await service.export({ fields: 'total' }, user, out.res);

    const { header, rows } = await readSheet(out.buffer());
    const value = cell(header, rows[0], 'Tổng tiền');
    expect(typeof value).toBe('number');
    expect(value).toBe(1_234_500);
  });

  it('`fields` quyết định đúng tập cột và thứ tự, cột locked luôn còn', async () => {
    const { service } = makeService([makeOrder()]);

    const out = fakeResponse();
    await service.export(
      { fields: 'total,customer_name,source' },
      user,
      out.res,
    );

    const { header } = await readSheet(out.buffer());
    expect(header).toEqual([
      'STT',
      'Mã đơn hàng',
      'Tổng tiền',
      'Tên khách hàng',
      'Nguồn',
    ]);
  });
});

describe('OrderExportService.export — phạm vi xuất', () => {
  it('`ids` chỉ thu hẹp thêm, KHÔNG thay bộ lọc quyền theo kho', async () => {
    const { service, findMany, buildListWhere } = makeService([makeOrder()]);

    const out = fakeResponse();
    await service.export({ ids: '10,20' }, user, out.res);

    expect(buildListWhere).toHaveBeenCalledWith({ ids: '10,20' }, user);
    expect(findMany.mock.calls[0][0].where).toEqual({
      AND: [BASE_WHERE, { id: { in: [10n, 20n] } }],
    });
  });

  it('`ids` rỗng/toàn dấu phẩy thì bỏ qua, không tạo bộ lọc id rỗng', async () => {
    // Bộ lọc `id IN []` sẽ ra file trắng — phải coi như không chọn gì
    const { service, findMany } = makeService([makeOrder()]);

    const out = fakeResponse();
    await service.export({ ids: ' , , ' }, user, out.res);

    expect(findMany.mock.calls[0][0].where).toEqual(BASE_WHERE);
  });

  it('lọc đủ/thiếu hàng đi qua đúng nhánh tính tồn rồi ghim theo id', async () => {
    const { service, findMany, filterByStockStatus } = makeService([
      makeOrder(),
    ]);

    const out = fakeResponse();
    await service.export({ stock_status: 'thieu_hang' }, user, out.res);

    expect(filterByStockStatus).toHaveBeenCalledWith(BASE_WHERE, 'thieu_hang');
    expect(findMany.mock.calls[0][0].where).toEqual({
      AND: [BASE_WHERE, { id: { in: [7n, 8n] } }],
    });
  });

  it('stock_status lạ thì bỏ qua nhánh tính tồn', async () => {
    const { service, filterByStockStatus } = makeService([makeOrder()]);

    const out = fakeResponse();
    await service.export({ stock_status: 'linh_tinh' }, user, out.res);

    expect(filterByStockStatus).not.toHaveBeenCalled();
  });

  it('sắp xếp cùng thứ tự với bảng danh sách (mới nhất trước)', async () => {
    const { service, findMany } = makeService([makeOrder()]);

    const out = fakeResponse();
    await service.export({}, user, out.res);

    expect(findMany.mock.calls[0][0].orderBy).toEqual([
      { createdOn: 'desc' },
      { id: 'desc' },
    ]);
  });

  it('lô ngắn hơn kích thước lô thì dừng luôn, không hỏi DB thêm lần nữa', async () => {
    const { service, findMany } = makeService([makeOrder(), makeOrder()]);

    const out = fakeResponse();
    await service.export({}, user, out.res);

    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('không còn đơn nào thì vẫn ra file hợp lệ chỉ có hàng tiêu đề', async () => {
    const { service } = makeService([]);

    const out = fakeResponse();
    await service.export({}, user, out.res);

    const { rowCount } = await readSheet(out.buffer());
    expect(rowCount).toBe(1);
  });
});
