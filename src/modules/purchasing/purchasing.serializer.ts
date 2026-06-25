import {
  GoodsReceipt,
  GoodsReceiptItem,
  PurchaseOrder,
  PurchaseOrderItem,
  PurchaseReturn,
  PurchaseReturnItem,
} from '@prisma/client';

type PoWithItems = PurchaseOrder & {
  items: (PurchaseOrderItem & { variant?: { sku: string } })[];
  supplier?: { code: string; name: string };
  warehouse?: { code: string; name: string };
  branch?: { code: string; name: string };
};

type ReiWithItems = GoodsReceipt & {
  items: (GoodsReceiptItem & {
    variant?: { sku: string };
    lot?: { code: string };
  })[];
  supplier?: { code: string; name: string };
  warehouse?: { code: string; name: string };
  purchaseOrder?: { code: string } | null;
};

export function serializePurchaseOrder(po: PoWithItems) {
  return {
    id: po.id.toString(),
    code: po.code,
    supplier_id: po.supplierId.toString(),
    supplier_code: po.supplier?.code,
    supplier_name: po.supplier?.name,
    branch_id: po.branchId.toString(),
    branch_code: po.branch?.code,
    warehouse_id: po.warehouseId.toString(),
    warehouse_code: po.warehouse?.code,
    warehouse_name: po.warehouse?.name,
    status: po.status,
    total_quantity: po.totalQuantity,
    total_amount: po.totalAmount.toString(),
    created_by: po.createdById.toString(),
    created_at: po.createdAt.toISOString(),
    updated_at: po.updatedAt.toISOString(),
    items: po.items.map((item) => ({
      id: item.id.toString(),
      variant_id: item.variantId.toString(),
      sku: item.variant?.sku,
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
    warehouse_id: rei.warehouseId.toString(),
    warehouse_code: rei.warehouse?.code,
    purchase_order_id: rei.purchaseOrderId?.toString() ?? null,
    purchase_order_code: rei.purchaseOrder?.code ?? null,
    status: rei.status,
    payment_status: rei.paymentStatus,
    amount_due: rei.amountDue.toString(),
    created_at: rei.createdAt.toISOString(),
    received_at: rei.receivedAt?.toISOString() ?? null,
    items: rei.items.map((item) => ({
      id: item.id.toString(),
      variant_id: item.variantId.toString(),
      sku: item.variant?.sku,
      lot_id: item.lotId.toString(),
      lot_code: item.lot?.code,
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
};

type PvnWithRelations = PurchaseReturn & {
  items: (PurchaseReturnItem & {
    variant?: { sku: string };
    lot?: { code: string };
  })[];
  supplier?: { code: string; name: string };
  warehouse?: { code: string; name: string };
};

export function serializePurchaseReturn(pvn: PvnWithRelations) {
  return {
    id: pvn.id.toString(),
    code: pvn.code,
    supplier_id: pvn.supplierId.toString(),
    supplier_code: pvn.supplier?.code,
    supplier_name: pvn.supplier?.name,
    warehouse_id: pvn.warehouseId.toString(),
    warehouse_code: pvn.warehouse?.code,
    total_quantity: pvn.totalQuantity,
    total_amount: pvn.totalAmount.toString(),
    created_at: pvn.createdAt.toISOString(),
    items: pvn.items.map((item) => ({
      id: item.id.toString(),
      variant_id: item.variantId.toString(),
      sku: item.variant?.sku,
      lot_id: item.lotId.toString(),
      lot_code: item.lot?.code,
      quantity: item.quantity,
      unit_price: item.unitPrice.toString(),
    })),
  };
}
