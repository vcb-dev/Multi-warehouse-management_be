import { Prisma } from '@prisma/client';
import {
  ReportColumn,
  ReportContext,
  ReportDef,
  ReportResult,
  ReportRow,
} from '../report.types';
import { orderScopeSql, num } from './report-sql';

/**
 * Báo cáo "Khách hàng" (Đợt 2 theo `report-registry.ts`) — nhóm khách theo các chiều nhân
 * khẩu học/hành vi mua, dùng chung khung đo (số khách, số đơn, doanh thu) như báo cáo
 * doanh thu. Riêng "mua lại theo SĐT" trả về danh sách chi tiết vì mục đích là tra cứu
 * từng số điện thoại, không phải xem phân bố.
 */

const METRIC_COLUMNS: ReportColumn[] = [
  { key: 'customer_count', label: 'Customers', type: 'number', summable: true },
  { key: 'order_count', label: 'Orders', type: 'number', summable: true },
  { key: 'total_spent', label: 'Revenue', type: 'money', summable: true },
  { key: 'avg_order_value', label: 'Avg. order value', type: 'money' },
];

type LabelRow = {
  label: string;
  customer_count: bigint | number;
  order_count: bigint | number;
  total_spent: Prisma.Decimal | number | null;
};

function toLabelRow(r: LabelRow): ReportRow {
  const orderCount = Number(r.order_count);
  const totalSpent = num(r.total_spent);
  return {
    label: r.label,
    customer_count: Number(r.customer_count),
    order_count: orderCount,
    total_spent: totalSpent,
    avg_order_value: orderCount > 0 ? Math.round(totalSpent / orderCount) : 0,
  };
}

function summarizeLabelRows(rows: ReportRow[]): ReportRow {
  const orderCount = rows.reduce((s, r) => s + Number(r.order_count ?? 0), 0);
  const totalSpent = rows.reduce((s, r) => s + Number(r.total_spent ?? 0), 0);
  return {
    label: 'Total',
    customer_count: rows.reduce((s, r) => s + Number(r.customer_count ?? 0), 0),
    order_count: orderCount,
    total_spent: totalSpent,
    avg_order_value: orderCount > 0 ? Math.round(totalSpent / orderCount) : 0,
  };
}

/** Gom nhóm xong chỉ còn vài chục dòng (số nhóm tuổi/vùng/...) nên phân trang trong bộ nhớ. */
function paginateLabelRows(rows: ReportRow[], ctx: ReportContext): ReportResult {
  const summary = summarizeLabelRows(rows);
  const paged = ctx.all
    ? rows
    : rows.slice((ctx.page - 1) * ctx.pageSize, ctx.page * ctx.pageSize);
  return { rows: paged, summary, total: rows.length };
}

/** Giới tính — chuỗi tự do kiểu Sapo (male/female/other), quy về 4 nhãn cố định. */
async function runByGender(ctx: ReportContext): Promise<ReportResult> {
  const scope = orderScopeSql(ctx);
  const rows = await ctx.prisma.$queryRaw<LabelRow[]>`
    SELECT
      CASE LOWER(COALESCE(c."gender", ''))
        WHEN 'male' THEN 'Male'
        WHEN 'female' THEN 'Female'
        WHEN 'other' THEN 'Other'
        ELSE 'Unknown'
      END AS label,
      COUNT(DISTINCT o."customer_id") AS customer_count,
      COUNT(*)                        AS order_count,
      SUM(o."total_price")            AS total_spent
    FROM "orders" o
    LEFT JOIN "customers" c ON c."id" = o."customer_id"
    WHERE ${scope}
    GROUP BY 1
    ORDER BY 3 DESC
  `;
  return paginateLabelRows(rows.map(toLabelRow), ctx);
}

/**
 * Vùng — dùng tỉnh/thành GIAO HÀNG của từng đơn (`shipping_province`), không phải địa chỉ
 * mặc định trên hồ sơ khách: một khách có thể nhận hàng ở nhiều nơi khác nhau giữa các đơn.
 */
async function runByRegion(ctx: ReportContext): Promise<ReportResult> {
  const scope = orderScopeSql(ctx);
  const rows = await ctx.prisma.$queryRaw<LabelRow[]>`
    SELECT
      COALESCE(
        NULLIF(o."shipping_province", ''),
        NULLIF(o."billing_province", ''),
        '(Unknown)'
      ) AS label,
      COUNT(DISTINCT o."customer_id") AS customer_count,
      COUNT(*)                        AS order_count,
      SUM(o."total_price")            AS total_spent
    FROM "orders" o
    WHERE ${scope}
    GROUP BY 1
    ORDER BY 3 DESC
  `;
  return paginateLabelRows(rows.map(toLabelRow), ctx);
}

/** Độ tuổi tính từ `customers.dob` tại thời điểm hiện tại (không phải lúc đặt hàng). */
async function runByAge(ctx: ReportContext): Promise<ReportResult> {
  const scope = orderScopeSql(ctx);
  const rows = await ctx.prisma.$queryRaw<LabelRow[]>`
    SELECT label,
           COUNT(DISTINCT customer_id) AS customer_count,
           COUNT(*)                    AS order_count,
           SUM(total_price)            AS total_spent
    FROM (
      SELECT
        CASE
          WHEN c."dob" IS NULL THEN 6
          WHEN AGE(c."dob") < INTERVAL '18 years' THEN 0
          WHEN AGE(c."dob") < INTERVAL '25 years' THEN 1
          WHEN AGE(c."dob") < INTERVAL '35 years' THEN 2
          WHEN AGE(c."dob") < INTERVAL '45 years' THEN 3
          WHEN AGE(c."dob") < INTERVAL '55 years' THEN 4
          ELSE 5
        END AS sort_order,
        CASE
          WHEN c."dob" IS NULL THEN 'Unknown'
          WHEN AGE(c."dob") < INTERVAL '18 years' THEN 'Under 18'
          WHEN AGE(c."dob") < INTERVAL '25 years' THEN '18 - 24'
          WHEN AGE(c."dob") < INTERVAL '35 years' THEN '25 - 34'
          WHEN AGE(c."dob") < INTERVAL '45 years' THEN '35 - 44'
          WHEN AGE(c."dob") < INTERVAL '55 years' THEN '45 - 54'
          ELSE '55+'
        END AS label,
        o."customer_id" AS customer_id,
        o."total_price" AS total_price
      FROM "orders" o
      LEFT JOIN "customers" c ON c."id" = o."customer_id"
      WHERE ${scope}
    ) t
    GROUP BY sort_order, label
    ORDER BY sort_order
  `;
  return paginateLabelRows(rows.map(toLabelRow), ctx);
}

/** Mức chi tiêu — bucket theo TỔNG chi tiêu của từng khách trong kỳ, không phải từng đơn. */
async function runBySpending(ctx: ReportContext): Promise<ReportResult> {
  const scope = orderScopeSql(ctx);
  const rows = await ctx.prisma.$queryRaw<LabelRow[]>`
    WITH customer_totals AS (
      SELECT o."customer_id" AS customer_id,
             COUNT(*)             AS order_count,
             SUM(o."total_price") AS total_spent
      FROM "orders" o
      WHERE ${scope} AND o."customer_id" IS NOT NULL
      GROUP BY o."customer_id"
    )
    SELECT label,
           COUNT(*)         AS customer_count,
           SUM(order_count) AS order_count,
           SUM(total_spent) AS total_spent
    FROM (
      SELECT
        CASE
          WHEN total_spent < 500000    THEN 0
          WHEN total_spent < 2000000   THEN 1
          WHEN total_spent < 5000000   THEN 2
          WHEN total_spent < 20000000  THEN 3
          ELSE 4
        END AS sort_order,
        CASE
          WHEN total_spent < 500000    THEN 'Under 500K'
          WHEN total_spent < 2000000   THEN '500K - 2M'
          WHEN total_spent < 5000000   THEN '2M - 5M'
          WHEN total_spent < 20000000  THEN '5M - 20M'
          ELSE 'Over 20M'
        END AS label,
        order_count,
        total_spent
      FROM customer_totals
    ) t
    GROUP BY sort_order, label
    ORDER BY sort_order
  `;
  return paginateLabelRows(rows.map(toLabelRow), ctx);
}

/**
 * Loại sản phẩm (`products.product_type`) — xuống cấp dòng hàng nên một khách mua nhiều
 * loại sẽ được đếm ở từng loại tương ứng, không dồn về một dòng duy nhất.
 */
async function runByProductType(ctx: ReportContext): Promise<ReportResult> {
  const scope = orderScopeSql(ctx);
  const rows = await ctx.prisma.$queryRaw<LabelRow[]>`
    SELECT
      COALESCE(NULLIF(p."product_type", ''), '(Uncategorized)') AS label,
      COUNT(DISTINCT o."customer_id")   AS customer_count,
      COUNT(DISTINCT o."id")            AS order_count,
      SUM(oi."discounted_total")        AS total_spent
    FROM "order_items" oi
    JOIN "orders" o ON o."id" = oi."order_id"
    LEFT JOIN "product_variants" v ON v."id" = oi."variant_id"
    LEFT JOIN "products" p         ON p."id" = v."product_id"
    WHERE ${scope}
    GROUP BY 1
    ORDER BY 4 DESC
  `;
  return paginateLabelRows(rows.map(toLabelRow), ctx);
}

const PHONE_COLUMNS: ReportColumn[] = [
  { key: 'label', label: 'Phone', type: 'text' },
  { key: 'customer_name', label: 'Customer', type: 'text' },
  { key: 'order_count', label: 'Orders', type: 'number', summable: true },
  { key: 'total_spent', label: 'Total spent', type: 'money', summable: true },
  { key: 'first_order_on', label: 'First order', type: 'date' },
  { key: 'last_order_on', label: 'Last order', type: 'date' },
  { key: 'status', label: 'Status', type: 'text' },
  {
    key: 'customer_profile_count',
    label: 'Duplicate customer profiles',
    type: 'number',
  },
];

type PhoneRow = {
  label: string;
  customer_name: string | null;
  order_count: bigint | number;
  customer_profile_count: bigint | number;
  total_spent: Prisma.Decimal | number | null;
  first_order_on: Date;
  last_order_on: Date;
};

/**
 * Mua lại theo SĐT — gom theo SĐT (ưu tiên SĐT trên hồ sơ khách, fallback SĐT ghi trên đơn)
 * thay vì theo `customer_id`, vì Sapo có thể tạo nhiều hồ sơ khách khác nhau cho cùng một
 * người khi đơn không tự khớp được khách (`customer_profile_count` > 1 lộ ra trường hợp này).
 */
async function runByPhoneRepeat(ctx: ReportContext): Promise<ReportResult> {
  const scope = orderScopeSql(ctx);
  const rows = await ctx.prisma.$queryRaw<PhoneRow[]>`
    SELECT
      COALESCE(NULLIF(c."phone", ''), NULLIF(o."phone", '')) AS label,
      MAX(COALESCE(
        NULLIF(TRIM(CONCAT_WS(' ', c."first_name", c."last_name")), ''),
        o."shipping_name"
      )) AS customer_name,
      COUNT(*)                        AS order_count,
      COUNT(DISTINCT o."customer_id") AS customer_profile_count,
      SUM(o."total_price")            AS total_spent,
      MIN(o."created_on")             AS first_order_on,
      MAX(o."created_on")             AS last_order_on
    FROM "orders" o
    LEFT JOIN "customers" c ON c."id" = o."customer_id"
    WHERE ${scope}
      AND COALESCE(NULLIF(c."phone", ''), NULLIF(o."phone", '')) IS NOT NULL
    GROUP BY 1
    ORDER BY order_count DESC, total_spent DESC
  `;

  const all: ReportRow[] = rows.map((r) => {
    const orderCount = Number(r.order_count);
    return {
      label: r.label,
      customer_name: r.customer_name ?? '(Unknown name)',
      order_count: orderCount,
      customer_profile_count: Number(r.customer_profile_count),
      total_spent: num(r.total_spent),
      first_order_on: r.first_order_on.toISOString().slice(0, 10),
      last_order_on: r.last_order_on.toISOString().slice(0, 10),
      status: orderCount > 1 ? 'Repeat' : 'New',
    };
  });

  const repeatCount = all.filter((r) => Number(r.order_count) > 1).length;
  const summary: ReportRow = {
    label: '',
    customer_name: `Total (${repeatCount} repeat phone numbers)`,
    order_count: all.reduce((s, r) => s + Number(r.order_count ?? 0), 0),
    customer_profile_count: null,
    total_spent: all.reduce((s, r) => s + Number(r.total_spent ?? 0), 0),
    first_order_on: null,
    last_order_on: null,
    status: '',
  };

  const paged = ctx.all
    ? all
    : all.slice((ctx.page - 1) * ctx.pageSize, ctx.page * ctx.pageSize);
  return { rows: paged, summary, total: all.length };
}

const FILTERS = ['date_range', 'location', 'channel', 'staff'] as const;

export const CUSTOMER_REPORTS: ReportDef[] = [
  {
    id: 'customers-by-age',
    group: 'khach_hang',
    name: 'Customers by age',
    description: 'Customer count, order count and revenue by age group (from date of birth).',
    filters: [...FILTERS],
    columns: [{ key: 'label', label: 'Age group', type: 'text' }, ...METRIC_COLUMNS],
    chart: { type: 'bar', x: 'label', y: ['customer_count'] },
    note: 'Customers without a date of birth are grouped under "Unknown". Age is calculated as of today, not the order date.',
    run: runByAge,
  },
  {
    id: 'customers-by-region',
    group: 'khach_hang',
    name: 'Customers by region',
    description: 'Customer count, order count and revenue by shipping province/city.',
    filters: [...FILTERS],
    columns: [{ key: 'label', label: 'Province/City', type: 'text' }, ...METRIC_COLUMNS],
    chart: { type: 'bar', x: 'label', y: ['total_spent'] },
    note: 'Grouped by each order\'s shipping province, not the customer profile\'s default address — a customer may ship to different places across orders.',
    run: runByRegion,
  },
  {
    id: 'customers-by-gender',
    group: 'khach_hang',
    name: 'Customers by gender',
    description: 'Customer count, order count and revenue by gender.',
    filters: [...FILTERS],
    columns: [{ key: 'label', label: 'Gender', type: 'text' }, ...METRIC_COLUMNS],
    chart: { type: 'bar', x: 'label', y: ['customer_count'] },
    run: runByGender,
  },
  {
    id: 'customers-by-spending',
    group: 'khach_hang',
    name: 'Customers by spending',
    description: 'Customer segments by total spend within the selected period.',
    filters: [...FILTERS],
    columns: [{ key: 'label', label: 'Spending tier', type: 'text' }, ...METRIC_COLUMNS],
    chart: { type: 'bar', x: 'label', y: ['customer_count'] },
    note: 'Only counts orders linked to a customer profile (customer_id) — walk-in orders with no profile are excluded here, see "Repeat customers by phone" to cover that group.',
    run: runBySpending,
  },
  {
    id: 'customers-by-product-type',
    group: 'khach_hang',
    name: 'Customers by product type',
    description: 'Customer count, order count and revenue by product type purchased.',
    filters: [...FILTERS],
    columns: [{ key: 'label', label: 'Product type', type: 'text' }, ...METRIC_COLUMNS],
    chart: { type: 'bar', x: 'label', y: ['total_spent'] },
    note: 'A customer who buys multiple product types is counted under each type, so the total customer count across rows can exceed the actual number of distinct customers.',
    run: runByProductType,
  },
  {
    id: 'repeat-customers-by-phone',
    group: 'khach_hang',
    name: 'Repeat customers by phone',
    description:
      'Groups orders by phone number to detect repeat customers, even when the system holds several separate customer profiles for the same phone number.',
    filters: [...FILTERS],
    columns: PHONE_COLUMNS,
    note: '"Duplicate customer profiles" > 1 means the same phone number is currently split across multiple different customer profiles in the system.',
    run: runByPhoneRepeat,
  },
];
