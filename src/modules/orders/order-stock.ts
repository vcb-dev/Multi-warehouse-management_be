import { OrderStatus, Prisma } from '@prisma/client';

/**
 * Định nghĩa "đơn đủ/thiếu hàng" — NGUỒN DUY NHẤT cho cả màn danh sách đơn và cảnh báo
 * `orders/out_of_stock`.
 *
 * Tách ra file riêng (không phải provider Nest) vì hai bên dùng nằm ở hai module phụ thuộc
 * một chiều: `OrdersModule` đã import `InventoryModule`, nên để `InventoryAlertService` gọi
 * ngược sang `OrderService` là tạo vòng. Một file thuần chỉ chứa quy tắc thì cả hai import
 * được mà không sinh vòng nào.
 *
 * Vì sao phải dùng chung chứ không chép: thông báo ghi "kho A có 18 đơn thiếu hàng" rồi
 * bấm vào ra 24 đơn là mất hết niềm tin vào thông báo. Cùng một bài học đã ghi ở cảnh báo
 * tồn kho — link phải cho ra ĐÚNG con số ghi trên thông báo.
 */

/**
 * Đơn còn phải xử lý — tập mà "đủ/thiếu hàng" mới có nghĩa.
 *
 * Không thể chỉ lọc `status='open'`: dữ liệu Sapo thật có 75.125 đơn `open` nhưng 73.402
 * trong số đó đã giao xong (Sapo không đóng đơn sau khi giao), nạp hết sẽ vượt
 * `statement_timeout`. Thêm `fulfillment_status IS NULL` để về đúng ~1.7k đơn đang chờ thật.
 */
export const PENDING_ORDER_WHERE: Prisma.OrderWhereInput = {
  status: OrderStatus.open,
  fulfillmentStatus: null,
};

/** Bảng tra tồn tối thiểu mà {@link computeStockReady} cần — nhận cả PrismaService lẫn tx. */
type InventoryReader = {
  inventoryLevel: {
    findMany(args: {
      where: { OR: { variantId: bigint; locationId: bigint }[] };
      select: { variantId: true; locationId: true; onHand: true };
    }): Promise<{ variantId: bigint; locationId: bigint; onHand: number }[]>;
  };
};

export type OrderForStockCheck = {
  id: bigint;
  // Location ở cấp đơn (theo Sapo), nên cặp tra tồn là (variant, location của đơn).
  locationId: bigint;
  items: { variantId: bigint; quantity: number }[];
};

/**
 * `id đơn → đủ hàng hay không`. Đủ hàng = MỌI dòng đều có `on_hand >= quantity`.
 *
 * Cố ý dùng `on_hand` chứ không phải `available`: câu hỏi ở đây là "có nhặt được hàng
 * trong kho ngay bây giờ không", còn `available` đã trừ phần giữ chỗ cho chính những đơn
 * đang xét — dùng nó thì đơn nào cũng thành thiếu hàng.
 *
 * Đơn không có dòng hàng nào trả `true` (`every` trên mảng rỗng): không có gì để nhặt thì
 * không có gì để thiếu.
 */
export async function computeStockReady(
  db: InventoryReader,
  orders: OrderForStockCheck[],
): Promise<Map<bigint, boolean>> {
  const pairs = new Map<string, { variantId: bigint; locationId: bigint }>();
  for (const row of orders) {
    for (const item of row.items) {
      pairs.set(`${item.variantId}:${row.locationId}`, {
        variantId: item.variantId,
        locationId: row.locationId,
      });
    }
  }
  const levels = pairs.size
    ? await db.inventoryLevel.findMany({
        where: { OR: Array.from(pairs.values()) },
        select: { variantId: true, locationId: true, onHand: true },
      })
    : [];
  const onHandMap = new Map(
    levels.map((l) => [`${l.variantId}:${l.locationId}`, l.onHand]),
  );
  return new Map<bigint, boolean>(
    orders.map((row) => [
      row.id,
      row.items.every(
        (i) =>
          (onHandMap.get(`${i.variantId}:${row.locationId}`) ?? 0) >=
          i.quantity,
      ),
    ]),
  );
}
