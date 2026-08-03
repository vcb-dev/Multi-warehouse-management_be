import { Prisma } from '@prisma/client';
import {
  ReportContext,
  ReportDef,
  ReportResult,
  ReportRow,
} from '../report.types';
import {
  EFFECTIVE_QTY,
  UNIT_COST,
  bucketExpr,
  num,
  orderScopeSql,
} from './report-sql';

/**
 * Báo cáo lợi nhuận. Lãi gộp = doanh thu dòng hàng − giá vốn dòng hàng; tính ở cấp
 * `order_items` chứ không phải cấp đơn, vì giá vốn chỉ có ở dòng hàng.
 *
 * Lưu ý: phí vận chuyển và giảm giá cấp đơn KHÔNG được phân bổ xuống dòng hàng, nên đây là
 * lãi gộp theo hàng hoá, không phải lợi nhuận cuối cùng của đơn.
 */

const COST_NOTE =
  'Đơn tạo trước 30/07/2026 chưa có giá vốn chốt tại thời điểm bán nên dùng giá vốn hiện tại của sản phẩm — lợi nhuận các kỳ đó có thể thay đổi khi giá vốn được cập nhật.';

type RawRow = {
  label: string | null;
  sku?: string | null;
  quantity: bigint | number;
  revenue: Prisma.Decimal | null;
  cost: Prisma.Decimal | null;
};

function toRow(r: RawRow): ReportRow {
  const revenue = num(r.revenue);
  const cost = num(r.cost);
  const profit = revenue - cost;
  return {
    label: r.label ?? '(Không xác định)',
    ...(r.sku !== undefined ? { sku: r.sku ?? '' } : {}),
    quantity: Number(r.quantity),
    revenue,
    cost,
    profit,
    // Biên lãi gộp — không cộng dồn được, phải tính lại từ tổng ở dòng Tổng cộng
    margin: revenue > 0 ? Math.round((profit / revenue) * 1000) / 10 : 0,
  };
}

function summarize(rows: ReportRow[], withSku: boolean): ReportRow {
  const quantity = rows.reduce((s, r) => s + Number(r.quantity ?? 0), 0);
  const revenue = rows.reduce((s, r) => s + Number(r.revenue ?? 0), 0);
  const cost = rows.reduce((s, r) => s + Number(r.cost ?? 0), 0);
  const profit = revenue - cost;
  return {
    label: 'Tổng cộng',
    ...(withSku ? { sku: '' } : {}),
    quantity,
    revenue,
    cost,
    profit,
    margin: revenue > 0 ? Math.round((profit / revenue) * 1000) / 10 : 0,
  };
}

async function runProfit(
  ctx: ReportContext,
  groupBy: 'time' | 'variant',
): Promise<ReportResult> {
  const scope = orderScopeSql(ctx);
  const label =
    groupBy === 'time' ? bucketExpr(ctx.bucket) : Prisma.sql`oi."name"`;
  const skuSelect =
    groupBy === 'variant' ? Prisma.sql`oi."sku" AS sku,` : Prisma.empty;
  const groupSql =
    groupBy === 'time'
      ? Prisma.sql`GROUP BY 1`
      : Prisma.sql`GROUP BY oi."name", oi."sku"`;
  const orderSql =
    groupBy === 'time'
      ? Prisma.sql`ORDER BY MIN(o."created_on")`
      : Prisma.sql`ORDER BY SUM(oi."discounted_total") - SUM(${UNIT_COST} * ${EFFECTIVE_QTY}) DESC`;

  const rows = await ctx.prisma.$queryRaw<RawRow[]>`
    SELECT ${label} AS label,
           ${skuSelect}
           SUM(${EFFECTIVE_QTY})                        AS quantity,
           SUM(oi."discounted_total")                   AS revenue,
           SUM(${UNIT_COST} * ${EFFECTIVE_QTY})         AS cost
    FROM "order_items" oi
    JOIN "orders" o           ON o."id" = oi."order_id"
    LEFT JOIN "product_variants" v ON v."id" = oi."variant_id"
    WHERE ${scope}
    ${groupSql}
    ${orderSql}
  `;

  const withSku = groupBy === 'variant';
  const all = rows.map(toRow);
  const summary = summarize(all, withSku);
  const paged = ctx.all
    ? all
    : all.slice((ctx.page - 1) * ctx.pageSize, ctx.page * ctx.pageSize);
  return { rows: paged, summary, total: all.length };
}

const METRIC_COLUMNS = [
  {
    key: 'quantity',
    label: 'Số lượng bán',
    type: 'number' as const,
    summable: true,
  },
  {
    key: 'revenue',
    label: 'Doanh thu',
    type: 'money' as const,
    summable: true,
  },
  { key: 'cost', label: 'Giá vốn', type: 'money' as const, summable: true },
  { key: 'profit', label: 'Lãi gộp', type: 'money' as const, summable: true },
  { key: 'margin', label: 'Biên lãi gộp', type: 'percent' as const },
];

export const PROFIT_REPORTS: ReportDef[] = [
  {
    id: 'loi-nhuan-tong-hop',
    group: 'loi_nhuan',
    name: 'Lợi nhuận tổng hợp',
    description: 'Doanh thu, giá vốn và lãi gộp theo ngày/tuần/tháng.',
    filters: ['date_range', 'location', 'channel', 'bucket'],
    note: COST_NOTE,
    columns: [
      { key: 'label', label: 'Thời gian', type: 'text' },
      ...METRIC_COLUMNS,
    ],
    chart: { type: 'line', x: 'label', y: ['revenue', 'profit'] },
    run: (ctx) => runProfit(ctx, 'time'),
  },
  {
    id: 'loi-nhuan-theo-san-pham',
    group: 'loi_nhuan',
    name: 'Lợi nhuận theo sản phẩm',
    description: 'Sản phẩm nào thực sự sinh lãi, xếp theo lãi gộp.',
    filters: ['date_range', 'location', 'channel'],
    note: COST_NOTE,
    columns: [
      { key: 'label', label: 'Sản phẩm', type: 'text' },
      { key: 'sku', label: 'SKU', type: 'text' },
      ...METRIC_COLUMNS,
    ],
    chart: { type: 'bar', x: 'label', y: ['profit'] },
    run: (ctx) => runProfit(ctx, 'variant'),
  },
];
