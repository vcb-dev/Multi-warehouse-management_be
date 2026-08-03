import { Prisma, RestockType } from '@prisma/client';
import { userDisplayName } from '../../common/utils/user-display-name';

function dec(v: Prisma.Decimal): number {
  return Number(v);
}

/**
 * Một dòng hàng của bản ghi hoàn (`order_refund_items`).
 *
 * `restock_status` trả về đúng bộ giá trị Sapo (`restocked`/`no_restock`) suy ra
 * từ `restock_type` của chính dòng đó — trước đây serializer tự sinh bộ tiếng
 * Việt riêng (`da_nhap_kho`/`khong_nhap_kho`) không khớp `orders.restock_status`.
 *
 * Phân loại hoàn/huỷ phải dựa vào `restock_type`, KHÔNG dựa vào `return_id`:
 * dữ liệu Sapo thật có 2.757 dòng trả hàng (`return_item`/`no_restock`) mà
 * `return_id` vẫn null — trả hàng không đi qua phiếu return. Chỉ 56 dòng có
 * phiếu return kèm theo.
 */
export function serializeOrderReturnLine(row: {
  id: bigint;
  sku: string;
  productName: string;
  variantTitle: string | null;
  quantity: number;
  price: Prisma.Decimal;
  restockType: RestockType;
  refund: {
    id: bigint;
    note: string | null;
    totalRefunded: Prisma.Decimal;
    restock: boolean;
    createdOn: Date;
    orderReturn: { id: bigint; code: string; reason: string | null } | null;
    order: {
      name: string;
      sourceName: string | null;
      returnStatus: string;
      refundStatus: string;
      location: { name: string };
    };
    createdBy: { firstName: string | null; lastName: string | null; email: string };
  };
}) {
  const rf = row.refund;
  const isCancel = row.restockType === RestockType.cancel;
  return {
    id: row.id.toString(),
    refund_id: rf.id.toString(),
    /** `cancel` = huỷ đơn, `return` = khách trả hàng (suy từ restock_type) */
    refund_kind: isCancel ? 'cancel' : 'return',
    // `return_id` chỉ có khi trả hàng đi qua phiếu return của Sapo — phần lớn
    // dòng trả hàng lịch sử không có, nên đừng dùng nó để phân loại.
    return_id: rf.orderReturn?.id.toString() ?? null,
    return_code: rf.orderReturn?.code ?? null,
    order_name: rf.order.name,
    location_name: rf.order.location.name,
    source_name: rf.order.sourceName,
    return_status: rf.order.returnStatus,
    refund_status: rf.order.refundStatus,
    restock_type: row.restockType,
    restock_status:
      row.restockType === RestockType.return_item ? 'restocked' : 'no_restock',
    sku: row.sku,
    product_name: row.productName,
    variant_title: row.variantTitle,
    quantity: row.quantity,
    price: dec(row.price),
    line_total: dec(row.price) * row.quantity,
    refund_amount: dec(rf.totalRefunded),
    reason: rf.orderReturn?.reason ?? rf.note,
    created_by_name: userDisplayName(rf.createdBy) ?? rf.createdBy.email,
    created_at: rf.createdOn.toISOString(),
  };
}
