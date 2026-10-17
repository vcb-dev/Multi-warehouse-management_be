import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { locationsWithPermission } from '../../common/auth/access';
import type { AuthUser } from '../../common/decorators/current-user.decorator';
import { parseList } from '../../common/query/filter-params';
import { PrismaService } from '../../prisma/prisma.service';
import { agedQty, normalizeGroup } from './aged-inventory.calc';
import { ListAgedInventoryQueryDto } from './aged-inventory.dto';

const DEFAULT_MIN_DAYS = 30;
const DEFAULT_PAGE_SIZE = 100;

type SnapshotLocation = {
  location_id: string | null;
  sapo_location_id: string;
  location_name: string;
  on_hand: number;
  available: number;
};

type SnapshotLayer = { since: string; qty: number; source: string };

type SnapshotRow = {
  sapo_product_id: bigint;
  sapo_variant_id: bigint;
  product_id: bigint | null;
  variant_id: bigint | null;
  product_name: string;
  product_group: string;
  sku: string | null;
  variant_title: string | null;
  size: string | null;
  color: string | null;
  image_url: string | null;
  on_hand: number;
  locations: SnapshotLocation[];
  in_stock_since: Date;
  days_in_stock: number;
  age_basis: string;
  last_received_on: Date | null;
  layers: SnapshotLayer[];
  sold_30d: number;
};

const str = (v: bigint | null) => (v === null ? null : String(v));

@Injectable()
export class AgedInventoryQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ListAgedInventoryQueryDto, user: AuthUser) {
    const minDays = query.min_days ?? DEFAULT_MIN_DAYS;
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? DEFAULT_PAGE_SIZE;

    const snapshot = await this.resolveSnapshot(query.snapshot_date);
    if (!snapshot) {
      return {
        snapshot_date: null,
        generated_at: null,
        min_days: minDays,
        total: 0,
        page,
        page_size: pageSize,
        data: [],
      };
    }

    // undefined = admin, thấy mọi kho. Lọc theo kho CÓ QUYỀN đọc tồn, như màn Tồn kho.
    const allowed = locationsWithPermission(user, 'inventory:view')?.map(
      String,
    );
    const conds: Prisma.Sql[] = [
      Prisma.sql`s.snapshot_date = ${snapshot.date}::date`,
      Prisma.sql`s.days_in_stock >= ${minDays}`,
    ];
    if (query.location_id) {
      conds.push(
        Prisma.sql`EXISTS (SELECT 1 FROM jsonb_array_elements(s.locations) e WHERE e->>'location_id' = ${query.location_id})`,
      );
    }
    if (allowed) {
      conds.push(
        Prisma.sql`EXISTS (SELECT 1 FROM jsonb_array_elements(s.locations) e WHERE e->>'location_id' = ANY(${allowed}::text[]))`,
      );
    }
    const groups = parseList(query.product_group)?.map(normalizeGroup);
    if (groups)
      conds.push(Prisma.sql`s.product_group = ANY(${groups}::text[])`);
    const q = query.q?.trim();
    if (q) {
      const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      conds.push(
        Prisma.sql`(s.sku ILIKE ${pattern} OR s.product_name ILIKE ${pattern})`,
      );
    }
    const where = Prisma.join(conds, ' AND ');

    const [countRows, rows] = await Promise.all([
      this.prisma.$queryRaw<{ total: number }[]>`
        SELECT count(*)::int AS total FROM "oms"."aged_inventory_snapshots" s WHERE ${where}`,
      this.prisma.$queryRaw<SnapshotRow[]>`
        SELECT s.sapo_product_id, s.sapo_variant_id, s.product_id, s.variant_id,
               s.product_name, s.product_group, s.sku, s.variant_title, s.size, s.color,
               s.image_url, s.on_hand, s.locations, s.in_stock_since, s.days_in_stock,
               s.age_basis, s.last_received_on, s.layers, s.sold_30d
        FROM "oms"."aged_inventory_snapshots" s
        WHERE ${where}
        ORDER BY s.days_in_stock DESC, s.sku ASC NULLS LAST, s.id ASC
        LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
    ]);

    const allowedSet = allowed ? new Set(allowed) : null;
    return {
      snapshot_date: snapshot.date,
      generated_at: snapshot.generatedAt,
      min_days: minDays,
      total: countRows[0]?.total ?? 0,
      page,
      page_size: pageSize,
      data: rows.map((r) =>
        this.serialize(r, snapshot.date, minDays, allowedSet),
      ),
    };
  }

  /** Snapshot được hỏi, hoặc snapshot mới nhất; null khi chưa từng chạy / ngày không có. */
  private async resolveSnapshot(
    date?: string,
  ): Promise<{ date: string; generatedAt: Date } | null> {
    const rows = date
      ? await this.prisma.$queryRaw<{ date: string; generated_at: Date }[]>`
          SELECT snapshot_date::text AS date, max(created_at) AS generated_at
          FROM "oms"."aged_inventory_snapshots"
          WHERE snapshot_date = ${date}::date
          GROUP BY snapshot_date`
      : await this.prisma.$queryRaw<{ date: string; generated_at: Date }[]>`
          SELECT snapshot_date::text AS date, max(created_at) AS generated_at
          FROM "oms"."aged_inventory_snapshots"
          WHERE snapshot_date = (SELECT max(snapshot_date) FROM "oms"."aged_inventory_snapshots")
          GROUP BY snapshot_date`;
    return rows[0]
      ? { date: rows[0].date, generatedAt: rows[0].generated_at }
      : null;
  }

  private serialize(
    r: SnapshotRow,
    snapshotDate: string,
    minDays: number,
    allowed: Set<string> | null,
  ) {
    // User không phải admin chỉ thấy các kho mình có quyền; số tồn cộng lại theo đó.
    const locations = allowed
      ? r.locations.filter((l) => l.location_id && allowed.has(l.location_id))
      : r.locations;
    const onHand = allowed
      ? locations.reduce((s, l) => s + l.on_hand, 0)
      : r.on_hand;
    const aged = agedQty(
      r.layers.map((l) => ({ since: new Date(l.since), qty: l.qty })),
      minDays,
      snapshotDate,
    );

    return {
      sku: r.sku,
      product_name: r.product_name,
      variant_title: r.variant_title,
      size: r.size,
      color: r.color,
      image_url: r.image_url,
      product_group: r.product_group,
      on_hand: onHand,
      aged_qty: Math.min(aged, onHand),
      sold_30d: r.sold_30d,
      days_in_stock: r.days_in_stock,
      in_stock_since: r.in_stock_since,
      age_basis: r.age_basis,
      last_received_on: r.last_received_on,
      locations: locations.map((l) => ({
        location_id: l.location_id,
        location_name: l.location_name,
        on_hand: l.on_hand,
        available: l.available,
      })),
      product_id: str(r.product_id),
      variant_id: str(r.variant_id),
      sapo_product_id: String(r.sapo_product_id),
      sapo_variant_id: String(r.sapo_variant_id),
    };
  }
}
