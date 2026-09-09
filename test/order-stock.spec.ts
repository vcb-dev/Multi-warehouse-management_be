/**
 * Quy tắc "đơn đủ/thiếu hàng" — dùng chung cho tab Thiếu hàng trên màn Đơn hàng và cảnh
 * báo `orders/out_of_stock`. Chạy: npm test -- test/order-stock.spec.ts
 *
 * Chỗ này sai thì hai bên lệch nhau: thông báo ghi "18 đơn thiếu hàng", bấm vào ra 24 đơn.
 */
import { computeStockReady } from '../src/modules/orders/order-stock';

type Level = { variantId: bigint; locationId: bigint; onHand: number };

/** Bảng tồn giả — chỉ cần đúng chữ ký `inventoryLevel.findMany` mà hàm dùng tới. */
const db = (levels: Level[]) => ({
  inventoryLevel: {
    findMany: jest.fn(async () => levels),
  },
});

const order = (id: bigint, items: [bigint, number][], locationId = 1n) => ({
  id,
  locationId,
  items: items.map(([variantId, quantity]) => ({ variantId, quantity })),
});

describe('computeStockReady', () => {
  it('đủ hàng khi mọi dòng đều có on_hand >= số lượng', async () => {
    const map = await computeStockReady(
      db([{ variantId: 10n, locationId: 1n, onHand: 5 }]),
      [order(1n, [[10n, 5]])],
    );
    expect(map.get(1n)).toBe(true);
  });

  it('một dòng thiếu là cả đơn thiếu', async () => {
    // Không đóng gói được một phần rồi gửi đi — thiếu một SKU là đơn nằm lại.
    const map = await computeStockReady(
      db([
        { variantId: 10n, locationId: 1n, onHand: 99 },
        { variantId: 11n, locationId: 1n, onHand: 1 },
      ]),
      [
        order(1n, [
          [10n, 2],
          [11n, 3],
        ]),
      ],
    );
    expect(map.get(1n)).toBe(false);
  });

  it('SKU không có dòng tồn nào ở kho đó = 0, không phải "bỏ qua"', async () => {
    const map = await computeStockReady(db([]), [order(1n, [[10n, 1]])]);
    expect(map.get(1n)).toBe(false);
  });

  it('tồn của kho KHÁC không được tính sang', async () => {
    // Location nằm ở cấp đơn, nên cặp tra tồn là (variant, kho của đơn).
    const map = await computeStockReady(
      db([{ variantId: 10n, locationId: 2n, onHand: 100 }]),
      [order(1n, [[10n, 1]], 1n)],
    );
    expect(map.get(1n)).toBe(false);
  });

  it('đơn không có dòng hàng nào → coi là đủ, không phải thiếu', async () => {
    // `every` trên mảng rỗng là true: không có gì để nhặt thì không có gì để thiếu.
    const map = await computeStockReady(db([]), [order(1n, [])]);
    expect(map.get(1n)).toBe(true);
  });

  it('không có đơn nào thì KHÔNG hỏi bảng tồn', async () => {
    // `OR: []` trong Prisma khớp mọi dòng — nạp cả bảng inventory_levels vô ích.
    const reader = db([]);
    await computeStockReady(reader, []);
    expect(reader.inventoryLevel.findMany).not.toHaveBeenCalled();
  });
});
