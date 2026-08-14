import { Prisma } from '@prisma/client';
import {
  ReportContext,
  ReportDef,
  ReportResult,
  ReportRow,
} from '../report.types';
import { num } from './report-sql';

/**
 * Báo cáo Kho của Sapo: "Tồn kho" (ảnh chụp hiện tại + giá trị) và "Sổ kho" (nhập/xuất/tồn
 * trong kỳ).
 *
 * Cả hai chỉ đọc `inventory_levels`/`inventory_movements`, không đụng `orders` nên KHÔNG
 * dùng `orderScopeSql`.
 */

// --- Tồn kho ---

type StockRaw = {
  label: string;
  sku: string;
  location_name: string | null;
  on_hand: number;
  available: number;
  committed: number;
  packed: number;
  incoming: number;
  cost: Prisma.Decimal | null;
};

async function runStock(ctx: ReportContext): Promise<ReportResult> {
  const rows = await ctx.prisma.$queryRaw<StockRaw[]>`
    SELECT p."name"                     AS label,
           v."sku"                      AS sku,
           l."name"                     AS location_name,
           il."on_hand"                 AS on_hand,
           il."available"               AS available,
           il."committed"               AS committed,
           il."packed"                  AS packed,
           il."incoming"                AS incoming,
           COALESCE(NULLIF(il."cost", 0), v."cost", 0) AS cost
    FROM "inventory_levels" il
    JOIN "product_variants" v ON v."id" = il."variant_id"
    JOIN "products" p         ON p."id" = v."product_id"
    JOIN "locations" l        ON l."id" = il."location_id"
    WHERE il."location_id" IN (${Prisma.join(ctx.locationIds)})
      AND (il."on_hand" <> 0 OR il."committed" <> 0 OR il."incoming" <> 0)
    ORDER BY p."name", v."sku"
  `;

  const all: ReportRow[] = rows.map((r) => {
    const cost = num(r.cost);
    return {
      label: r.label,
      sku: r.sku,
      location_name: r.location_name ?? '',
      on_hand: r.on_hand,
      available: r.available,
      committed: r.committed,
      packed: r.packed,
      incoming: r.incoming,
      cost,
      stock_value: cost * r.on_hand,
    };
  });

  const summary: ReportRow = {
    label: 'Tổng cộng',
    sku: '',
    location_name: '',
    cost: 0,
  };
  for (const k of [
    'on_hand',
    'available',
    'committed',
    'packed',
    'incoming',
    'stock_value',
  ]) {
    summary[k] = all.reduce((s, r) => s + Number(r[k] ?? 0), 0);
  }

  const paged = ctx.all
    ? all
    : all.slice((ctx.page - 1) * ctx.pageSize, ctx.page * ctx.pageSize);
  return { rows: paged, summary, total: all.length };
}

// --- Sổ kho ---

type LedgerRaw = {
  label: string;
  sku: string;
  location_name: string | null;
  opening: bigint | number;
  qty_in: bigint | number;
  qty_out: bigint | number;
};

/**
 * Nhập/xuất trong kỳ và tồn đầu kỳ, tính hoàn toàn từ ledger `inventory_movements` trên
 * bucket `on_hand` — cùng nguồn sự thật với `InventoryNxtService`. Tồn cuối = đầu + nhập −
 * xuất, nên nếu lệch với `inventory_levels.on_hand` là ledger có vấn đề (scripts/audit-flows.js
 * kiểm bất biến này).
 */
async function runLedger(ctx: ReportContext): Promise<ReportResult> {
  const rows = await ctx.prisma.$queryRaw<LedgerRaw[]>`
    SELECT p."name" AS label,
           v."sku"  AS sku,
           l."name" AS location_name,
           COALESCE(SUM(m."change") FILTER (WHERE m."created_at" < ${ctx.from}), 0) AS opening,
           COALESCE(SUM(m."change") FILTER (
             WHERE m."created_at" >= ${ctx.from} AND m."created_at" < ${ctx.to} AND m."change" > 0
           ), 0) AS qty_in,
           COALESCE(-SUM(m."change") FILTER (
             WHERE m."created_at" >= ${ctx.from} AND m."created_at" < ${ctx.to} AND m."change" < 0
           ), 0) AS qty_out
    FROM "inventory_movements" m
    JOIN "product_variants" v ON v."id" = m."variant_id"
    JOIN "products" p         ON p."id" = v."product_id"
    JOIN "locations" l        ON l."id" = m."location_id"
    WHERE m."bucket" = 'on_hand'::"InventoryBucket"
      AND m."location_id" IN (${Prisma.join(ctx.locationIds)})
      AND m."created_at" < ${ctx.to}
    GROUP BY p."name", v."sku", l."name"
    HAVING COALESCE(SUM(m."change") FILTER (
             WHERE m."created_at" >= ${ctx.from} AND m."created_at" < ${ctx.to}
           ), 0) <> 0
        OR COALESCE(SUM(m."change") FILTER (WHERE m."created_at" < ${ctx.from}), 0) <> 0
    ORDER BY p."name", v."sku"
  `;

  const all: ReportRow[] = rows.map((r) => {
    const opening = Number(r.opening);
    const qtyIn = Number(r.qty_in);
    const qtyOut = Number(r.qty_out);
    return {
      label: r.label,
      sku: r.sku,
      location_name: r.location_name ?? '',
      opening,
      qty_in: qtyIn,
      qty_out: qtyOut,
      closing: opening + qtyIn - qtyOut,
    };
  });

  const summary: ReportRow = { label: 'Tổng cộng', sku: '', location_name: '' };
  for (const k of ['opening', 'qty_in', 'qty_out', 'closing']) {
    summary[k] = all.reduce((s, r) => s + Number(r[k] ?? 0), 0);
  }

  const paged = ctx.all
    ? all
    : all.slice((ctx.page - 1) * ctx.pageSize, ctx.page * ctx.pageSize);
  return { rows: paged, summary, total: all.length };
}

export const INVENTORY_REPORTS: ReportDef[] = [
  {
    id: 'inventory-stock',
    group: 'kho',
    name: 'Tồn kho',
    description: 'Số lượng và giá trị tồn hiện tại theo từng kho.',
    // Tồn kho là ảnh chụp hiện tại, không có khoảng thời gian
    filters: ['location'],
    columns: [
      { key: 'label', label: 'Sản phẩm', type: 'text' },
      { key: 'sku', label: 'SKU', type: 'text' },
      { key: 'location_name', label: 'Kho', type: 'text' },
      { key: 'on_hand', label: 'Tồn thực tế', type: 'number', summable: true },
      { key: 'available', label: 'Có thể bán', type: 'number', summable: true },
      { key: 'committed', label: 'Đang giữ', type: 'number', summable: true },
      { key: 'packed', label: 'Đã đóng gói', type: 'number', summable: true },
      {
        key: 'incoming',
        label: 'Hàng đang về',
        type: 'number',
        summable: true,
      },
      { key: 'cost', label: 'Giá vốn', type: 'money' },
      {
        key: 'stock_value',
        label: 'Giá trị tồn',
        type: 'money',
        summable: true,
      },
    ],
    run: runStock,
  },
  {
    id: 'inventory-ledger',
    group: 'kho',
    name: 'Sổ kho',
    description: 'Tồn đầu kỳ, nhập, xuất và tồn cuối kỳ theo từng sản phẩm.',
    filters: ['date_range', 'location'],
    columns: [
      { key: 'label', label: 'Sản phẩm', type: 'text' },
      { key: 'sku', label: 'SKU', type: 'text' },
      { key: 'location_name', label: 'Kho', type: 'text' },
      { key: 'opening', label: 'Tồn đầu kỳ', type: 'number', summable: true },
      { key: 'qty_in', label: 'Nhập trong kỳ', type: 'number', summable: true },
      {
        key: 'qty_out',
        label: 'Xuất trong kỳ',
        type: 'number',
        summable: true,
      },
      { key: 'closing', label: 'Tồn cuối kỳ', type: 'number', summable: true },
    ],
    run: runLedger,
  },
];
