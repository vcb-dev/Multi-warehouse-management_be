import { Prisma } from '@prisma/client';
import { userDisplayName } from '../../common/utils/user-display-name';

function dec(v: Prisma.Decimal): number {
  return Number(v);
}

export function serializeOrderReturnLine(row: {
  id: bigint;
  sku: string;
  productName: string;
  variantTitle: string | null;
  quantity: number;
  price: Prisma.Decimal;
  orderReturn: {
    id: bigint;
    code: string;
    reason: string | null;
    refundAmount: Prisma.Decimal;
    restock: boolean;
    createdAt: Date;
    order: {
      code: string;
      sourceName: string | null;
      returnStatus: string;
      refundStatus: string;
      location: { name: string };
    };
    createdBy: { firstName: string | null; lastName: string | null; email: string };
  };
}) {
  const ret = row.orderReturn;
  return {
    id: row.id.toString(),
    return_id: ret.id.toString(),
    return_code: ret.code,
    order_code: ret.order.code,
    location_name: ret.order.location.name,
    source_name: ret.order.sourceName,
    return_status: ret.order.returnStatus,
    refund_status: ret.order.refundStatus,
    restock_status: ret.restock ? 'da_nhap_kho' : 'khong_nhap_kho',
    sku: row.sku,
    product_name: row.productName,
    variant_title: row.variantTitle,
    quantity: row.quantity,
    price: dec(row.price),
    line_total: dec(row.price) * row.quantity,
    refund_amount: dec(ret.refundAmount),
    reason: ret.reason,
    created_by_name: userDisplayName(ret.createdBy) ?? ret.createdBy.email,
    created_at: ret.createdAt.toISOString(),
  };
}
