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
    createdBy: {
      firstName: string | null;
      lastName: string | null;
      email: string;
    };
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

/** Phiếu lập trong app mang mã `RTN…`; phiếu chép từ sàn/Sapo dùng tiền tố khác. */
export function isAppManagedReturn(code: string) {
  return code.startsWith('RTN');
}

const userSelect = {
  select: { firstName: true, lastName: true, email: true },
} as const;

export const returnDocumentInclude = {
  order: {
    select: {
      id: true,
      name: true,
      sourceName: true,
      locationId: true,
      location: { select: { name: true } },
      customer: {
        select: { firstName: true, lastName: true, phone: true },
      },
    },
  },
  lineItems: { orderBy: { id: 'asc' } },
  createdBy: userSelect,
  receivedBy: userSelect,
  refundedBy: userSelect,
} satisfies Prisma.OrderReturnInclude;

export type ReturnDocumentRow = Prisma.OrderReturnGetPayload<{
  include: typeof returnDocumentInclude;
}>;

function nameOf(
  u: {
    firstName: string | null;
    lastName: string | null;
    email: string;
  } | null,
) {
  return u ? (userDisplayName(u) ?? u.email) : null;
}

/**
 * Ba trạng thái con của phiếu, tách riêng như Sapo ("Trạng thái nhận hàng",
 * "Trạng thái nhập kho", "Trạng thái hoàn trả") — suy từ số liệu, không lưu.
 */
export function returnStepStatuses(r: {
  receivedOn: Date | null;
  restocked: boolean | null;
  refundAmount: Prisma.Decimal | number;
  refundedAmount: Prisma.Decimal | number;
}) {
  const planned = Number(r.refundAmount);
  const paid = Number(r.refundedAmount);
  return {
    receive_status: r.receivedOn ? 'received' : 'not_received',
    restock_status: r.receivedOn && r.restocked ? 'restocked' : 'no_restock',
    refund_status:
      paid <= 0 ? 'no_refund' : paid >= planned ? 'refunded' : 'partial',
  } as const;
}

/** Một phiếu trả hàng, dùng cho cả danh sách lẫn trang chi tiết. */
export function serializeReturnDocument(r: ReturnDocumentRow) {
  const planned = dec(r.refundAmount);
  const paid = dec(r.refundedAmount);
  const customer = r.order.customer;
  return {
    id: r.id.toString(),
    code: r.code,
    status: r.status,
    ...returnStepStatuses(r),
    /** false = phiếu của sàn/Sapo, chỉ xem */
    manageable: isAppManagedReturn(r.code),
    order_id: r.order.id.toString(),
    order_name: r.order.name,
    source_name: r.order.sourceName,
    location_name: r.order.location.name,
    customer_name: customer
      ? [customer.firstName, customer.lastName].filter(Boolean).join(' ') ||
        null
      : null,
    customer_phone: customer?.phone ?? null,
    reason_code: r.reasonCode,
    reason: r.reason,
    total_quantity: r.lineItems.reduce((s, l) => s + l.quantity, 0),
    total_value: r.lineItems.reduce((s, l) => s + dec(l.subtotal), 0),
    refund_amount: planned,
    refunded_amount: paid,
    refund_remaining: Math.max(planned - paid, 0),
    tracking_number: r.trackingNumber,
    carrier_name: r.carrierName,
    received_on: r.receivedOn?.toISOString() ?? null,
    received_by_name: nameOf(r.receivedBy),
    refunded_on: r.refundedOn?.toISOString() ?? null,
    refunded_by_name: nameOf(r.refundedBy),
    completed_on: r.completedOn?.toISOString() ?? null,
    cancelled_on: r.cancelledOn?.toISOString() ?? null,
    created_by_name: nameOf(r.createdBy),
    created_on: r.createdOn.toISOString(),
    items: r.lineItems.map((l) => ({
      id: l.id.toString(),
      variant_id: l.variantId.toString(),
      sku: l.sku,
      product_name: l.productName,
      variant_title: l.variantTitle,
      quantity: l.quantity,
      price: dec(l.price),
      subtotal: dec(l.subtotal),
    })),
  };
}
