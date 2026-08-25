import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { BusinessException } from '../../../common/exceptions/business.exception';
import { SapoClient } from '../../products/sapo-sync/sapo-client';

/**
 * Đồng bộ lại `inventory_levels` (tồn theo từng kho) từ số liệu sống trên Sapo.
 *
 * Port từ `scripts/sync-sapo-inventory-levels.js` để chạy được theo cron thay vì phải nhớ
 * gõ tay. Giữ nguyên ba quyết định gốc của script:
 *
 * 1. **Sapo là nguồn chân lý, ghi đè toàn bộ bucket** (on_hand, committed, packed,
 *    unavailable, incoming, incoming_owned, incoming_not_owned, reserved). Riêng `available`
 *    tính lại theo công thức nội bộ `on_hand - committed - packed - unavailable` chứ KHÔNG
 *    lấy available thô của Sapo — để giữ đúng bất biến mà `reconcile.service.ts` đang kiểm.
 *
 * 2. **Mọi thay đổi đều sinh bút toán bù** (`reference_type = 'sapo_resync'`, type `adjust`)
 *    cho 5 bucket có sổ cái. Bỏ bước này là tái tạo đúng lỗ hổng "on_hand ≠ Σ movements" mà
 *    `backfill-opening-balance.js` từng phải vá một lần rồi.
 *
 * 3. **Chỉ đụng phiên bản có `inventory_item_id`** (khoá gọi API này) và kho có `sapo_id`.
 *    Dòng Sapo không trả về thì GIỮ NGUYÊN, không xoá — Sapo không trả không có nghĩa là hết
 *    hàng, có thể chỉ là phiên bản đó không còn quản tồn bên đó.
 *
 * Khác script: không ghi file JSON vào `scripts-tmp/` (cron chạy trong container, file đó
 * không ai đọc) — số lượng không khớp trả về trong kết quả và ghi log. Cũng bỏ bước tự kiểm
 * lại từng dòng sau khi ghi: đó là N truy vấn cho mỗi dòng lệch, mà `ReconcileScheduler` đã
 * làm đúng việc kiểm bất biến đó theo lịch riêng.
 */

/** Số `inventory_item_id` hỏi mỗi lượt — an toàn dưới trần 250 bản ghi/trang kể cả nhiều kho. */
const BATCH_SIZE = 40;
const PAGE_LIMIT = 250;
/** Số dòng mỗi câu ghi. 1000 × 11 tham số vẫn xa trần 32.767 bind của Postgres. */
const WRITE_CHUNK = 1000;
const REFERENCE_TYPE = 'sapo_resync';

const LEDGER_BUCKETS = [
  'onHand',
  'committed',
  'packed',
  'unavailable',
  'incoming',
] as const;
type LedgerBucket = (typeof LEDGER_BUCKETS)[number];

const BUCKET_NAME: Record<
  LedgerBucket,
  Prisma.InventoryMovementCreateManyInput['bucket']
> = {
  onHand: 'on_hand',
  committed: 'committed',
  packed: 'packed',
  unavailable: 'unavailable',
  incoming: 'incoming',
};

type SapoInventoryLevel = {
  inventory_item_id?: number | string | null;
  location_id?: number | string | null;
  on_hand?: number | null;
  committed?: number | null;
  packed?: number | null;
  unavailable?: number | null;
  incoming?: number | null;
  incoming_owned?: number | null;
  incoming_not_owned?: number | null;
  reserved?: number | null;
};

type LevelValues = {
  onHand: number;
  available: number;
  committed: number;
  incoming: number;
  incomingOwned: number;
  incomingNotOwned: number;
  packed: number;
  reserved: number;
  unavailable: number;
};

export interface SapoInventorySyncResult {
  scanned: number;
  updated: number;
  created: number;
  already_correct: number;
  movements: number;
  unmatched_items: number;
  unmatched_locations: number;
  local_only: number;
  variants_without_item_id: number;
}

const round = (v: unknown) => Math.round(Number(v ?? 0));

@Injectable()
export class SapoInventorySyncService {
  private readonly logger = new Logger(SapoInventorySyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sapo: SapoClient,
  ) {}

  isConfigured(): boolean {
    return this.sapo.isConfigured();
  }

  async syncInventoryLevels(): Promise<SapoInventorySyncResult> {
    if (!this.sapo.isConfigured()) {
      throw new BusinessException(
        'CHANNEL_NOT_CONFIGURED',
        'Thiếu SAPO_STORE/SAPO_API_KEY/SAPO_API_SECRET trong cấu hình server',
        500,
      );
    }

    const [locations, variants, variantsWithoutItemId, existingLevels] =
      await Promise.all([
        this.prisma.location.findMany({
          where: { sapoId: { not: null } },
          select: { id: true, sapoId: true },
        }),
        this.prisma.productVariant.findMany({
          where: { inventoryItemId: { not: null } },
          select: { id: true, inventoryItemId: true },
        }),
        this.prisma.productVariant.count({ where: { inventoryItemId: null } }),
        this.prisma.inventoryLevel.findMany(),
      ]);

    const locBySapoId = new Map(locations.map((l) => [String(l.sapoId), l.id]));
    const variantByItemId = new Map(
      variants.map((v) => [String(v.inventoryItemId), v.id]),
    );
    const existingByKey = new Map(
      existingLevels.map((l) => [`${l.variantId}:${l.locationId}`, l]),
    );

    const result: SapoInventorySyncResult = {
      scanned: 0,
      updated: 0,
      created: 0,
      already_correct: 0,
      movements: 0,
      unmatched_items: 0,
      unmatched_locations: 0,
      local_only: 0,
      variants_without_item_id: variantsWithoutItemId,
    };

    const upsertRows: (LevelValues & {
      variantId: bigint;
      locationId: bigint;
      isNew: boolean;
    })[] = [];
    const movementRows: Prisma.InventoryMovementCreateManyInput[] = [];
    const seenKeys = new Set<string>();
    const unmatchedItems = new Set<string>();
    const unmatchedLocations = new Set<string>();

    const itemIds = [...variantByItemId.keys()];
    for (let i = 0; i < itemIds.length; i += BATCH_SIZE) {
      const ids = itemIds.slice(i, i + BATCH_SIZE);
      for (let page = 1; ; page++) {
        const body = await this.sapo.get<{
          inventory_levels?: SapoInventoryLevel[];
        }>(
          `/admin/inventory_levels.json?inventory_item_ids=${ids.join(',')}&limit=${PAGE_LIMIT}&page=${page}`,
        );
        const rows = body.inventory_levels ?? [];

        for (const row of rows) {
          const variantId = variantByItemId.get(String(row.inventory_item_id));
          if (!variantId) {
            unmatchedItems.add(String(row.inventory_item_id));
            continue;
          }
          const locationId = locBySapoId.get(String(row.location_id));
          if (!locationId) {
            unmatchedLocations.add(String(row.location_id));
            continue;
          }

          const key = `${variantId}:${locationId}`;
          seenKeys.add(key);

          const after = this.toLevelValues(row);
          const before = existingByKey.get(key);
          const beforeVals: LevelValues = before
            ? {
                onHand: before.onHand,
                available: before.available,
                committed: before.committed,
                incoming: before.incoming,
                incomingOwned: before.incomingOwned,
                incomingNotOwned: before.incomingNotOwned,
                packed: before.packed,
                reserved: before.reserved,
                unavailable: before.unavailable,
              }
            : {
                onHand: 0,
                available: 0,
                committed: 0,
                incoming: 0,
                incomingOwned: 0,
                incomingNotOwned: 0,
                packed: 0,
                reserved: 0,
                unavailable: 0,
              };

          const changed = (Object.keys(after) as (keyof LevelValues)[]).some(
            (k) => after[k] !== beforeVals[k],
          );
          if (!changed) {
            result.already_correct += 1;
            continue;
          }

          upsertRows.push({
            variantId,
            locationId,
            isNew: !before,
            ...after,
          });
          if (!before) result.created += 1;
          else result.updated += 1;

          for (const bucket of LEDGER_BUCKETS) {
            const diff = after[bucket] - beforeVals[bucket];
            if (diff === 0) continue;
            movementRows.push({
              variantId,
              locationId,
              bucket: BUCKET_NAME[bucket],
              change: diff,
              type: 'adjust',
              referenceType: REFERENCE_TYPE,
              // Không có người thao tác: đây là máy kéo số từ Sapo về, gán bừa một user
              // sẽ làm sổ hoạt động đổ lỗi cho người không làm gì.
              createdById: null,
            });
          }
        }

        await this.throttle();
        if (rows.length < PAGE_LIMIT) break;
      }
    }

    result.scanned = seenKeys.size;
    result.movements = movementRows.length;
    result.unmatched_items = unmatchedItems.size;
    result.unmatched_locations = unmatchedLocations.size;
    result.local_only = [...existingByKey.keys()].filter(
      (k) => !seenKeys.has(k),
    ).length;

    await this.write(upsertRows, movementRows);
    return result;
  }

  private toLevelValues(row: SapoInventoryLevel): LevelValues {
    const onHand = round(row.on_hand);
    const committed = round(row.committed);
    const packed = round(row.packed);
    const unavailable = round(row.unavailable);
    return {
      onHand,
      committed,
      packed,
      unavailable,
      incoming: round(row.incoming),
      incomingOwned: round(row.incoming_owned),
      incomingNotOwned: round(row.incoming_not_owned),
      reserved: round(row.reserved),
      // Công thức nội bộ, KHÔNG lấy `available` của Sapo — xem chú thích đầu file.
      available: onHand - committed - packed - unavailable,
    };
  }

  /** Giãn nhịp theo `x-sapo-api-call-limit` để không ăn 429 giữa lượt quét dài. */
  private async throttle() {
    const header = this.sapo.lastRateLimit;
    if (!header) return new Promise((r) => setTimeout(r, 250));
    const [used, total] = header.split('/').map(Number);
    const ratio = total ? used / total : 0;
    const delay = ratio > 0.75 ? 1200 : ratio > 0.5 ? 500 : 250;
    return new Promise((r) => setTimeout(r, delay));
  }

  /**
   * Ghi bằng SQL thô, tách INSERT (dòng mới) và UPDATE ... FROM VALUES (dòng đã có).
   *
   * Không dùng `upsert` của Prisma: đó là một round-trip cho MỖI dòng — lượt resync đụng
   * hàng chục nghìn dòng sẽ chạy hàng giờ. Cũng không dùng `ON CONFLICT`: xem
   * `scripts/sync-sapo-inventory-levels.js`, DB thật từng lệch với schema về ràng buộc trên
   * (variant_id, location_id) nên cách tách hai câu này chạy đúng ở cả hai trạng thái.
   */
  private async write(
    upsertRows: (LevelValues & {
      variantId: bigint;
      locationId: bigint;
      isNew: boolean;
    })[],
    movementRows: Prisma.InventoryMovementCreateManyInput[],
  ) {
    const inserts = upsertRows.filter((r) => r.isNew);
    const updates = upsertRows.filter((r) => !r.isNew);

    for (let i = 0; i < inserts.length; i += WRITE_CHUNK) {
      const values = inserts
        .slice(i, i + WRITE_CHUNK)
        .map(
          (r) =>
            Prisma.sql`(${r.variantId}::bigint, ${r.locationId}::bigint, ${r.onHand}, ${r.available}, ${r.committed}, ${r.incoming}, ${r.incomingOwned}, ${r.incomingNotOwned}, ${r.packed}, ${r.reserved}, ${r.unavailable}, now(), now())`,
        );
      await this.prisma.$executeRaw`
        INSERT INTO inventory_levels
          (variant_id, location_id, on_hand, available, committed, incoming, incoming_owned, incoming_not_owned, packed, reserved, unavailable, created_at, updated_at)
        VALUES ${Prisma.join(values)}`;
    }

    for (let i = 0; i < updates.length; i += WRITE_CHUNK) {
      const values = updates
        .slice(i, i + WRITE_CHUNK)
        .map(
          (r) =>
            Prisma.sql`(${r.variantId}::bigint, ${r.locationId}::bigint, ${r.onHand}, ${r.available}, ${r.committed}, ${r.incoming}, ${r.incomingOwned}, ${r.incomingNotOwned}, ${r.packed}, ${r.reserved}, ${r.unavailable})`,
        );
      await this.prisma.$executeRaw`
        UPDATE inventory_levels AS t SET
          on_hand = v.on_hand,
          available = v.available,
          committed = v.committed,
          incoming = v.incoming,
          incoming_owned = v.incoming_owned,
          incoming_not_owned = v.incoming_not_owned,
          packed = v.packed,
          reserved = v.reserved,
          unavailable = v.unavailable,
          updated_at = now()
        FROM (VALUES ${Prisma.join(values)}) AS v(variant_id, location_id, on_hand, available, committed, incoming, incoming_owned, incoming_not_owned, packed, reserved, unavailable)
        WHERE t.variant_id = v.variant_id AND t.location_id = v.location_id`;
    }

    for (let i = 0; i < movementRows.length; i += WRITE_CHUNK) {
      await this.prisma.inventoryMovement.createMany({
        data: movementRows.slice(i, i + WRITE_CHUNK),
      });
    }
  }
}
