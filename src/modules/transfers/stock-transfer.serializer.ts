import { StockTransfer, StockTransferItem } from '@prisma/client';

type StnWithRelations = StockTransfer & {
  items: (StockTransferItem & {
    variant?: { sku: string };
    lot?: { code: string };
  })[];
  fromWarehouse?: { code: string; name: string };
  toWarehouse?: { code: string; name: string };
};

export function serializeStockTransfer(stn: StnWithRelations) {
  return {
    id: stn.id.toString(),
    code: stn.code,
    from_warehouse_id: stn.fromWarehouseId.toString(),
    from_warehouse_code: stn.fromWarehouse?.code,
    from_warehouse_name: stn.fromWarehouse?.name,
    to_warehouse_id: stn.toWarehouseId.toString(),
    to_warehouse_code: stn.toWarehouse?.code,
    to_warehouse_name: stn.toWarehouse?.name,
    status: stn.status,
    note: stn.note,
    total_quantity: stn.totalQuantity,
    created_at: stn.createdAt.toISOString(),
    received_at: stn.receivedAt?.toISOString() ?? null,
    items: stn.items.map((item) => ({
      id: item.id.toString(),
      variant_id: item.variantId.toString(),
      sku: item.variant?.sku,
      lot_id: item.lotId.toString(),
      lot_code: item.lot?.code,
      quantity: item.quantity,
    })),
  };
}

export const STN_STATUS_LABELS: Record<string, string> = {
  dang_chuyen: 'Đang chuyển',
  da_nhan: 'Đã nhận',
  huy: 'Hủy',
};
