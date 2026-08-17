import { Prisma, StockTransfer, StockTransferItem } from '@prisma/client';
import { userDisplayName } from '../../common/utils/user-display-name';

type StnWithRelations = StockTransfer & {
  items: (StockTransferItem & {
    variant?: {
      sku: string;
      cost?: Prisma.Decimal;
      product?: { name: string };
    };
  })[];
  fromLocation?: { code: string | null; name: string };
  toLocation?: { code: string | null; name: string };
  createdBy?: {
    firstName: string | null;
    lastName: string | null;
    email: string;
  } | null;
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
    from_location_id: stn.fromLocationId.toString(),
    from_location_code: stn.fromLocation?.code,
    from_location_name: stn.fromLocation?.name,
    to_location_id: stn.toLocationId.toString(),
    to_location_code: stn.toLocation?.code,
    to_location_name: stn.toLocation?.name,
    status: stn.status,
    note: stn.note,
    total_quantity: stn.totalQuantity,
    transfer_value: transferValue.toString(),
    created_by_name:
      userDisplayName(stn.createdBy) ?? stn.createdBy?.email ?? null,
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
