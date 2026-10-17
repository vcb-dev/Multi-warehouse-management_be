import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { BusinessException } from '../../common/exceptions/business.exception';
import { PrismaService } from '../../prisma/prisma.service';
import { SapoClient } from '../products/sapo-sync/sapo-client';
import {
  agedQty,
  colorFromSku,
  daysSince,
  fifoLayers,
  isJewelryGroup,
  orderSoldQty,
  pickImage,
  pickSizeColor,
  productGroup,
  ReceiptLot,
  salesWindow,
  SapoOrderForSales,
  sizeFromSku,
  variantTitle,
  vnDateKey,
} from './aged-inventory.calc';

/**
 * Dựng ảnh chụp "trang sức còn hàng + số ngày tồn" của một ngày, kéo THẲNG từ Sapo.
 *
 * Không đọc `inventory_levels` của OMS: tồn ở đó đã xoá sạch 14/09/2026 và Sapo vẫn là nơi
 * vận hành kho thật. Cũng không ghi gì vào bảng tồn của OMS — chỉ ghi bảng snapshot riêng.
 *
 * Ba nguồn Sapo:
 * 1. `/admin/products.json` — catalog, lọc nhóm trang sức, lấy tên/SKU/size/màu/ảnh và
 *    ngày tạo phiên bản (~53 lượt gọi).
 * 2. `/admin/inventory_levels.json` — tồn theo kho của từng phiên bản trang sức (lượt dài
 *    nhất: ~13k phiên bản × 16 kho, vài trăm lượt gọi).
 * 3. `/admin/receive_inventories.json` — phiếu nhập đã nhận, làm mốc tuổi tồn (FIFO).
 *    Sapo trả 403 cho chuyển kho / lịch sử tồn / điều chỉnh tồn nên đây là mốc duy nhất.
 * 4. `/admin/orders.json` — đơn 30 ngày tròn trước hôm nay, ra "bán 30 ngày" (~30 lượt gọi).
 *    Không lấy từ bảng `orders` của OMS: đơn đã xoá 14/09/2026 và chưa đồng bộ lại.
 */

/** Số `inventory_item_id` hỏi mỗi lượt — giống `SapoInventorySyncService`. */
const LEVEL_BATCH = 40;
const PAGE_LIMIT = 250;
/** 22 tham số × 500 dòng = 10.500, xa trần 32.767 bind của Postgres. */
const WRITE_CHUNK = 500;
const DEFAULT_RETENTION_DAYS = 90;
/** Ngưỡng ghi vào tóm tắt/log; API cho chọn ngưỡng khác qua `min_days`. */
const SUMMARY_MIN_DAYS = 30;
const SALES_WINDOW_DAYS = 30;
/** Chặn vòng lặp nếu Sapo trả trang đầy mãi — 30 ngày hiện ~7.000 đơn = ~28 trang. */
const MAX_ORDER_PAGES = 400;

type SapoLevelRow = {
  inventory_item_id?: number | string | null;
  location_id?: number | string | null;
  on_hand?: number | string | null;
  available?: number | string | null;
};

type SapoReceipt = {
  id: number;
  location_id?: number | null;
  received_on?: string | null;
  cancelled_on?: string | null;
  receipt_status?: string | null;
  line_items?: { variant_id?: number | null; quantity?: number | string }[];
};

interface JewelryVariant {
  sapoProductId: number;
  sapoVariantId: number;
  inventoryItemId: number;
  productName: string;
  productType: string | null;
  group: string;
  sku: string | null;
  variantTitle: string | null;
  size: string | null;
  color: string | null;
  imageUrl: string | null;
  createdOn: Date;
}

interface LocationStock {
  sapoLocationId: string;
  onHand: number;
  available: number;
}

export interface AgedInventoryBuildResult {
  snapshot_date: string;
  jewelry_variants: number;
  variants_in_stock: number;
  units_in_stock: number;
  aged_variants_30d: number;
  receipt_lines_used: number;
  orders_scanned: number;
  units_sold_30d: number;
  unmatched_locations: string[];
  purged_rows: number;
  duration_ms: number;
}

const round = (v: unknown) => Math.round(Number(v ?? 0));

@Injectable()
export class AgedInventorySnapshotService {
  private readonly logger = new Logger(AgedInventorySnapshotService.name);
  /** Dùng chung cho cron và nút chạy tay — một lượt dài ~10 phút, không cho chồng nhau. */
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sapo: SapoClient,
  ) {}

  isConfigured(): boolean {
    return this.sapo.isConfigured();
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Chạy một lượt nếu chưa có lượt nào đang chạy; trả null nếu đang bận. */
  async runExclusive(): Promise<AgedInventoryBuildResult | null> {
    if (this.running) return null;
    this.running = true;
    try {
      return await this.buildSnapshot();
    } finally {
      this.running = false;
    }
  }

  /** Cho endpoint chạy tay: khởi chạy nền rồi trả ngay, kết quả xem ở log / `generated_at`. */
  startInBackground(): { started: true; snapshot_date: string } {
    if (!this.sapo.isConfigured()) {
      throw new BusinessException(
        'CHANNEL_NOT_CONFIGURED',
        'Thiếu SAPO_STORE/SAPO_API_KEY/SAPO_API_SECRET trong cấu hình server',
        500,
      );
    }
    if (this.running) {
      throw new BusinessException(
        'AGED_INVENTORY_RUNNING',
        'Đang có một lượt dựng snapshot tồn lâu chạy, thử lại sau ít phút.',
        409,
      );
    }
    void this.runExclusive()
      .then((r) => r && this.logResult('Chạy tay', r))
      .catch((e) =>
        this.logger.error(
          `Snapshot tồn lâu (chạy tay) thất bại: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
    return { started: true, snapshot_date: vnDateKey(new Date()) };
  }

  logResult(label: string, r: AgedInventoryBuildResult) {
    this.logger.log(
      `${label} snapshot tồn lâu ${r.snapshot_date}: ${r.variants_in_stock}/${r.jewelry_variants} phiên bản trang sức còn hàng ` +
        `(${r.units_in_stock} món), ${r.aged_variants_30d} phiên bản tồn ≥ ${SUMMARY_MIN_DAYS} ngày; ` +
        `${r.receipt_lines_used} dòng phiếu nhập; ${r.orders_scanned} đơn 30 ngày (${r.units_sold_30d} món trang sức còn hàng đã bán); ` +
        `${r.unmatched_locations.length} kho Sapo không khớp local; ` +
        `xoá ${r.purged_rows} dòng cũ; ${Math.round(r.duration_ms / 1000)}s`,
    );
  }

  async buildSnapshot(): Promise<AgedInventoryBuildResult> {
    const startedAt = Date.now();
    const snapshotDate = vnDateKey(new Date());

    const variants = await this.fetchJewelryVariants();
    const stock = await this.fetchStock(variants);
    const receipts = await this.fetchReceipts(new Set(stock.keys()));
    const sales = await this.fetchSales(new Set(stock.keys()), snapshotDate);

    const [localVariants, locations] = await Promise.all([
      stock.size
        ? this.prisma.productVariant.findMany({
            where: {
              sapoId: { in: [...stock.keys()].map((id) => BigInt(id)) },
            },
            select: { id: true, sapoId: true, productId: true },
          })
        : Promise.resolve([]),
      this.prisma.location.findMany({
        where: { sapoId: { not: null } },
        select: { id: true, sapoId: true, name: true },
      }),
    ]);
    const localBySapoVariant = new Map(
      localVariants.map((v) => [String(v.sapoId), v]),
    );
    const locationBySapoId = new Map(
      locations.map((l) => [String(l.sapoId), l]),
    );

    const variantById = new Map(variants.map((v) => [v.sapoVariantId, v]));
    const unmatchedLocations = new Set<string>();
    const rows: Prisma.Sql[] = [];
    let units = 0;
    let aged30 = 0;

    for (const [sapoVariantId, levels] of stock) {
      const v = variantById.get(sapoVariantId)!;
      const onHand = levels.reduce((s, l) => s + l.onHand, 0);
      const lots = receipts.get(sapoVariantId) ?? [];
      const layers = fifoLayers(onHand, lots, v.createdOn);
      const oldest = layers.at(-1)!;
      const days = daysSince(oldest.since, snapshotDate);
      const lastReceived = lots.reduce<Date | null>(
        (max, r) => (!max || r.receivedOn > max ? r.receivedOn : max),
        null,
      );
      const sold30d = sales.sold.get(sapoVariantId) ?? 0;
      units += onHand;
      if (agedQty(layers, SUMMARY_MIN_DAYS, snapshotDate) > 0) aged30 += 1;

      const locationsJson = levels
        .sort((a, b) => b.onHand - a.onHand)
        .map((l) => {
          const local = locationBySapoId.get(l.sapoLocationId);
          if (!local) unmatchedLocations.add(l.sapoLocationId);
          return {
            location_id: local ? String(local.id) : null,
            sapo_location_id: l.sapoLocationId,
            location_name: local?.name ?? `Sapo #${l.sapoLocationId}`,
            on_hand: l.onHand,
            available: l.available,
          };
        });
      const layersJson = layers.map((l) => ({
        since: l.since.toISOString(),
        qty: l.qty,
        source: l.source,
      }));
      const local = localBySapoVariant.get(String(sapoVariantId));

      rows.push(
        Prisma.sql`(${snapshotDate}::date, ${BigInt(v.sapoProductId)}, ${BigInt(sapoVariantId)}, ${local?.productId ?? null}::bigint, ${local?.id ?? null}::bigint, ${v.productName}, ${v.productType}, ${v.group}, ${v.sku}, ${v.variantTitle}, ${v.size}, ${v.color}, ${v.imageUrl}, ${onHand}, ${JSON.stringify(locationsJson)}::jsonb, ${oldest.since}, ${days}, ${oldest.source}, ${lastReceived}, ${JSON.stringify(layersJson)}::jsonb, ${sold30d}, now())`,
      );
    }

    if (unmatchedLocations.size) {
      this.logger.warn(
        `Snapshot tồn lâu: kho Sapo chưa có ở local (giữ dòng, location_id = null): ${[...unmatchedLocations].join(', ')}`,
      );
    }

    const purged = await this.write(snapshotDate, rows);

    return {
      snapshot_date: snapshotDate,
      jewelry_variants: variants.length,
      variants_in_stock: stock.size,
      units_in_stock: units,
      aged_variants_30d: aged30,
      receipt_lines_used: [...receipts.values()].reduce(
        (s, l) => s + l.length,
        0,
      ),
      orders_scanned: sales.orders,
      units_sold_30d: [...sales.sold.values()].reduce((s, q) => s + q, 0),
      unmatched_locations: [...unmatchedLocations],
      purged_rows: purged,
      duration_ms: Date.now() - startedAt,
    };
  }

  /** Quét toàn catalog Sapo, giữ phiên bản thuộc nhóm trang sức có `inventory_item_id`. */
  private async fetchJewelryVariants(): Promise<JewelryVariant[]> {
    const out: JewelryVariant[] = [];
    for await (const p of this.sapo.iterateProducts()) {
      const group = productGroup(p.product_type);
      if (!isJewelryGroup(group)) continue;
      for (const v of p.variants ?? []) {
        if (v.inventory_item_id == null) continue;
        const { size, color } = pickSizeColor(p.options, v);
        out.push({
          sapoProductId: p.id,
          sapoVariantId: v.id,
          inventoryItemId: v.inventory_item_id,
          productName: p.name,
          productType: p.product_type,
          group,
          sku: v.sku?.trim() || null,
          variantTitle: variantTitle(v.title),
          // Option Sapo trước, SKU mã mới là dự phòng cho hàng không chia phiên bản.
          size: size ?? sizeFromSku(v.sku, group),
          color: color ?? colorFromSku(v.sku),
          imageUrl: pickImage(p, v),
          createdOn: new Date(v.created_on ?? p.created_on),
        });
      }
    }
    return out;
  }

  /** Tồn theo kho (chỉ dòng on_hand > 0), gom theo `sapo_variant_id`. */
  private async fetchStock(
    variants: JewelryVariant[],
  ): Promise<Map<number, LocationStock[]>> {
    const variantByItem = new Map(
      variants.map((v) => [String(v.inventoryItemId), v.sapoVariantId]),
    );
    const itemIds = [...variantByItem.keys()];
    const stock = new Map<number, LocationStock[]>();

    for (let i = 0; i < itemIds.length; i += LEVEL_BATCH) {
      const ids = itemIds.slice(i, i + LEVEL_BATCH).join(',');
      for (let page = 1; ; page++) {
        const body = await this.sapo.get<{ inventory_levels?: SapoLevelRow[] }>(
          `/admin/inventory_levels.json?inventory_item_ids=${ids}&limit=${PAGE_LIMIT}&page=${page}`,
        );
        const rows = body.inventory_levels ?? [];
        for (const row of rows) {
          const onHand = round(row.on_hand);
          if (onHand <= 0 || row.location_id == null) continue;
          const variantId = variantByItem.get(String(row.inventory_item_id));
          if (variantId === undefined) continue;
          const list = stock.get(variantId) ?? [];
          list.push({
            sapoLocationId: String(row.location_id),
            onHand,
            available: round(row.available),
          });
          stock.set(variantId, list);
        }
        await this.sapo.pace();
        if (rows.length < PAGE_LIMIT) break;
      }
    }
    return stock;
  }

  /**
   * Phiếu nhập ĐÃ NHẬN của các phiên bản đang còn hàng, gom theo `variant_id`.
   *
   * Dùng `quantity` của dòng: `remaining_quantity` KHÔNG phải số chưa nhận (đo 17/10/2026:
   * có ở 119 dòng của phiếu đã `received`), nên không trừ nó.
   */
  private async fetchReceipts(
    variantIds: Set<number>,
  ): Promise<Map<number, ReceiptLot[]>> {
    const lots = new Map<number, ReceiptLot[]>();
    for (let page = 1; ; page++) {
      const body = await this.sapo.get<{ receive_inventories?: SapoReceipt[] }>(
        `/admin/receive_inventories.json?limit=${PAGE_LIMIT}&page=${page}`,
      );
      const receipts = body.receive_inventories ?? [];
      for (const r of receipts) {
        if (r.receipt_status !== 'received' || !r.received_on || r.cancelled_on)
          continue;
        const receivedOn = new Date(r.received_on);
        for (const li of r.line_items ?? []) {
          if (li.variant_id == null || !variantIds.has(li.variant_id)) continue;
          const qty = round(li.quantity);
          if (qty <= 0) continue;
          const list = lots.get(li.variant_id) ?? [];
          list.push({ receivedOn, qty });
          lots.set(li.variant_id, list);
        }
      }
      await this.sapo.pace();
      if (receipts.length < PAGE_LIMIT) break;
    }
    return lots;
  }

  /**
   * Số bán 30 ngày tròn trước `snapshotDate` của các phiên bản đang còn hàng — xem
   * `orderSoldQty` cho quy ước đếm. Lọc theo `created_on` như cột "Bán 30 ngày" của NXT.
   */
  private async fetchSales(
    variantIds: Set<number>,
    snapshotDate: string,
  ): Promise<{ orders: number; sold: Map<number, number> }> {
    const { min, max } = salesWindow(snapshotDate, SALES_WINDOW_DAYS);
    const sold = new Map<number, number>();
    let orders = 0;
    for (let page = 1; page <= MAX_ORDER_PAGES; page++) {
      const qs = new URLSearchParams({
        limit: String(PAGE_LIMIT),
        page: String(page),
        created_on_min: min.toISOString(),
        created_on_max: max.toISOString(),
      });
      const body = await this.sapo.get<{ orders?: SapoOrderForSales[] }>(
        `/admin/orders.json?${qs.toString()}`,
      );
      const list = body.orders ?? [];
      orders += list.length;
      for (const o of list) {
        for (const [variantId, qty] of orderSoldQty(o)) {
          if (!variantIds.has(variantId)) continue;
          sold.set(variantId, (sold.get(variantId) ?? 0) + qty);
        }
      }
      await this.sapo.pace();
      if (list.length < PAGE_LIMIT) break;
      if (page === MAX_ORDER_PAGES) {
        throw new Error(
          `Đơn 30 ngày vượt ${MAX_ORDER_PAGES} trang Sapo — số bán sẽ thiếu, dừng lượt này`,
        );
      }
    }
    return { orders, sold };
  }

  /**
   * Xoá dòng của ngày rồi chèn lại trong MỘT transaction: chạy lại trong ngày là ghi đè,
   * và bên gọi API không bao giờ thấy snapshot dở dang. Sau đó dọn snapshot quá hạn giữ.
   */
  private async write(
    snapshotDate: string,
    rows: Prisma.Sql[],
  ): Promise<number> {
    await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`DELETE FROM "oms"."aged_inventory_snapshots" WHERE snapshot_date = ${snapshotDate}::date`;
        for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
          await tx.$executeRaw`
            INSERT INTO "oms"."aged_inventory_snapshots"
              (snapshot_date, sapo_product_id, sapo_variant_id, product_id, variant_id,
               product_name, product_type, product_group, sku, variant_title, size, color,
               image_url, on_hand, locations, in_stock_since, days_in_stock, age_basis,
               last_received_on, layers, sold_30d, created_at)
            VALUES ${Prisma.join(rows.slice(i, i + WRITE_CHUNK))}`;
        }
      },
      { timeout: 60000, maxWait: 10000 },
    );

    const retention =
      Number(process.env.AGED_INVENTORY_RETENTION_DAYS) ||
      DEFAULT_RETENTION_DAYS;
    return this.prisma.$executeRaw`
      DELETE FROM "oms"."aged_inventory_snapshots"
      WHERE snapshot_date < ${snapshotDate}::date - ${retention}::int`;
  }
}
