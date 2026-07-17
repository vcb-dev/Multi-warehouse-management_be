import { Prisma, StockTransfer, StockTransferItem } from '@prisma/client';

type StnWithRelations = StockTransfer & {
  items: (StockTransferItem & {
    variant?: {
      sku: string;
      cost?: Prisma.Decimal;
      product?: { name: string };
    };
  })[];
  fromWarehouse?: { code: string; name: string };
  toWarehouse?: { code: string; name: string };
  createdBy?: { name: string | null; email: string } | null;
};

export function serializeStockTransfer(stn: StnWithRelations) {
  // Giá trị chuyển là ƯỚC TÍNH theo giá vốn HIỆN TẠI của sản phẩm — hệ thống
  // không lưu giá vốn tại thời điểm chuyển, nên đây không phải số lịch sử.
  const transferValue = stn.items.reduce((sum, item) => {
    const cost = Number(item.variant?.cost ?? 0);
    return sum + cost * item.quantity;
  }, 0);

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
    transfer_value: transferValue.toString(),
    created_by_name: stn.createdBy?.name ?? stn.createdBy?.email ?? null,
    created_at: stn.createdAt.toISOString(),
    shipped_at: stn.shippedAt?.toISOString() ?? null,
    received_at: stn.receivedAt?.toISOString() ?? null,
    items: stn.items.map((item) => ({
      id: item.id.toString(),
      variant_id: item.variantId.toString(),
      sku: item.variant?.sku,
      product_name: item.variant?.product?.name,
      cost: item.variant?.cost?.toString(),
      quantity: item.quantity,
    })),
  };
}

export const STN_STATUS_LABELS: Record<string, string> = {
  nhap: 'Phiếu nháp',
  cho_chuyen: 'Chờ chuyển',
  dang_chuyen: 'Đang chuyển',
  da_nhan: 'Đã nhận',
  huy: 'Hủy',
};
