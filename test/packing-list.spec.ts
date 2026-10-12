/**
 * Điều kiện lọc màn "In & đóng gói" — hàm thuần, không đụng DB.
 */
import { buildPackingListWhere } from '../src/modules/fulfillments/packing-list';

function clauses(where: ReturnType<typeof buildPackingListWhere>) {
  return where.AND as object[];
}

describe('buildPackingListWhere', () => {
  it('chỉ lấy kiện còn trong kho: phiếu mở, chưa huỷ, hãng chưa lấy hàng', () => {
    const where = buildPackingListWhere({}, undefined);
    expect(where).toMatchObject({
      status: { not: 'cancelled' },
      closedAt: null,
      cancelledOn: null,
    });
    expect(clauses(where)).toEqual([
      { OR: [{ shipmentStatus: null }, { shipmentStatus: 'pending' }] },
    ]);
  });

  it('lọc kho theo đơn hàng vì phiếu chờ đóng gói chưa có location_id', () => {
    const where = buildPackingListWhere({}, [1n, 2n]);
    expect(clauses(where)).toContainEqual({
      order: { locationId: { in: [1n, 2n] } },
    });
  });

  it.each([
    ['not_shipped', { shipmentStatus: null }],
    ['not_printed', { deliveryNotePrintedAt: null }],
    ['printed', { deliveryNotePrintedAt: { not: null } }],
    [
      'not_packed',
      {
        OR: [
          { packedStatus: null },
          { packedStatus: { in: ['unknown', 'packing'] } },
        ],
      },
    ],
    ['packed', { packedStatus: 'packed' }],
  ])('tab %s', (tab, clause) => {
    expect(clauses(buildPackingListWhere({ tab }, undefined))).toContainEqual(
      clause,
    );
  });

  it('tab và bộ lọc cộng dồn, không đè lên phạm vi hàng đợi', () => {
    const where = buildPackingListWhere(
      {
        tab: 'not_printed',
        packing_status: 'unknown,packing',
        package_category: 'multiple_items',
        provider_ids: '7',
        sources: 'shopee,tiktokshop',
        q: ' FUN80 ',
      },
      undefined,
    );
    expect(clauses(where)).toEqual([
      { OR: [{ shipmentStatus: null }, { shipmentStatus: 'pending' }] },
      { deliveryNotePrintedAt: null },
      { packedStatus: { in: ['unknown', 'packing'] } },
      { packageCategory: { in: ['multiple_items'] } },
      { providerId: { in: [7n] } },
      { order: { sourceName: { in: ['shopee', 'tiktokshop'] } } },
      {
        OR: [
          { name: { contains: 'FUN80', mode: 'insensitive' } },
          { trackingNumber: { contains: 'FUN80', mode: 'insensitive' } },
          { order: { name: { contains: 'FUN80', mode: 'insensitive' } } },
        ],
      },
    ]);
  });

  it('trạng thái đóng gói không hợp lệ cho ra 0 dòng chứ không bỏ lọc', () => {
    const where = buildPackingListWhere({ packing_status: 'bogus' }, undefined);
    expect(clauses(where)).toContainEqual({ packedStatus: { in: [] } });
  });

  it('printed=false lọc kiện chưa in', () => {
    const where = buildPackingListWhere({ printed: 'false' }, undefined);
    expect(clauses(where)).toContainEqual({ deliveryNotePrintedAt: null });
  });
});
