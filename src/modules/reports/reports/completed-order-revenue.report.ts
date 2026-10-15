import { Prisma } from '@prisma/client';
import {
  ReportColumn,
  ReportContext,
  ReportDef,
  ReportResult,
  ReportRow,
} from '../report.types';
import { EFFECTIVE_QTY, UNIT_COST, num } from './report-sql';

/**
 * Doanh thu đơn đã hoàn thành, chi tiết tới từng dòng hàng kèm giá vốn.
 *
 * Khác các báo cáo doanh thu khác ở hai điểm:
 * - Chỉ lấy đơn `status = closed` ("Hoàn thành" trên giao diện), không phải mọi đơn chưa huỷ.
 * - Lọc thời gian theo NGÀY HOÀN THÀNH (`completed_on`, thiếu thì `closed_on`), không theo
 *   ngày tạo — đơn tạo tháng trước, hoàn thành tháng này thì tính vào tháng này.
 *
 * Mỗi dòng là một sản phẩm trên đơn nên số dòng lớn ⇒ phân trang ngay trong SQL, dòng tổng
 * tính bằng một query gộp riêng.
 */

const COMPLETED_AT = Prisma.sql`COALESCE(o."completed_on", o."closed_on")`;

function scopeSql(ctx: ReportContext): Prisma.Sql {
  const conditions: Prisma.Sql[] = [
    Prisma.sql`o."status" = 'closed'`,
    Prisma.sql`${COMPLETED_AT} >= ${ctx.from}`,
    Prisma.sql`${COMPLETED_AT} < ${ctx.to}`,
    Prisma.sql`o."location_id" IN (${Prisma.join(ctx.locationIds)})`,
  ];
  if (ctx.channel) {
    conditions.push(Prisma.sql`o."source_name" = ${ctx.channel}`);
  }
  return Prisma.join(conditions, ' AND ');
}

const COLUMNS: ReportColumn[] = [
  { key: 'label', label: 'Mã đơn', type: 'text' },
  { key: 'completed_on', label: 'Ngày hoàn thành', type: 'date' },
  { key: 'location', label: 'Chi nhánh', type: 'text' },
  { key: 'customer', label: 'Khách hàng', type: 'text' },
  { key: 'product', label: 'Sản phẩm', type: 'text' },
  { key: 'sku', label: 'SKU', type: 'text' },
  { key: 'quantity', label: 'Số lượng', type: 'number', summable: true },
  { key: 'price', label: 'Đơn giá', type: 'money' },
  { key: 'total_discount', label: 'Giảm giá', type: 'money', summable: true },
  { key: 'revenue', label: 'Doanh thu', type: 'money', summable: true },
  { key: 'unit_cost', label: 'Giá vốn', type: 'money' },
  { key: 'cost', label: 'Tổng giá vốn', type: 'money', summable: true },
  { key: 'profit', label: 'Lãi gộp', type: 'money', summable: true },
];

type RawRow = {
  order_name: string;
  completed_on: string | null;
  location: string | null;
  customer: string | null;
  product: string;
  sku: string;
  quantity: bigint | number;
  price: Prisma.Decimal | null;
  total_discount: Prisma.Decimal | null;
  revenue: Prisma.Decimal | null;
  unit_cost: Prisma.Decimal | null;
  total: bigint | number;
};

type RawSummary = {
  quantity: bigint | number | null;
  total_discount: Prisma.Decimal | null;
  revenue: Prisma.Decimal | null;
  cost: Prisma.Decimal | null;
};

/** Công thức một dòng — xuất để unit test đối chiếu. */
export function toCompletedOrderLineRow(r: RawRow): ReportRow {
  const quantity = Number(r.quantity);
  const revenue = num(r.revenue);
  const unitCost = num(r.unit_cost);
  const cost = unitCost * quantity;
  return {
    label: r.order_name,
    completed_on: r.completed_on ?? '',
    location: r.location ?? '(Không xác định)',
    customer: r.customer ?? '(Khách lẻ)',
    product: r.product,
    sku: r.sku,
    quantity,
    price: num(r.price),
    total_discount: num(r.total_discount),
    revenue,
    unit_cost: unitCost,
    cost,
    profit: revenue - cost,
  };
}

async function run(ctx: ReportContext): Promise<ReportResult> {
  const scope = scopeSql(ctx);
  const paging = ctx.all
    ? Prisma.empty
    : Prisma.sql`LIMIT ${ctx.pageSize} OFFSET ${(ctx.page - 1) * ctx.pageSize}`;

  const [rows, [sum]] = await Promise.all([
    ctx.prisma.$queryRaw<RawRow[]>`
      SELECT o."name"                                   AS order_name,
             TO_CHAR(${COMPLETED_AT} AT TIME ZONE 'Asia/Ho_Chi_Minh', 'DD/MM/YYYY HH24:MI')
                                                        AS completed_on,
             l."name"                                   AS location,
             NULLIF(TRIM(CONCAT_WS(' ', c."first_name", c."last_name")), '') AS customer,
             oi."name"                                  AS product,
             oi."sku"                                   AS sku,
             ${EFFECTIVE_QTY}                           AS quantity,
             oi."price"                                 AS price,
             oi."total_discount"                        AS total_discount,
             oi."discounted_total"                      AS revenue,
             ${UNIT_COST}                               AS unit_cost,
             COUNT(*) OVER ()                           AS total
      FROM "oms"."order_items" oi
      JOIN "oms"."orders" o                ON o."id" = oi."order_id"
      LEFT JOIN "oms"."product_variants" v ON v."id" = oi."variant_id"
      LEFT JOIN "oms"."locations" l        ON l."id" = o."location_id"
      LEFT JOIN "oms"."customers" c        ON c."id" = o."customer_id"
      WHERE ${scope}
      ORDER BY ${COMPLETED_AT} DESC, o."id" DESC, oi."id"
      ${paging}
    `,
    ctx.prisma.$queryRaw<RawSummary[]>`
      SELECT SUM(${EFFECTIVE_QTY})                AS quantity,
             SUM(oi."total_discount")             AS total_discount,
             SUM(oi."discounted_total")           AS revenue,
             SUM(${UNIT_COST} * ${EFFECTIVE_QTY}) AS cost
      FROM "oms"."order_items" oi
      JOIN "oms"."orders" o                ON o."id" = oi."order_id"
      LEFT JOIN "oms"."product_variants" v ON v."id" = oi."variant_id"
      WHERE ${scope}
    `,
  ]);

  const revenue = num(sum?.revenue);
  const cost = num(sum?.cost);
  return {
    rows: rows.map(toCompletedOrderLineRow),
    summary: {
      label: 'Tổng cộng',
      quantity: Number(sum?.quantity ?? 0),
      total_discount: num(sum?.total_discount),
      revenue,
      cost,
      profit: revenue - cost,
    },
    total: rows.length ? Number(rows[0].total) : 0,
  };
}

export const COMPLETED_ORDER_REVENUE_REPORTS: ReportDef[] = [
  {
    id: 'sales-revenue-completed-orders',
    group: 'ban_hang',
    name: 'Doanh thu đơn hoàn thành',
    description:
      'Từng sản phẩm trên các đơn đã hoàn thành, kèm giá vốn và lãi gộp. Lọc theo ngày hoàn thành đơn.',
    filters: ['date_range', 'location', 'channel'],
    columns: COLUMNS,
    note: 'Khoảng thời gian tính theo ngày hoàn thành đơn, không theo ngày tạo. Doanh thu là tiền dòng hàng sau giảm giá dòng; giảm giá cấp đơn và phí vận chuyển không phân bổ xuống từng sản phẩm. Giá vốn ưu tiên giá chốt lúc bán, thiếu thì dùng giá vốn hiện tại của sản phẩm.',
    run,
  },
];
