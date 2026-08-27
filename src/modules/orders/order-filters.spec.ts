import { OrderService } from './order.service';
import { ListOrdersQueryDto } from './order.dto';
import type { AuthUser } from '../../common/decorators/current-user.decorator';

/**
 * Kiểm tra hình dạng `where` do `buildListWhere` dựng ra — không chạm DB.
 * Chỉ nhánh `q` cần repository (tìm kiếm không dấu), nên mọi ca ở đây tránh `q`
 * và service được khởi tạo với dependency rỗng.
 */
function buildService(): OrderService {
  return new OrderService(
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
  );
}

/** Người dùng toàn quyền — để `locationScopeFilter` không thu hẹp kết quả. */
const admin: AuthUser = {
  userId: 1n,
  email: 'admin@example.com',
  roles: ['admin'],
  locationIds: [],
  isAdmin: true,
};

function build(query: Partial<ListOrdersQueryDto>) {
  return buildService().buildListWhere(query as ListOrdersQueryDto, admin);
}

/** Gom mọi mệnh đề trong `AND` để khẳng định không phụ thuộc thứ tự. */
function andClauses(where: { AND?: unknown }): unknown[] {
  return Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : [];
}

describe('OrderService.buildListWhere — trạng thái', () => {
  it('lọc nhiều trạng thái thanh toán bằng in', async () => {
    const where = await build({ financial_status: 'pending,partially_paid' });
    expect(where.financialStatus).toEqual({
      in: ['pending', 'partially_paid'],
    });
  });

  it('bỏ qua giá trị enum rác, giữ lại giá trị hợp lệ', async () => {
    const where = await build({ return_status: 'returned,khong_ton_tai' });
    expect(where.returnStatus).toEqual({ in: ['returned'] });
  });

  it('fulfillment_status=unfulfilled dịch sang NULL', async () => {
    const where = await build({ fulfillment_status: 'unfulfilled' });
    expect(andClauses(where)).toContainEqual({
      OR: [{ fulfillmentStatus: null }],
    });
  });

  it('trộn unfulfilled với giá trị enum thành hai nhánh OR', async () => {
    const where = await build({ fulfillment_status: 'unfulfilled,fulfilled' });
    expect(andClauses(where)).toContainEqual({
      OR: [
        { fulfillmentStatus: null },
        { fulfillmentStatus: { in: ['fulfilled'] } },
      ],
    });
  });

  it('không đè where.OR mà nhánh status=closed đã chiếm', async () => {
    const where = await build({
      status: 'closed',
      fulfillment_status: 'unfulfilled',
    });
    expect(where.OR).toEqual([
      { status: 'closed' },
      { fulfillmentStatus: 'fulfilled' },
    ]);
    expect(andClauses(where).length).toBe(1);
  });

  it('đóng gói và giao hàng lọc qua quan hệ fulfillments', async () => {
    const where = await build({
      packing_status: 'packed',
      shipment_status: 'delivering,delivered',
    });
    expect(andClauses(where)).toContainEqual({
      fulfillments: { some: { packedStatus: { in: ['packed'] } } },
    });
    expect(andClauses(where)).toContainEqual({
      fulfillments: {
        some: { shipmentStatus: { in: ['delivering', 'delivered'] } },
      },
    });
  });
});

describe('OrderService.buildListWhere — thực thể và khoảng', () => {
  it('nhận nhiều tag (trước đây chỉ nhận một)', async () => {
    const where = await build({ tags: 'vip, giao gap' });
    expect(where.tags).toEqual({ hasSome: ['vip', 'giao gap'] });
  });

  it('lọc đơn chứa một trong các phiên bản sản phẩm', async () => {
    const where = await build({ variant_ids: '901,902' });
    expect(andClauses(where)).toContainEqual({
      items: { some: { variantId: { in: [901n, 902n] } } },
    });
  });

  it('khoảng số lượng sản phẩm bao gồm hai đầu mút', async () => {
    const where = await build({ item_quantity_min: 1, item_quantity_max: 3 });
    expect(where.subtotalLineItemsQuantity).toEqual({ gte: 1, lte: 3 });
  });

  it('khoảng ngày nở trọn ngày theo giờ cửa hàng', async () => {
    const where = await build({
      created_on_min: '2026-08-26',
      created_on_max: '2026-08-26',
    });
    expect(where.createdOn).toEqual({
      gte: new Date('2026-08-25T17:00:00.000Z'),
      lte: new Date('2026-08-26T16:59:59.999Z'),
    });
  });

  it('mỗi sự kiện một trục ngày riêng', async () => {
    const where = await build({
      cancelled_on_min: '2026-08-01',
      paid_on_max: '2026-08-31',
    });
    expect(where.cancelledOn).toBeDefined();
    expect(where.paidOn).toBeDefined();
    expect(where.createdOn).toBeUndefined();
  });
});

describe('OrderService.buildListWhere — tương thích ngược', () => {
  it('from/to vẫn chạy như created_on_min/max', async () => {
    const cu = await build({ from: '2026-08-01', to: '2026-08-26' });
    const moi = await build({
      created_on_min: '2026-08-01',
      created_on_max: '2026-08-26',
    });
    expect(cu.createdOn).toEqual(moi.createdOn);
  });

  it('tên mới thắng khi gửi cả hai', async () => {
    const where = await build({
      from: '2026-01-01',
      created_on_min: '2026-08-01',
    });
    expect(where.createdOn).toEqual({
      gte: new Date('2026-07-31T17:00:00.000Z'),
    });
  });

  it('source đơn lẻ và sources nhiều giá trị cùng ra một dạng', async () => {
    expect((await build({ source: 'facebook' })).sourceName).toEqual({
      in: ['facebook'],
    });
    expect((await build({ sources: 'facebook,shopee' })).sourceName).toEqual({
      in: ['facebook', 'shopee'],
    });
  });

  it('location_id đơn lẻ vẫn nhận, location_ids nhận nhiều kho', async () => {
    expect((await build({ location_id: '3' })).locationId).toEqual({
      in: [3n],
    });
    expect((await build({ location_ids: '3,4' })).locationId).toEqual({
      in: [3n, 4n],
    });
  });
});
