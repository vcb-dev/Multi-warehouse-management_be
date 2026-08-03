/**
 * Đường ĐỌC của purchasing phải nhận `AuthUser` để lọc theo kho — trước Phase 4
 * các hàm này không nhận user nên ai có `inventory:view` ở một kho là đọc được
 * PO/phiếu nhập/phiếu trả của MỌI kho.
 *
 * Kiểm qua arity: rẻ, tất định, không cần DB. Nó không chứng minh việc lọc là
 * đúng (phần đó ở permission-model.spec.ts §5) nhưng chặn được việc ai đó bỏ
 * tham số user đi và làm lỗ hổng quay lại.
 */
import { GoodsReceiptService } from '../src/modules/purchasing/goods-receipt.service';
import { PurchaseOrderService } from '../src/modules/purchasing/purchase-order.service';
import { PurchaseReturnService } from '../src/modules/purchasing/purchase-return.service';
import { ProductService } from '../src/modules/products/product.service';

const readMethods: [string, (...args: never[]) => unknown][] = [
  ['PurchaseOrderService.list', PurchaseOrderService.prototype.list],
  ['PurchaseOrderService.findOne', PurchaseOrderService.prototype.findOne],
  ['GoodsReceiptService.list', GoodsReceiptService.prototype.list],
  ['GoodsReceiptService.findOne', GoodsReceiptService.prototype.findOne],
  ['PurchaseReturnService.list', PurchaseReturnService.prototype.list],
  ['PurchaseReturnService.findOne', PurchaseReturnService.prototype.findOne],
  ['ProductService.getInventory', ProductService.prototype.getInventory],
];

describe('Purchasing — phạm vi kho ở đường đọc', () => {
  describe.each(readMethods)('%s', (_name, method) => {
    it('nhận AuthUser để lọc theo kho', () => {
      expect(method.length).toBeGreaterThanOrEqual(2);
    });
  });
});
