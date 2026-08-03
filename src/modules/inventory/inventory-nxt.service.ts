import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Bổ sung các cột Nhập-Xuất-Tồn cho màn tồn kho, mô phỏng bảng NXT vận hành
 * (Màn_Tồn_Kho.xlsx): tồn đầu kỳ, SL nhập/xuất trong kỳ, bán 15/30/90 ngày,
 * hàng đang về (tách NK và chuyển kho), định mức tồn min, cần nhập, và
 * phân loại tình trạng A1..C theo quy ước bán-tồn (sheet PHÂN LOẠI).
 */

export type NxtRowInput = {
  variantId: bigint;
  locationId: bigint;
  productId: bigint;
  onHand: number;
  committed: number;
};

export type NxtExtras = {
  ton_dau_ky: number;
  sl_nhap: number;
  sl_xuat: number;
  ban_15: number;
  ban_30: number;
  ban_90: number;
  nk_dang_ve: number;
  ck_dang_ve: number;
  dm_ton_min_15: number;
  can_nhap_15: number;
  isr: number | null;
  xep_loai_ban: string;
  tinh_trang_code: string;
  tinh_trang: string;
  ncc: string | null;
  nhom_hang_1: string | null;
  nhom_hang_2: string | null;
  nhom_hang_3: string | null;
};

const EMPTY_EXTRAS: Omit<
  NxtExtras,
  'ton_dau_ky' | 'tinh_trang' | 'tinh_trang_code' | 'xep_loai_ban'
> = {
  sl_nhap: 0,
  sl_xuat: 0,
  ban_15: 0,
  ban_30: 0,
  ban_90: 0,
  nk_dang_ve: 0,
  ck_dang_ve: 0,
  dm_ton_min_15: 0,
  can_nhap_15: 0,
  isr: null,
  ncc: null,
  nhom_hang_1: null,
  nhom_hang_2: null,
  nhom_hang_3: null,
};

type MovementAgg = {
  variant_id: bigint;
  location_id: bigint;
  sl_nhap: number;
  sl_xuat: number;
  ban_15: number;
  ban_30: number;
  ban_90: number;
  nk_dang_ve: number;
  ck_dang_ve: number;
};

/** Quy ước sheet PHÂN LOẠI: xếp loại theo bán 30 ngày × ISR (Tồn/Bán) */
function classify(ban30: number, onHand: number) {
  if (ban30 <= 0) {
    return {
      isr: null,
      xepLoaiBan: 'HÀNG TỒN',
      code: 'C',
      label: 'TỒN XẤU',
    };
  }
  const isr = onHand / ban30;
  if (ban30 >= 30) {
    if (isr <= 1) {
      return {
        isr,
        xepLoaiBan: 'Bán CHẠY',
        code: 'A1',
        label: 'Bán CHẠY-Tồn TỐI ƯU',
      };
    }
    if (isr < 3) {
      return {
        isr,
        xepLoaiBan: 'Bán CHẠY',
        code: 'A2',
        label: 'Bán CHẠY-Tồn AN TOÀN',
      };
    }
    return {
      isr,
      xepLoaiBan: 'Bán CHẠY',
      code: 'A3',
      label: 'Bán CHẠY-Tồn BÁO ĐỘNG',
    };
  }
  if (isr < 2) {
    return {
      isr,
      xepLoaiBan: 'Bán CHẬM',
      code: 'B1',
      label: 'Bán CHẬM-Tồn AN TOÀN',
    };
  }
  return {
    isr,
    xepLoaiBan: 'Bán CHẬM',
    code: 'B2',
    label: 'Bán CHẬM-Tồn BÁO ĐỘNG',
  };
}

@Injectable()
export class InventoryNxtService {
  constructor(private prisma: PrismaService) {}

  /**
   * Tính extras cho một trang kết quả. `from` là đầu kỳ NXT (mặc định đầu
   * tháng hiện tại); kỳ luôn kết thúc ở hiện tại nên tồn cuối kỳ = on_hand.
   */
  async enrich(
    rows: NxtRowInput[],
    from?: Date,
  ): Promise<Map<string, NxtExtras>> {
    const result = new Map<string, NxtExtras>();
    if (!rows.length) return result;

    const periodFrom = from ?? startOfCurrentMonth();
    const now = Date.now();
    const d15 = new Date(now - 15 * 86400_000);
    const d30 = new Date(now - 30 * 86400_000);
    const d90 = new Date(now - 90 * 86400_000);

    const pairs = Prisma.join(
      rows.map((r) => Prisma.sql`(${r.variantId}, ${r.locationId})`),
    );
    const variantIds = [...new Set(rows.map((r) => r.variantId))];
    const productIds = [...new Set(rows.map((r) => r.productId))];

    const [aggs, suppliers, categoryLinks] = await Promise.all([
      this.prisma.$queryRaw<MovementAgg[]>`
        SELECT
          variant_id,
          location_id,
          COALESCE(SUM(change) FILTER (
            WHERE bucket = 'on_hand' AND created_at >= ${periodFrom} AND change > 0
          ), 0)::int AS sl_nhap,
          COALESCE(-SUM(change) FILTER (
            WHERE bucket = 'on_hand' AND created_at >= ${periodFrom} AND change < 0
          ), 0)::int AS sl_xuat,
          COALESCE(-SUM(change) FILTER (
            WHERE bucket = 'on_hand' AND type = 'order_ship' AND created_at >= ${d15}
          ), 0)::int AS ban_15,
          COALESCE(-SUM(change) FILTER (
            WHERE bucket = 'on_hand' AND type = 'order_ship' AND created_at >= ${d30}
          ), 0)::int AS ban_30,
          COALESCE(-SUM(change) FILTER (
            WHERE bucket = 'on_hand' AND type = 'order_ship' AND created_at >= ${d90}
          ), 0)::int AS ban_90,
          COALESCE(SUM(change) FILTER (
            WHERE bucket = 'incoming'
              AND type IN ('incoming_po', 'incoming_receipt', 'incoming_cancel')
          ), 0)::int AS nk_dang_ve,
          COALESCE(SUM(change) FILTER (
            WHERE bucket = 'incoming' AND type = 'incoming_transfer'
          ), 0)::int AS ck_dang_ve
        FROM inventory_movements
        WHERE (variant_id, location_id) IN (${pairs})
        GROUP BY variant_id, location_id
      `,
      this.prisma.$queryRaw<{ variant_id: bigint; name: string }[]>`
        SELECT DISTINCT gri.variant_id, s.name
        FROM goods_receipt_items gri
        JOIN goods_receipts gr ON gr.id = gri.goods_receipt_id
        JOIN suppliers s ON s.id = gr.supplier_id
        WHERE gri.variant_id IN (${Prisma.join(variantIds)})
      `,
      this.prisma.productCategory.findMany({
        where: { productId: { in: productIds } },
        include: {
          category: {
            include: { parent: { include: { parent: true } } },
          },
        },
        orderBy: { categoryId: 'asc' },
      }),
    ]);

    const aggByKey = new Map(
      aggs.map((a) => [`${a.variant_id}:${a.location_id}`, a]),
    );

    const nccByVariant = new Map<string, string[]>();
    for (const s of suppliers) {
      const key = s.variant_id.toString();
      const list = nccByVariant.get(key) ?? [];
      list.push(s.name);
      nccByVariant.set(key, list);
    }

    // Nhóm hàng 1/2/3 = chuỗi cha → con của danh mục đầu tiên gán cho SP
    const categoryPathByProduct = new Map<string, (string | null)[]>();
    for (const link of categoryLinks) {
      const key = link.productId.toString();
      if (categoryPathByProduct.has(key)) continue;
      const leaf = link.category;
      const chain = [leaf.parent?.parent, leaf.parent, leaf]
        .filter((c): c is NonNullable<typeof c> => Boolean(c))
        .map((c) => c.name);
      categoryPathByProduct.set(key, [
        chain[0] ?? null,
        chain[1] ?? null,
        chain[2] ?? null,
      ]);
    }

    for (const row of rows) {
      const key = `${row.variantId}:${row.locationId}`;
      const agg = aggByKey.get(key);

      const slNhap = agg?.sl_nhap ?? 0;
      const slXuat = agg?.sl_xuat ?? 0;
      const ban15 = agg?.ban_15 ?? 0;
      const ban30 = agg?.ban_30 ?? 0;
      const ban90 = agg?.ban_90 ?? 0;
      const nkDangVe = agg?.nk_dang_ve ?? 0;
      const ckDangVe = agg?.ck_dang_ve ?? 0;

      // Công thức Excel: ĐM = (Bán30 + Bán15)/45×15, dưới 5 coi như 0
      const dmRaw = ((ban30 + ban15) / 45) * 15;
      const dmTonMin = dmRaw < 5 ? 0 : Math.round(dmRaw * 100) / 100;

      // Cần nhập = ĐM − tồn − đang về + hàng đặt (bỏ "kế hoạch bán" — không có nguồn)
      const canNhapRaw =
        dmTonMin - row.onHand - nkDangVe - ckDangVe + row.committed;
      const canNhap = canNhapRaw / 2 < 1 ? 0 : Math.round(canNhapRaw);

      const cls = classify(ban30, row.onHand);
      const nccNames = nccByVariant.get(row.variantId.toString());
      const path = categoryPathByProduct.get(row.productId.toString());

      result.set(key, {
        ...EMPTY_EXTRAS,
        ton_dau_ky: row.onHand - (slNhap - slXuat),
        sl_nhap: slNhap,
        sl_xuat: slXuat,
        ban_15: ban15,
        ban_30: ban30,
        ban_90: ban90,
        nk_dang_ve: nkDangVe,
        ck_dang_ve: ckDangVe,
        dm_ton_min_15: dmTonMin,
        can_nhap_15: canNhap,
        isr: cls.isr === null ? null : Math.round(cls.isr * 100) / 100,
        xep_loai_ban: cls.xepLoaiBan,
        tinh_trang_code: cls.code,
        tinh_trang: cls.label,
        ncc: nccNames?.length ? nccNames.slice(0, 3).join('; ') : null,
        nhom_hang_1: path?.[0] ?? null,
        nhom_hang_2: path?.[1] ?? null,
        nhom_hang_3: path?.[2] ?? null,
      });
    }

    return result;
  }
}

function startOfCurrentMonth(): Date {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

/** Mã SP gốc = phần SKU trước dấu "-" đầu tiên (quy ước bảng NXT) */
export function rootProductCode(sku: string): string {
  const idx = sku.indexOf('-');
  return idx > 0 ? sku.slice(0, idx) : sku;
}
