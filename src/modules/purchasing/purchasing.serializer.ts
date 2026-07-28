import {
  GoodsReceipt,
  GoodsReceiptItem,
  Prisma,
  PurchaseOrder,
  PurchaseOrderItem,
  PurchaseReturn,
  PurchaseReturnItem,
} from '@prisma/client';
import { userDisplayName } from '../../common/utils/user-display-name';

type PoWithItems = PurchaseOrder & {
  items: (PurchaseOrderItem & {
    variant?: { sku: string; product?: { name: string } };
  })[];
  supplier?: { code: string; name: string };
  location?: { code: string | null; name: string };
};

type ReiWithItems = GoodsReceipt & {
  items: (GoodsReceiptItem & {
    variant?: { sku: string };
    purchaseOrder?: { code: string } | null;
  })[];
  supplier?: { code: string; name: string };
  location?: { code: string | null; name: string };
  purchaseOrder?: { code: string } | null;
  assignedTo?: { firstName: string | null; lastName: string | null; email: string } | null;
};

export function serializePurchaseOrder(po: PoWithItems) {
  return {
    id: po.id.toString(),
    code: po.code,
    supplier_id: po.supplierId.toString(),
    supplier_code: po.supplier?.code,
    supplier_name: po.supplier?.name,
    location_id: po.locationId.toString(),
    location_code: po.location?.code,
    location_name: po.location?.name,
    status: po.status,
    total_quantity: po.totalQuantity,
    total_amount: po.totalAmount.toString(),
    deposit_amount: po.depositAmount.toString(),
    created_by: po.createdById.toString(),
    created_at: po.createdAt.toISOString(),
    updated_at: po.updatedAt.toISOString(),
    items: po.items.map((item) => ({
      id: item.id.toString(),
      variant_id: item.variantId.toString(),
      sku: item.variant?.sku,
      product_name: item.variant?.product?.name,
      quantity: item.quantity,
      unit_price: item.unitPrice.toString(),
      received_quantity: item.receivedQuantity,
      remaining_quantity: item.quantity - item.receivedQuantity,
    })),
  };
}

export function serializeGoodsReceipt(rei: ReiWithItems) {
  return {
    id: rei.id.toString(),
    code: rei.code,
    supplier_id: rei.supplierId.toString(),
    supplier_code: rei.supplier?.code,
    supplier_name: rei.supplier?.name,
    location_id: rei.locationId.toString(),
    location_code: rei.location?.code,
    purchase_order_id: rei.purchaseOrderId?.toString() ?? null,
    purchase_order_code: rei.purchaseOrder?.code ?? null,
    status: rei.status,
    payment_status: rei.paymentStatus,
    amount_due: rei.amountDue.toString(),
    paid_amount: rei.paidAmount.toString(),
    remaining_amount: (
      Number(rei.amountDue) - Number(rei.paidAmount)
    ).toString(),
    discount_amount: rei.discountAmount.toString(),
    extra_cost: rei.extraCost.toString(),
    deposit_applied: rei.depositApplied.toString(),
    assigned_to_id: rei.assignedToId?.toString() ?? null,
    assigned_to_name: userDisplayName(rei.assignedTo) ?? rei.assignedTo?.email ?? null,
    expected_receipt_at: rei.expectedReceiptAt?.toISOString() ?? null,
    invoice_at: rei.invoiceAt?.toISOString() ?? null,
    invoice_symbol: rei.invoiceSymbol ?? null,
    order_code: rei.orderCode ?? null,
    reference_code: rei.referenceCode ?? null,
    created_at: rei.createdAt.toISOString(),
    received_at: rei.receivedAt?.toISOString() ?? null,
    items: rei.items.map((item) => ({
      id: item.id.toString(),
      variant_id: item.variantId.toString(),
      sku: item.variant?.sku,
      purchase_order_id: item.purchaseOrderId?.toString() ?? null,
      purchase_order_code: item.purchaseOrder?.code ?? null,
      quantity: item.quantity,
      unit_price: item.unitPrice.toString(),
    })),
  };
}

export const PO_STATUS_LABELS: Record<string, string> = {
  don_nhap: 'Đơn nháp',
  cho_nhap: 'Chờ nhập',
  da_nhap: 'Đã nhập',
  huy: 'Hủy',
};

export const REI_STATUS_LABELS: Record<string, string> = {
  chua_nhap: 'Chưa nhập',
  da_nhap: 'Đã nhập',
  huy: 'Đã hủy',
};

export const PAYMENT_STATUS_LABELS: Record<string, string> = {
  chua_thanh_toan: 'Chưa thanh toán',
  mot_phan: 'Thanh toán một phần',
  da_thanh_toan: 'Đã thanh toán',
};

type PvnWithRelations = PurchaseReturn & {
  items: (PurchaseReturnItem & {
    variant?: { sku: string };
  })[];
  supplier?: { code: string; name: string };
  location?: { code: string | null; name: string };
  goodsReceipt?: { code: string } | null;
  createdBy?: { firstName: string | null; lastName: string | null; email: string } | null;
};

export function serializePurchaseReturn(pvn: PvnWithRelations) {
  return {
    id: pvn.id.toString(),
    code: pvn.code,
    supplier_id: pvn.supplierId.toString(),
    supplier_code: pvn.supplier?.code,
    supplier_name: pvn.supplier?.name,
    location_id: pvn.locationId.toString(),
    location_code: pvn.location?.code,
    goods_receipt_id: pvn.goodsReceiptId?.toString() ?? null,
    goods_receipt_code: pvn.goodsReceipt?.code ?? null,
    created_by_name: userDisplayName(pvn.createdBy) ?? pvn.createdBy?.email ?? null,
    total_quantity: pvn.totalQuantity,
    total_amount: pvn.totalAmount.toString(),
    refund_status: pvn.refundStatus,
    refunded_at: pvn.refundedAt?.toISOString() ?? null,
    created_at: pvn.createdAt.toISOString(),
    items: pvn.items.map((item) => ({
      id: item.id.toString(),
      variant_id: item.variantId.toString(),
      sku: item.variant?.sku,
      quantity: item.quantity,
      unit_price: item.unitPrice.toString(),
    })),
  };
}

export const REFUND_STATUS_LABELS: Record<string, string> = {
  chua_hoan_tien: 'Chưa nhận hoàn tiền',
  da_hoan_tien: 'Đã nhận hoàn tiền',
};

type LedgerEntryWithRelations = {
  id: bigint;
  supplierId: bigint;
  referenceType: string;
  referenceCode: string | null;
  transactionLabel: string;
  reason: string | null;
  amount: Prisma.Decimal;
  createdAt: Date;
  createdBy?: { firstName: string | null; lastName: string | null; email: string } | null;
};

export function serializeLedgerEntry(entry: LedgerEntryWithRelations) {
  return {
    id: entry.id.toString(),
    supplier_id: entry.supplierId.toString(),
    reference_type: entry.referenceType,
    reference_code: entry.referenceCode,
    transaction_label: entry.transactionLabel,
    reason: entry.reason,
    amount: entry.amount.toString(),
    created_by_name: userDisplayName(entry.createdBy) ?? entry.createdBy?.email ?? null,
    created_at: entry.createdAt.toISOString(),
  };
}
