import { Prisma, Stocktake, StocktakeItem } from '@prisma/client';
import { userDisplayName } from '../../common/utils/user-display-name';

type StocktakeWithRelations = Stocktake & {
  items: (StocktakeItem & {
    variant?: {
      sku: string;
      cost?: Prisma.Decimal | null;
      product?: { name: string };
    };
  })[];
  location?: { code: string | null; name: string };
  createdBy?: {
    firstName: string | null;
    lastName: string | null;
    email: string;
  } | null;
  balancedBy?: {
    firstName: string | null;
    lastName: string | null;
    email: string;
  } | null;
};

export function serializeStocktake(st: StocktakeWithRelations) {
  const items = st.items.map((item) => {
    // Lệch hiển thị tính trên tồn đã chụp lúc thêm dòng. Với phiếu ĐÃ cân bằng thì hai số
    // này là số chốt; với phiếu đang kiểm, tồn thật có thể đã chạy tiếp (bán ra, nhập về)
    // nên đây là ước lượng — số chốt chỉ có sau khi bấm cân bằng.
    const diff =
      item.countedQuantity == null
        ? null
        : item.countedQuantity - item.systemQuantity;
    return {
      id: item.id.toString(),
      variant_id: item.variantId.toString(),
      sku: item.variant?.sku,
      product_name: item.variant?.product?.name,
      cost: item.variant?.cost?.toString() ?? null,
      system_quantity: item.systemQuantity,
      counted_quantity: item.countedQuantity,
      diff_quantity: diff,
      note: item.note,
    };
  });

  return {
    id: st.id.toString(),
    code: st.code,
    location_id: st.locationId.toString(),
    location_code: st.location?.code ?? null,
    location_name: st.location?.name ?? null,
    status: st.status,
    note: st.note,
    diff_line_count: st.diffLineCount,
    diff_quantity: st.diffQuantity,
    counted_line_count: items.filter((i) => i.counted_quantity != null).length,
    total_line_count: items.length,
    created_by_name:
      userDisplayName(st.createdBy) ?? st.createdBy?.email ?? null,
    balanced_by_name:
      userDisplayName(st.balancedBy) ?? st.balancedBy?.email ?? null,
    created_at: st.createdAt.toISOString(),
    balanced_at: st.balancedAt?.toISOString() ?? null,
    cancelled_at: st.cancelledAt?.toISOString() ?? null,
    items,
  };
}

export const STOCKTAKE_STATUS_LABELS: Record<string, string> = {
  dang_kiem: 'Đang kiểm',
  da_can_bang: 'Đã cân bằng',
  huy: 'Đã hủy',
};
