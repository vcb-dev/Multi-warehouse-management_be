import { Prisma } from '@prisma/client';
import {
  ReportColumn,
  ReportContext,
  ReportDef,
  ReportResult,
  ReportRow,
} from '../report.types';
import { orderScopeSql, bucketExpr, num } from './report-sql';

/**
 * Báo cáo "Doanh thu cửa hàng" của Sapo — 7 chiều phân tích dùng CHUNG một query, chỉ khác
 * biểu thức gom nhóm. Sapo tách "kênh bán hàng" và "nguồn đơn hàng" thành 2 báo cáo, app này
 * chỉ có `orders.source_name` nên gộp làm một.
 */

type Dimension =
  | 'time'
  | 'location'
  | 'channel'
  | 'staff'
  | 'variant'
  | 'customer'
  | 'tax';

/** Cột đo lường giống bộ chỉ số Sapo hiển thị ở báo cáo doanh thu. */
const METRIC_COLUMNS: ReportColumn[] = [
  { key: 'order_count', label: 'Số đơn', type: 'number', summable: true },
  { key: 'sub_total_price', label: 'Tiền hàng', type: 'money', summable: true },
  { key: 'total_discounts', label: 'Giảm giá', type: 'money', summable: true },
  { key: 'total_tax', label: 'Thuế', type: 'money', summable: true },
  {
    key: 'total_shipping_price',
    label: 'Phí vận chuyển',
    type: 'money',
    summable: true,
  },
  { key: 'total_price', label: 'Doanh thu', type: 'money', summable: true },
  { key: 'total_refunded', label: 'Hoàn tiền', type: 'money', summable: true },
  {
    key: 'net_revenue',
    label: 'Doanh thu thuần',
    type: 'money',
    summable: true,
  },
  { key: 'total_received', label: 'Đã thu', type: 'money', summable: true },
  { key: 'outstanding', label: 'Còn phải thu', type: 'money', summable: true },
];

/**
 * Chiều gom nhóm: cột nhãn hiển thị + biểu thức SQL. Chiều `variant` phải join sang
 * order_items nên xử lý riêng ở `runByVariant`.
 */
const DIMENSIONS: Record<
  Exclude<Dimension, 'variant'>,
  { column: ReportColumn; groupSql: (ctx: ReportContext) => Prisma.Sql }
> = {
  time: {
    column: { key: 'label', label: 'Thời gian', type: 'text' },
    groupSql: (ctx) => bucketExpr(ctx.bucket),
  },
  location: {
    column: { key: 'label', label: 'Chi nhánh', type: 'text' },
    groupSql: () => Prisma.sql`COALESCE(l."name", '(Không xác định)')`,
  },
  channel: {
    column: { key: 'label', label: 'Kênh bán', type: 'text' },
    groupSql: () =>
      Prisma.sql`COALESCE(NULLIF(o."source_name", ''), '(Không rõ nguồn)')`,
  },
  staff: {
    column: { key: 'label', label: 'Nhân viên', type: 'text' },
    groupSql: () =>
      Prisma.sql`COALESCE(NULLIF(TRIM(CONCAT_WS(' ', u."first_name", u."last_name")), ''), '(Chưa gán)')`,
  },
  customer: {
    column: { key: 'label', label: 'Khách hàng', type: 'text' },
    groupSql: () =>
      Prisma.sql`COALESCE(NULLIF(TRIM(CONCAT_WS(' ', c."first_name", c."last_name")), ''), '(Khách lẻ)')`,
  },
  tax: {
    column: { key: 'label', label: 'Mức thuế', type: 'text' },
    // Đơn không có dòng thuế chi tiết — gom theo có/không chịu thuế
    groupSql: () =>
      Prisma.sql`CASE WHEN o."total_tax" > 0 THEN 'Có thuế' ELSE 'Không thuế' END`,
  },
};

type RawRow = {
  label: string | null;
  order_count: bigint | number;
  sub_total_price: Prisma.Decimal | null;
  total_discounts: Prisma.Decimal | null;
  total_tax: Prisma.Decimal | null;
  total_shipping_price: Prisma.Decimal | null;
  total_price: Prisma.Decimal | null;
  total_refunded: Prisma.Decimal | null;
  total_received: Prisma.Decimal | null;
};

function toRow(r: RawRow): ReportRow {
  const totalPrice = num(r.total_price);
  const refunded = num(r.total_refunded);
  const received = num(r.total_received);
  return {
    label: r.label ?? '(Không xác định)',
    order_count: Number(r.order_count),
    sub_total_price: num(r.sub_total_price),
    total_discounts: num(r.total_discounts),
    total_tax: num(r.total_tax),
    total_shipping_price: num(r.total_shipping_price),
    total_price: totalPrice,
    total_refunded: refunded,
    // Đơn huỷ đã thu tiền ở Sapo KHÔNG tự sinh refund, nên doanh thu thuần phải trừ tay
    net_revenue: totalPrice - refunded,
    total_received: received,
    outstanding: totalPrice - received,
  };
}

function sumRows(rows: ReportRow[]): ReportRow {
  const summary: ReportRow = { label: 'Tổng cộng' };
  for (const col of METRIC_COLUMNS) {
    summary[col.key] = rows.reduce((s, r) => s + Number(r[col.key] ?? 0), 0);
  }
  return summary;
}

/** Gom theo một chiều ở cấp ĐƠN (không join dòng hàng). */
async function runByOrderDimension(
  dim: Exclude<Dimension, 'variant'>,
  ctx: ReportContext,
): Promise<ReportResult> {
  const group = DIMENSIONS[dim].groupSql(ctx);
  const scope = orderScopeSql(ctx);

  const rows = await ctx.prisma.$queryRaw<RawRow[]>`
    SELECT ${group} AS label,
           COUNT(*)                            AS order_count,
           SUM(o."sub_total_price")            AS sub_total_price,
           SUM(o."total_discounts")            AS total_discounts,
           SUM(o."total_tax")                  AS total_tax,
           SUM(o."total_shipping_price")       AS total_shipping_price,
           SUM(o."total_price")                AS total_price,
           SUM(COALESCE(o."total_refunded",0)) AS total_refunded,
           SUM(o."total_received")             AS total_received
    FROM "orders" o
    LEFT JOIN "locations" l ON l."id" = o."location_id"
    LEFT JOIN "users" u     ON u."id" = o."assignee_id"
    LEFT JOIN "customers" c ON c."id" = o."customer_id"
    WHERE ${scope}
    GROUP BY 1
    ORDER BY 1
  `;

  // Gom nhóm xong thường chỉ vài chục dòng nên phân trang trong bộ nhớ, tránh phải chạy
  // thêm một query COUNT(DISTINCT ...) chỉ để biết tổng số nhóm.
  const all = rows.map(toRow);
  const summary = sumRows(all);
  const paged = ctx.all
    ? all
    : all.slice((ctx.page - 1) * ctx.pageSize, ctx.page * ctx.pageSize);
  return { rows: paged, summary, total: all.length };
}

/** Doanh thu theo sản phẩm — phải xuống cấp dòng hàng. */
async function runByVariant(ctx: ReportContext): Promise<ReportResult> {
  const scope = orderScopeSql(ctx);

  const rows = await ctx.prisma.$queryRaw<
    (RawRow & { quantity: bigint | number; sku: string })[]
  >`
    SELECT oi."name"                          AS label,
           oi."sku"                           AS sku,
           -- Sapo tính số lượng từ current_quantity (đã trừ dòng huỷ/hoàn), không phải quantity
           SUM(COALESCE(oi."current_quantity", oi."quantity"))          AS quantity,
           COUNT(DISTINCT o."id")                                       AS order_count,
           SUM(oi."price" * COALESCE(oi."current_quantity", oi."quantity")) AS sub_total_price,
           SUM(oi."total_discount")                                     AS total_discounts,
           0::numeric                                                   AS total_tax,
           0::numeric                                                   AS total_shipping_price,
           SUM(oi."discounted_total")                                   AS total_price,
           0::numeric                                                   AS total_refunded,
           0::numeric                                                   AS total_received
    FROM "order_items" oi
    JOIN "orders" o ON o."id" = oi."order_id"
    LEFT JOIN "locations" l ON l."id" = o."location_id"
    LEFT JOIN "users" u     ON u."id" = o."assignee_id"
    LEFT JOIN "customers" c ON c."id" = o."customer_id"
    WHERE ${scope}
    GROUP BY oi."name", oi."sku"
    ORDER BY SUM(oi."discounted_total") DESC
  `;

  const all = rows.map((r) => ({
    ...toRow(r),
    sku: r.sku,
    quantity: Number(r.quantity),
  }));
  const summary = sumRows(all);
  summary.quantity = all.reduce((s, r) => s + Number(r.quantity ?? 0), 0);
  summary.sku = '';
  const paged = ctx.all
    ? all
    : all.slice((ctx.page - 1) * ctx.pageSize, ctx.page * ctx.pageSize);
  return { rows: paged, summary, total: all.length };
}

function def(
  id: string,
  name: string,
  description: string,
  dim: Dimension,
  extra: Partial<ReportDef> = {},
): ReportDef {
  const isVariant = dim === 'variant';
  const labelColumn: ReportColumn = isVariant
    ? { key: 'label', label: 'Sản phẩm', type: 'text' }
    : DIMENSIONS[dim].column;

  return {
    id,
    group: 'ban_hang',
    name,
    description,
    filters: [
      'date_range',
      'location',
      'channel',
      ...(dim === 'time' ? ['bucket' as const] : []),
    ],
    columns: isVariant
      ? [
          labelColumn,
          { key: 'sku', label: 'SKU', type: 'text' },
          {
            key: 'quantity',
            label: 'Số lượng',
            type: 'number',
            summable: true,
          },
          ...METRIC_COLUMNS.filter(
            (c) =>
              ![
                'total_tax',
                'total_shipping_price',
                'total_refunded',
                'net_revenue',
                'total_received',
                'outstanding',
              ].includes(c.key),
          ),
        ]
      : [labelColumn, ...METRIC_COLUMNS],
    run: (ctx) =>
      isVariant ? runByVariant(ctx) : runByOrderDimension(dim, ctx),
    ...extra,
  };
}

export const SALES_REVENUE_REPORTS: ReportDef[] = [
  def(
    'sales-revenue-by-time',
    'Doanh thu theo thời gian',
    'Doanh thu, giảm giá, thuế và công nợ theo ngày/tuần/tháng.',
    'time',
    { chart: { type: 'line', x: 'label', y: ['total_price', 'net_revenue'] } },
  ),
  def(
    'sales-revenue-by-location',
    'Doanh thu theo chi nhánh',
    'So sánh hiệu quả bán hàng giữa các chi nhánh/kho.',
    'location',
    { chart: { type: 'bar', x: 'label', y: ['total_price'] } },
  ),
  def(
    'sales-revenue-by-channel',
    'Doanh thu theo kênh bán',
    'Doanh thu theo nguồn đơn: facebook, shopee, tiktokshop, POS...',
    'channel',
    { chart: { type: 'bar', x: 'label', y: ['total_price'] } },
  ),
  def(
    'sales-revenue-by-staff',
    'Doanh thu theo nhân viên',
    'Doanh thu theo nhân viên phụ trách đơn.',
    'staff',
    { chart: { type: 'bar', x: 'label', y: ['total_price'] } },
  ),
  def(
    'sales-revenue-by-product',
    'Doanh thu theo sản phẩm',
    'Sản phẩm bán chạy theo số lượng và doanh thu.',
    'variant',
    { chart: { type: 'bar', x: 'label', y: ['total_price'] } },
  ),
  def(
    'sales-revenue-by-customer',
    'Doanh thu theo khách hàng',
    'Khách hàng chi tiêu nhiều nhất trong kỳ.',
    'customer',
  ),
  def(
    'sales-revenue-by-tax',
    'Doanh thu theo thuế',
    'Tách doanh thu đơn có thuế và không thuế.',
    'tax',
  ),
];
