import { Prisma } from '@prisma/client';
import { CHANNEL_DEFS } from '../../channels/channel-source-map';
import {
  DashboardParams,
  bucketIdxSql,
  bucketLabels,
  metric,
  rate,
  startOfDay,
} from './dashboard-overview.report';
import { EFFECTIVE_QTY, UNIT_COST, num } from './report-sql';

/**
 * Các khối "bán hàng" của màn Tổng quan: dải KPI (doanh số, doanh thu, lợi nhuận, đơn
 * chốt...), tách Online / Bán tại quầy, bảng theo kho và theo nhân viên, "Kinh doanh hôm
 * nay" theo giờ, hàng hoàn và tồn kho.
 *
 * Bốn định nghĩa riêng của file này — khác các báo cáo còn lại, đã chốt với nghiệp vụ:
 *
 * - **"Chốt" tính theo ngày xác nhận**, không theo ngày tạo: xem `CLOSED_AT`.
 * - **Doanh thu đơn sàn lấy số của sàn** khi có: xem `ORDER_REVENUE`.
 * - **Tỷ lệ chốt** = đơn đã chốt ÷ đơn phát sinh trong kỳ của CHÍNH nhân viên đó (cùng một
 *   tập đơn nên luôn ≤ 100%); đơn không gán nhân viên thì không có tỷ lệ.
 * - **Cần nhập thêm** suy từ tốc độ bán `RESTOCK_WINDOW_DAYS` ngày gần nhất, không có định
 *   mức tồn tối thiểu nào trong schema.
 */

/**
 * Thời điểm chốt đơn. Đơn tạo trong app chỉ "chốt" khi được xác nhận (`confirmed_on`).
 * Đơn đồng bộ từ Sapo thì gần như không mang `confirmed_on` dù đã giao xong — với các đơn
 * đó lấy ngày tạo, nếu không cả lịch sử Sapo rơi khỏi mọi con số.
 */
const CLOSED_AT = Prisma.sql`COALESCE(o."confirmed_on", CASE WHEN o."sapo_id" IS NOT NULL THEN o."created_on" END)`;

/**
 * Doanh thu một đơn. Sapo không trừ phần sàn trợ giá khỏi `total_price` nên đơn sàn đi
 * qua Sapo bị ghi dư; `channel_total_amount` là số sàn báo người mua thực trả. NULL = chưa
 * biết số của sàn (không phải 0) → dùng lại `total_price`.
 */
const ORDER_REVENUE = Prisma.sql`COALESCE(o."channel_total_amount", o."total_price")`;

const POS_SOURCES = CHANNEL_DEFS.find((d) => d.key === 'pos')?.sources ?? [
  'pos',
];

/** Đơn bán tại quầy; mọi nguồn còn lại (kể cả nguồn lạ) là Online. */
const IS_POS = Prisma.sql`(LOWER(COALESCE(o."source_name", '')) IN (${Prisma.join(POS_SOURCES)}))`;

export const RESTOCK_WINDOW_DAYS = 30;

const MS_DAY = 24 * 60 * 60 * 1000;

function filterSql(p: DashboardParams): Prisma.Sql {
  const conditions: Prisma.Sql[] = [
    Prisma.sql`o."location_id" IN (${Prisma.join(p.locationIds)})`,
  ];
  if (p.channel) conditions.push(Prisma.sql`o."source_name" = ${p.channel}`);
  return Prisma.join(conditions, ' AND ');
}

/** Đơn chốt trong `[from, to)`: chưa huỷ và có thời điểm chốt rơi vào kỳ. */
function closedScope(p: DashboardParams, from: Date, to: Date): Prisma.Sql {
  return Prisma.sql`o."status" <> 'cancelled'
    AND ${CLOSED_AT} >= ${from} AND ${CLOSED_AT} < ${to}
    AND ${filterSql(p)}`;
}

// --- Đơn chốt, gom theo kho × nhân viên × kênh ---

type ClosedRaw = {
  location_id: bigint;
  assignee_id: bigint | null;
  is_pos: boolean;
  orders: bigint | number;
  revenue: Prisma.Decimal | null;
  discount: Prisma.Decimal | null;
  quantity: Prisma.Decimal | bigint | number | null;
  cost: Prisma.Decimal | null;
  missing_cost: Prisma.Decimal | bigint | number | null;
};

export type ClosedCell = {
  locationId: string;
  staffId: string | null;
  isPos: boolean;
  orders: number;
  revenue: number;
  discount: number;
  quantity: number;
  cost: number;
  missingCost: number;
};

/**
 * Một query cho cả kỳ, gom ở mức mịn nhất mà các khối cần (kho × nhân viên × quầy/online)
 * rồi cộng lại ở JS — tổng, từng kho, từng nhân viên vì thế luôn khớp nhau, không lệch do
 * đơn ghi thêm giữa hai lần đọc.
 *
 * Tiền lấy ở cấp ĐƠN, chỉ số lượng và giá vốn mới xuống dòng hàng: cộng tiền theo dòng sẽ
 * dính dòng Sapo đã xoá và chiết khấu cấp đơn không phân bổ (xem `EFFECTIVE_QTY` — dòng đã
 * xoá có `current_quantity = 0` nên tự rơi khỏi số lượng lẫn giá vốn).
 */
async function queryClosed(
  p: DashboardParams,
  from: Date,
  to: Date,
): Promise<ClosedCell[]> {
  const rows = await p.prisma.$queryRaw<ClosedRaw[]>`
    WITH ord AS (
      SELECT o."id", o."location_id", o."assignee_id",
             ${IS_POS}          AS is_pos,
             ${ORDER_REVENUE}   AS revenue,
             o."total_discounts" AS discount
      FROM "oms"."orders" o
      WHERE ${closedScope(p, from, to)}
    ),
    li AS (
      SELECT oi."order_id",
             SUM(${EFFECTIVE_QTY})                AS quantity,
             SUM(${UNIT_COST} * ${EFFECTIVE_QTY}) AS cost,
             COUNT(*) FILTER (WHERE ${EFFECTIVE_QTY} > 0 AND ${UNIT_COST} = 0)
                                                  AS missing_cost
      FROM "oms"."order_items" oi
      JOIN ord                             ON ord."id" = oi."order_id"
      LEFT JOIN "oms"."product_variants" v ON v."id" = oi."variant_id"
      GROUP BY oi."order_id"
    )
    SELECT ord."location_id", ord."assignee_id", ord.is_pos,
           COUNT(*)                          AS orders,
           SUM(ord.revenue)                  AS revenue,
           SUM(ord.discount)                 AS discount,
           COALESCE(SUM(li.quantity), 0)     AS quantity,
           COALESCE(SUM(li.cost), 0)         AS cost,
           COALESCE(SUM(li.missing_cost), 0) AS missing_cost
    FROM ord
    LEFT JOIN li ON li."order_id" = ord."id"
    GROUP BY 1, 2, 3
  `;
  return rows.map((r) => ({
    locationId: r.location_id.toString(),
    staffId: r.assignee_id?.toString() ?? null,
    isPos: r.is_pos,
    orders: Number(r.orders),
    revenue: num(r.revenue),
    discount: num(r.discount),
    quantity: Number(r.quantity ?? 0),
    cost: num(r.cost),
    missingCost: Number(r.missing_cost ?? 0),
  }));
}

export type SalesTotals = {
  orders: number;
  revenue: number;
  discount: number;
  quantity: number;
  cost: number;
  missingCost: number;
};

const EMPTY_TOTALS: SalesTotals = {
  orders: 0,
  revenue: 0,
  discount: 0,
  quantity: 0,
  cost: 0,
  missingCost: 0,
};

/** Cộng các ô thoả `pick` (mặc định: tất cả). */
export function sumCells(
  cells: ClosedCell[],
  pick: (c: ClosedCell) => boolean = () => true,
): SalesTotals {
  const t = { ...EMPTY_TOTALS };
  for (const c of cells) {
    if (!pick(c)) continue;
    t.orders += c.orders;
    t.revenue += c.revenue;
    t.discount += c.discount;
    t.quantity += c.quantity;
    t.cost += c.cost;
    t.missingCost += c.missingCost;
  }
  return t;
}

export function groupCells(
  cells: ClosedCell[],
  keyOf: (c: ClosedCell) => string,
): Map<string, SalesTotals> {
  const out = new Map<string, SalesTotals>();
  for (const c of cells) {
    const key = keyOf(c);
    const t = out.get(key) ?? { ...EMPTY_TOTALS };
    t.orders += c.orders;
    t.revenue += c.revenue;
    t.discount += c.discount;
    t.quantity += c.quantity;
    t.cost += c.cost;
    t.missingCost += c.missingCost;
    out.set(key, t);
  }
  return out;
}

function per(total: number, count: number, digits = 0): number {
  if (count <= 0) return 0;
  const f = 10 ** digits;
  return Math.round((total / count) * f) / f;
}

/** Các chỉ số suy ra từ một bộ tổng — dùng chung cho dải KPI, dòng kho, dòng nhân viên. */
export function derive(t: SalesTotals) {
  const profit = t.revenue - t.cost;
  return {
    // Doanh số = trước chiết khấu, Doanh thu = sau chiết khấu
    gross_sales: t.revenue + t.discount,
    revenue: t.revenue,
    discount: t.discount,
    profit,
    closed_orders: t.orders,
    avg_order_value: per(t.revenue, t.orders),
    items_sold: t.quantity,
    avg_items_per_order: per(t.quantity, t.orders, 2),
    avg_profit_per_order: per(profit, t.orders),
  };
}

type Derived = ReturnType<typeof derive>;

function metrics<K extends keyof Derived>(
  cur: SalesTotals,
  prev: SalesTotals,
  keys: readonly K[],
) {
  const a = derive(cur);
  const b = derive(prev);
  return Object.fromEntries(keys.map((k) => [k, metric(a[k], b[k])])) as Record<
    K,
    ReturnType<typeof metric>
  >;
}

const KPI_KEYS = [
  'gross_sales',
  'revenue',
  'discount',
  'profit',
  'closed_orders',
  'avg_order_value',
  'items_sold',
  'avg_items_per_order',
  'avg_profit_per_order',
] as const;

const CHANNEL_KEYS = ['revenue', 'closed_orders'] as const;

const LOCATION_KEYS = [
  'revenue',
  'gross_sales',
  'discount',
  'closed_orders',
  'items_sold',
  'avg_order_value',
] as const;

const STAFF_KEYS = [
  'revenue',
  'gross_sales',
  'discount',
  'closed_orders',
] as const;

// --- Tỷ lệ chốt theo nhân viên ---

type CohortRaw = {
  assignee_id: bigint | null;
  total: bigint | number;
  closed: bigint | number;
};

/**
 * Tử và mẫu cùng một tập: đơn PHÁT SINH trong kỳ của nhân viên (kể cả đơn huỷ), trong đó
 * bao nhiêu đơn đã chốt. Không lấy "đơn chốt trong kỳ ÷ đơn tạo trong kỳ" — hai tập khác
 * nhau nên tỷ lệ vọt quá 100% khi đơn tạo kỳ trước được chốt kỳ này.
 */
async function queryCloseRate(p: DashboardParams, from: Date, to: Date) {
  const rows = await p.prisma.$queryRaw<CohortRaw[]>`
    SELECT o."assignee_id",
           COUNT(*) AS total,
           COUNT(*) FILTER (WHERE o."status" <> 'cancelled'
                              AND ${CLOSED_AT} IS NOT NULL) AS closed
    FROM "oms"."orders" o
    WHERE o."created_on" >= ${from} AND o."created_on" < ${to}
      AND o."assignee_id" IS NOT NULL
      AND ${filterSql(p)}
    GROUP BY 1
  `;
  return new Map(
    rows.map((r) => [
      r.assignee_id!.toString(),
      { total: Number(r.total), closed: Number(r.closed) },
    ]),
  );
}

// --- Biểu đồ doanh thu theo ngày chốt ---

async function querySeries(
  p: DashboardParams,
  from: Date,
  to: Date,
  size: number,
) {
  const rows = await p.prisma.$queryRaw<
    { idx: number; revenue: Prisma.Decimal | null }[]
  >`
    SELECT ${bucketIdxSql(p.period.bucket, from, CLOSED_AT)} AS idx,
           SUM(${ORDER_REVENUE}) AS revenue
    FROM "oms"."orders" o
    WHERE ${closedScope(p, from, to)}
    GROUP BY 1
  `;
  const series = new Array<number>(size).fill(0);
  for (const r of rows) {
    const i = Number(r.idx);
    if (i >= 0 && i < size) series[i] = num(r.revenue);
  }
  return series;
}

// --- Hàng hoàn ---

/** Phiếu trả hàng lập trong kỳ. Số lượng lấy bằng subquery để tiền không bị nhân theo số dòng. */
async function queryReturns(p: DashboardParams, from: Date, to: Date) {
  const rows = await p.prisma.$queryRaw<
    { amount: Prisma.Decimal | null; quantity: bigint | number | null }[]
  >`
    SELECT SUM(COALESCE(r."refund_amount", 0)) AS amount,
           SUM((SELECT COALESCE(SUM(ri."quantity"), 0)
                FROM "oms"."order_return_items" ri
                WHERE ri."order_return_id" = r."id")) AS quantity
    FROM "oms"."order_returns" r
    JOIN "oms"."orders" o ON o."id" = r."order_id"
    WHERE r."created_on" >= ${from} AND r."created_on" < ${to}
      AND ${filterSql(p)}
  `;
  return {
    amount: num(rows[0]?.amount),
    quantity: Number(rows[0]?.quantity ?? 0),
  };
}

// --- Kinh doanh hôm nay ---

/**
 * Luôn là NGÀY HÔM NAY, không theo kỳ đang chọn (vẫn theo bộ lọc kho/kênh). "Đơn tạo mới"
 * và "Đơn huỷ" đếm theo ngày tạo / ngày huỷ, nên không nhất thiết là tập con của nhau.
 */
async function queryToday(p: DashboardParams, now: Date) {
  const from = startOfDay(now);
  const to = new Date(from.getTime() + MS_DAY);

  const [hourRows, countRows, itemRows] = await Promise.all([
    p.prisma.$queryRaw<
      {
        idx: number;
        is_pos: boolean;
        orders: bigint | number;
        revenue: Prisma.Decimal | null;
      }[]
    >`
      SELECT ${bucketIdxSql('hour', from, CLOSED_AT)} AS idx,
             ${IS_POS}             AS is_pos,
             COUNT(*)              AS orders,
             SUM(${ORDER_REVENUE}) AS revenue
      FROM "oms"."orders" o
      WHERE ${closedScope(p, from, to)}
      GROUP BY 1, 2
    `,
    p.prisma.$queryRaw<
      { created: bigint | number; cancelled: bigint | number }[]
    >`
      SELECT COUNT(*) FILTER (WHERE o."created_on" >= ${from} AND o."created_on" < ${to})
                                                               AS created,
             COUNT(*) FILTER (WHERE o."status" = 'cancelled'
                                AND o."cancelled_on" >= ${from}
                                AND o."cancelled_on" < ${to})  AS cancelled
      FROM "oms"."orders" o
      WHERE ${filterSql(p)}
        AND (o."created_on" >= ${from} OR o."cancelled_on" >= ${from})
    `,
    p.prisma.$queryRaw<
      {
        customers: bigint | number;
        quantity: Prisma.Decimal | bigint | number | null;
      }[]
    >`
      SELECT COUNT(DISTINCT o."customer_id") AS customers,
             SUM((SELECT COALESCE(SUM(${EFFECTIVE_QTY}), 0)
                  FROM "oms"."order_items" oi
                  WHERE oi."order_id" = o."id")) AS quantity
      FROM "oms"."orders" o
      WHERE ${closedScope(p, from, to)}
    `,
  ]);

  const hourly = new Array<number>(24).fill(0);
  const split = {
    online: { revenue: 0, closed_orders: 0 },
    pos: { revenue: 0, closed_orders: 0 },
  };
  for (const r of hourRows) {
    const i = Number(r.idx);
    const revenue = num(r.revenue);
    if (i >= 0 && i < 24) hourly[i] += revenue;
    const side = r.is_pos ? split.pos : split.online;
    side.revenue += revenue;
    side.closed_orders += Number(r.orders);
  }

  return {
    revenue: split.online.revenue + split.pos.revenue,
    closed_orders: split.online.closed_orders + split.pos.closed_orders,
    hourly,
    online: split.online,
    pos: split.pos,
    created_orders: Number(countRows[0]?.created ?? 0),
    cancelled_orders: Number(countRows[0]?.cancelled ?? 0),
    items_sold: Number(itemRows[0]?.quantity ?? 0),
    customers: Number(itemRows[0]?.customers ?? 0),
  };
}

// --- Tồn kho ---

/**
 * Tồn hiện tại của các kho đang xem (không theo kỳ, không theo kênh). "Có thể bán" bỏ
 * qua các dòng âm (đơn giữ hàng vượt tồn) — đó là hàng thiếu, không phải hàng bán được.
 *
 * "Cần nhập thêm": phiên bản nào bán trong `RESTOCK_WINDOW_DAYS` ngày qua nhiều hơn lượng
 * đang có thể bán thì coi là thiếu đúng phần chênh — tức tồn không đủ cho một chu kỳ nữa
 * với cùng tốc độ bán. Hàng không bán được trong kỳ đó không bao giờ bị tính là thiếu.
 */
async function queryInventory(p: DashboardParams, now: Date) {
  const since = new Date(now.getTime() - RESTOCK_WINDOW_DAYS * MS_DAY);
  const locations = Prisma.join(p.locationIds);

  const [stockRows, restockRows] = await Promise.all([
    p.prisma.$queryRaw<
      {
        available: bigint | number | null;
        stock_value: Prisma.Decimal | null;
        retail_value: Prisma.Decimal | null;
      }[]
    >`
      SELECT SUM(GREATEST(il."available", 0)) AS available,
             SUM(il."on_hand" * v."cost")   AS stock_value,
             SUM(il."on_hand" * v."price")  AS retail_value
      FROM "oms"."inventory_levels" il
      JOIN "oms"."product_variants" v ON v."id" = il."variant_id"
      WHERE il."location_id" IN (${locations})
    `,
    p.prisma.$queryRaw<
      {
        variants: bigint | number;
        quantity: Prisma.Decimal | bigint | number | null;
      }[]
    >`
      WITH sold AS (
        SELECT oi."variant_id", SUM(${EFFECTIVE_QTY}) AS quantity
        FROM "oms"."order_items" oi
        JOIN "oms"."orders" o ON o."id" = oi."order_id"
        WHERE o."status" <> 'cancelled'
          AND o."created_on" >= ${since}
          AND o."location_id" IN (${locations})
          AND oi."variant_id" IS NOT NULL
        GROUP BY 1
      ),
      stock AS (
        SELECT il."variant_id", SUM(il."available") AS available
        FROM "oms"."inventory_levels" il
        WHERE il."location_id" IN (${locations})
        GROUP BY 1
      )
      SELECT COUNT(*) FILTER (WHERE s.quantity > COALESCE(k.available, 0)) AS variants,
             SUM(GREATEST(s.quantity - COALESCE(k.available, 0), 0))       AS quantity
      FROM sold s
      LEFT JOIN stock k ON k."variant_id" = s."variant_id"
    `,
  ]);

  return {
    available: Number(stockRows[0]?.available ?? 0),
    stock_value: num(stockRows[0]?.stock_value),
    retail_value: num(stockRows[0]?.retail_value),
    restock_variants: Number(restockRows[0]?.variants ?? 0),
    restock_quantity: Number(restockRows[0]?.quantity ?? 0),
    restock_window_days: RESTOCK_WINDOW_DAYS,
  };
}

// --- Ghép khối ---

type Named = { id: string; name: string };

export type CloseRate = { total: number; closed: number };

/** Bảng "Kho hàng": mỗi kho có đơn chốt ở kỳ này hoặc kỳ trước, xếp theo doanh thu. */
export function buildLocationRows(
  cur: ClosedCell[],
  prev: ClosedCell[],
  names: Named[],
) {
  const a = groupCells(cur, (c) => c.locationId);
  const b = groupCells(prev, (c) => c.locationId);
  const nameOf = new Map(names.map((n) => [n.id, n.name]));
  return [...new Set([...a.keys(), ...b.keys()])]
    .map((id) => ({
      location_id: id,
      name: nameOf.get(id) ?? '(Không xác định)',
      ...metrics(
        a.get(id) ?? EMPTY_TOTALS,
        b.get(id) ?? EMPTY_TOTALS,
        LOCATION_KEYS,
      ),
    }))
    .sort((x, y) => y.revenue.value - x.revenue.value);
}

const NO_STAFF = '';

/**
 * Bảng "Nhân viên". Đơn không gán nhân viên (đơn sàn tự về, đơn import) gom vào một dòng
 * "Hệ thống" và KHÔNG có tỷ lệ chốt — không ai "chốt" các đơn đó.
 */
export function buildStaffRows(
  cur: ClosedCell[],
  prev: ClosedCell[],
  curRate: Map<string, CloseRate>,
  prevRate: Map<string, CloseRate>,
  names: Named[],
) {
  const a = groupCells(cur, (c) => c.staffId ?? NO_STAFF);
  const b = groupCells(prev, (c) => c.staffId ?? NO_STAFF);
  const nameOf = new Map(names.map((n) => [n.id, n.name]));
  // Nhân viên có đơn phát sinh nhưng chưa chốt được đơn nào vẫn phải hiện (tỷ lệ chốt 0%)
  const ids = new Set([...a.keys(), ...curRate.keys()]);
  return [...ids]
    .map((id) => {
      const r = curRate.get(id);
      const pr = prevRate.get(id);
      return {
        staff_id: id === NO_STAFF ? null : id,
        name:
          id === NO_STAFF ? 'Hệ thống' : (nameOf.get(id) ?? '(Không xác định)'),
        ...metrics(
          a.get(id) ?? EMPTY_TOTALS,
          b.get(id) ?? EMPTY_TOTALS,
          STAFF_KEYS,
        ),
        close_rate:
          id === NO_STAFF || !r
            ? null
            : metric(
                rate(r.closed, r.total),
                pr ? rate(pr.closed, pr.total) : 0,
              ),
      };
    })
    .sort((x, y) => y.revenue.value - x.revenue.value);
}

function ymd(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

export async function runDashboardSales(
  p: DashboardParams,
  now: Date = new Date(),
) {
  const { period } = p;
  const labels = bucketLabels(period);
  const size = labels.length;

  const [
    cur,
    prev,
    curRate,
    prevRate,
    curSeries,
    prevSeries,
    returns,
    prevReturns,
    today,
    inventory,
  ] = await Promise.all([
    queryClosed(p, period.from, period.to),
    queryClosed(p, period.prevFrom, period.prevTo),
    queryCloseRate(p, period.from, period.to),
    queryCloseRate(p, period.prevFrom, period.prevTo),
    querySeries(p, period.from, period.to, size),
    querySeries(p, period.prevFrom, period.prevTo, size),
    queryReturns(p, period.from, period.to),
    queryReturns(p, period.prevFrom, period.prevTo),
    queryToday(p, now),
    queryInventory(p, now),
  ]);

  const staffIds = [
    ...new Set(
      [...cur.map((c) => c.staffId), ...curRate.keys()].filter(
        (id): id is string => !!id,
      ),
    ),
  ];
  const [locations, staff] = await Promise.all([
    p.prisma.location.findMany({
      where: { id: { in: p.locationIds } },
      select: { id: true, name: true },
    }),
    staffIds.length
      ? p.prisma.user.findMany({
          where: { id: { in: staffIds.map((id) => BigInt(id)) } },
          select: { id: true, firstName: true, lastName: true, email: true },
        })
      : [],
  ]);

  const total = sumCells(cur);
  const prevTotal = sumCells(prev);
  const isPos = (c: ClosedCell) => c.isPos;
  const isOnline = (c: ClosedCell) => !c.isPos;
  const profit = total.revenue - total.cost;

  return {
    sales: {
      kpis: metrics(total, prevTotal, KPI_KEYS),
      profit_margin: rate(profit, total.revenue),
      // Dòng hàng không có giá vốn → lợi nhuận của dòng đó đang bị tính bằng cả doanh thu
      missing_cost_lines: total.missingCost,
      channels: {
        total: metrics(total, prevTotal, CHANNEL_KEYS),
        online: metrics(
          sumCells(cur, isOnline),
          sumCells(prev, isOnline),
          CHANNEL_KEYS,
        ),
        pos: metrics(sumCells(cur, isPos), sumCells(prev, isPos), CHANNEL_KEYS),
      },
      chart: { labels, current: curSeries, previous: prevSeries },
      returns: {
        amount: metric(returns.amount, prevReturns.amount),
        quantity: metric(returns.quantity, prevReturns.quantity),
      },
      by_location: buildLocationRows(
        cur,
        prev,
        locations.map((l) => ({ id: l.id.toString(), name: l.name })),
      ),
      by_staff: buildStaffRows(
        cur,
        prev,
        curRate,
        prevRate,
        staff.map((u) => ({
          id: u.id.toString(),
          name:
            [u.firstName, u.lastName].filter(Boolean).join(' ').trim() ||
            u.email ||
            '(Không tên)',
        })),
      ),
    },
    today: { date: ymd(startOfDay(now)), ...today },
    inventory,
  };
}
