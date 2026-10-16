import { Injectable, Logger } from '@nestjs/common';
import { ChannelConnection, OrderSource } from '@prisma/client';
import { BusinessException } from '../../../common/exceptions/business.exception';
import { PrismaService } from '../../../prisma/prisma.service';
import { ShopeeAuthService } from './shopee-auth.service';
import {
  ShopeeClient,
  ShopeeItemBase,
  ShopeeSellerStock,
  ShopeeStockUpdate,
} from './shopee.client';

const ITEM_PAGE = 100;
const BASE_INFO_BATCH = 50;
const STOCK_LIST_MAX = 50;
const CHANGE_CAP = 100;

export type ShopeeInventorySyncOpts = {
  dryRun?: boolean;
  sku?: string;
};

export type ShopeeInventoryChange = {
  sku: string;
  item_id: number;
  model_id: number;
  oms_available: number;
  shopee_stock: number;
  action: 'update' | 'skip_same' | 'fail';
  error?: string;
};

export type ShopeeInventorySyncResult = {
  shop_id: string;
  shop_name: string | null;
  location_id: string;
  dry_run: boolean;
  listed: number;
  matched: number;
  updated: number;
  skipped_same: number;
  unmatched: number;
  failed: number;
  unmatched_skus: string[];
  changes: ShopeeInventoryChange[];
};

type CatalogRow = {
  sku: string;
  itemId: number;
  modelId: number;
  sellerStock: ShopeeSellerStock[];
};

/**
 * Đẩy tồn OMS → Shopee: `available` của **kho gắn shop**, không cộng kho khác.
 * Khớp `ProductVariant.sku` ↔ `model_sku` (có biến thể) hoặc `item_sku` (không biến thể).
 */
@Injectable()
export class ShopeeInventorySyncService {
  private readonly logger = new Logger(ShopeeInventorySyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly shopeeAuth: ShopeeAuthService,
  ) {}

  async syncInventory(
    connectionId?: string,
    opts: ShopeeInventorySyncOpts = {},
  ): Promise<ShopeeInventorySyncResult[]> {
    const client = this.shopeeAuth.getClient();
    const connections = await this.loadConnections(connectionId);
    const results: ShopeeInventorySyncResult[] = [];
    for (const conn of connections) {
      results.push(await this.syncConnection(client, conn, opts));
    }
    return results;
  }

  private async syncConnection(
    client: ShopeeClient,
    conn: ChannelConnection,
    opts: ShopeeInventorySyncOpts,
  ): Promise<ShopeeInventorySyncResult> {
    const locationId = await this.resolveLocationId(conn);
    const fresh = await this.shopeeAuth.ensureFreshConnection(conn.id);
    const skuFilter = opts.sku?.trim();

    const catalog = await this.loadCatalog(
      client,
      fresh.accessToken,
      fresh.shopId,
    );
    const listed = catalog.length;
    const rows = skuFilter
      ? catalog.filter((r) => r.sku === skuFilter)
      : catalog;

    const skuSet = [...new Set(rows.map((r) => r.sku))];
    const variants = skuSet.length
      ? await this.prisma.productVariant.findMany({
          where: { sku: { in: skuSet } },
          select: { id: true, sku: true },
        })
      : [];
    const variantBySku = new Map(variants.map((v) => [v.sku, v]));

    const levels = variants.length
      ? await this.prisma.inventoryLevel.findMany({
          where: {
            locationId,
            variantId: { in: variants.map((v) => v.id) },
          },
          select: { variantId: true, available: true },
        })
      : [];
    const availableByVariant = new Map(
      levels.map((l) => [l.variantId.toString(), l.available]),
    );

    const unmatchedSkus = new Set<string>();
    const pending: Array<{
      row: CatalogRow;
      oms: number;
      shopee: number;
      sellerStock: ReturnType<typeof toSellerStock>;
    }> = [];
    let skippedSame = 0;

    for (const row of rows) {
      const variant = variantBySku.get(row.sku);
      if (!variant) {
        unmatchedSkus.add(row.sku);
        continue;
      }
      const oms = clampStock(
        availableByVariant.get(variant.id.toString()) ?? 0,
      );
      const sellerStock = toSellerStock(row.sellerStock, oms);
      const shopee = currentSellerStock(row.sellerStock);
      if (shopee === oms) {
        skippedSame += 1;
        continue;
      }
      pending.push({ row, oms, shopee, sellerStock });
    }

    const changes: ShopeeInventoryChange[] = [];
    let updated = 0;
    let failed = 0;

    if (opts.dryRun) {
      updated = pending.length;
      for (const p of pending.slice(0, CHANGE_CAP)) {
        changes.push({
          sku: p.row.sku,
          item_id: p.row.itemId,
          model_id: p.row.modelId,
          oms_available: p.oms,
          shopee_stock: p.shopee,
          action: 'update',
        });
      }
    } else {
      const grouped = groupByItem(pending);
      for (const [itemId, group] of grouped) {
        for (let i = 0; i < group.length; i += STOCK_LIST_MAX) {
          const chunk = group.slice(i, i + STOCK_LIST_MAX);
          const stockList: ShopeeStockUpdate[] = chunk.map((p) => ({
            model_id: p.row.modelId,
            seller_stock: p.sellerStock,
          }));
          try {
            const res = await client.updateStock(
              fresh.accessToken,
              fresh.shopId,
              itemId,
              stockList,
            );
            const failedIds = new Set(
              (res.failure_list ?? [])
                .map((f) => f.model_id)
                .filter((id): id is number => id != null),
            );
            const failReason = new Map(
              (res.failure_list ?? []).map((f) => [
                f.model_id ?? -1,
                f.failed_reason ?? 'update_stock thất bại',
              ]),
            );
            for (const p of chunk) {
              const isFail = failedIds.has(p.row.modelId);
              if (isFail) failed += 1;
              else updated += 1;
              if (changes.length < CHANGE_CAP) {
                changes.push({
                  sku: p.row.sku,
                  item_id: p.row.itemId,
                  model_id: p.row.modelId,
                  oms_available: p.oms,
                  shopee_stock: p.shopee,
                  action: isFail ? 'fail' : 'update',
                  error: isFail ? failReason.get(p.row.modelId) : undefined,
                });
              }
            }
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            failed += chunk.length;
            for (const p of chunk) {
              if (changes.length < CHANGE_CAP) {
                changes.push({
                  sku: p.row.sku,
                  item_id: p.row.itemId,
                  model_id: p.row.modelId,
                  oms_available: p.oms,
                  shopee_stock: p.shopee,
                  action: 'fail',
                  error: msg,
                });
              }
            }
          }
        }
      }
    }

    const result: ShopeeInventorySyncResult = {
      shop_id: fresh.shopId,
      shop_name: fresh.shopName,
      location_id: locationId.toString(),
      dry_run: !!opts.dryRun,
      listed,
      matched: rows.filter((r) => variantBySku.has(r.sku)).length,
      updated,
      skipped_same: skippedSame,
      unmatched: unmatchedSkus.size,
      failed,
      unmatched_skus: [...unmatchedSkus].slice(0, CHANGE_CAP),
      changes,
    };

    this.logger.log(
      `Shopee tồn shop ${fresh.shopId}${opts.dryRun ? ' (dry-run)' : ''}: ` +
        `listed=${listed} matched=${result.matched} updated=${updated} ` +
        `same=${skippedSame} unmatched=${unmatchedSkus.size} failed=${failed}`,
    );
    return result;
  }

  private async loadCatalog(
    client: ShopeeClient,
    accessToken: string,
    shopId: string,
  ): Promise<CatalogRow[]> {
    const itemIds: number[] = [];
    let offset = 0;
    for (;;) {
      const page = await client.getItemList(accessToken, shopId, {
        offset,
        pageSize: ITEM_PAGE,
        itemStatus: 'NORMAL',
      });
      const items = page.item ?? [];
      for (const it of items) {
        if (it.item_id) itemIds.push(it.item_id);
      }
      if (!page.has_next_page || items.length === 0) break;
      const next = page.next_offset ?? offset + items.length;
      if (next === offset) break;
      offset = next;
    }

    const rows: CatalogRow[] = [];
    for (let i = 0; i < itemIds.length; i += BASE_INFO_BATCH) {
      const batch = itemIds.slice(i, i + BASE_INFO_BATCH);
      const base = await client.getItemBaseInfo(accessToken, shopId, batch);
      for (const item of base.item_list ?? []) {
        rows.push(
          ...(await this.rowsForItem(client, accessToken, shopId, item)),
        );
      }
    }
    return rows;
  }

  private async rowsForItem(
    client: ShopeeClient,
    accessToken: string,
    shopId: string,
    item: ShopeeItemBase,
  ): Promise<CatalogRow[]> {
    if (!item.has_model) {
      const sku = (item.item_sku ?? '').trim();
      if (!sku) return [];
      return [
        {
          sku,
          itemId: item.item_id,
          modelId: 0,
          sellerStock: item.stock_info_v2?.seller_stock ?? [],
        },
      ];
    }

    const models = await client.getModelList(accessToken, shopId, item.item_id);
    const rows: CatalogRow[] = [];
    for (const model of models.model ?? []) {
      const sku = (model.model_sku ?? '').trim();
      if (!sku) continue;
      if (model.model_status && model.model_status !== 'MODEL_NORMAL') continue;
      rows.push({
        sku,
        itemId: item.item_id,
        modelId: model.model_id,
        sellerStock: model.stock_info_v2?.seller_stock ?? [],
      });
    }
    return rows;
  }

  private async loadConnections(connectionId?: string) {
    if (connectionId) {
      const conn = await this.prisma.channelConnection.findFirst({
        where: { id: BigInt(connectionId), channel: OrderSource.shopee },
      });
      if (!conn) {
        throw new BusinessException(
          'CHANNEL_NOT_CONFIGURED',
          'Không tìm thấy kết nối Shopee',
          404,
        );
      }
      return [conn];
    }
    return this.prisma.channelConnection.findMany({
      where: { channel: OrderSource.shopee },
    });
  }

  private async resolveLocationId(conn: ChannelConnection): Promise<bigint> {
    if (conn.locationId) return conn.locationId;

    const fromEnv = process.env.SHOPEE_DEFAULT_LOCATION_ID?.trim();
    if (fromEnv) return BigInt(fromEnv);

    const defaultLoc = await this.prisma.location.findFirst({
      where: { defaultLocation: true, status: 'active' },
      orderBy: { id: 'asc' },
    });
    if (defaultLoc) return defaultLoc.id;

    throw new BusinessException(
      'CHANNEL_NOT_CONFIGURED',
      `Shop Shopee ${conn.shopId}: chưa gán kho (channel_connections.location_id hoặc SHOPEE_DEFAULT_LOCATION_ID)`,
      422,
    );
  }
}

function clampStock(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

/** Shop 1 kho: không gửi location_id. Shop nhiều kho Shopee: ghi kho đầu, giữ nguyên kho còn lại. */
export function toSellerStock(
  existing: ShopeeSellerStock[] | undefined,
  oms: number,
): Array<{ stock: number; location_id?: string }> {
  const locs = (existing ?? []).filter((e) => (e.location_id ?? '').trim());
  if (!locs.length) return [{ stock: oms }];
  return locs.map((e, i) => ({
    location_id: (e.location_id ?? '').trim(),
    stock: i === 0 ? oms : clampStock(e.stock ?? 0),
  }));
}

export function currentSellerStock(
  existing: ShopeeSellerStock[] | undefined,
): number {
  const rows = existing ?? [];
  const locs = rows.filter((e) => (e.location_id ?? '').trim());
  const pick = locs.length ? locs[0] : rows[0];
  return clampStock(pick?.stock ?? 0);
}

function groupByItem<T extends { row: CatalogRow }>(pending: T[]) {
  const map = new Map<number, T[]>();
  for (const p of pending) {
    const list = map.get(p.row.itemId) ?? [];
    list.push(p);
    map.set(p.row.itemId, list);
  }
  return map;
}
