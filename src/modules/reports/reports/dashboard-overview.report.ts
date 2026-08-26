import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { ACTIVITY_ACTION_LABELS } from '../../activity-log/activity-log.serializer';
import { num } from './report-sql';

/**
 * Màn "Tổng quan" (trang chủ) — dựng theo bố cục dashboard của Sapo: kết quả kinh doanh,
 * biểu đồ doanh thu, thống kê truy cập, sản phẩm bán chạy, tỉ lệ chuyển đổi, nhật ký hoạt động.
 *
 * Không dùng khung `ReportDef` chung (một bảng + dòng tổng) vì màn này gồm nhiều khối khác
 * hình dạng — mỗi khối một query, gom lại ở đây (giống `product-monthly-ops.report.ts`).
 *
 * Hai khối phải đổi định nghĩa so với Sapo vì app KHÔNG có web analytics (không bảng nào
 * lưu session/pageview — đã soát toàn schema):
 * - **Thống kê truy cập**: thay phiên truy cập website bằng ba chỉ số "ai đang đến với
 *   shop" lấy từ dữ liệu thật — phiên tương tác CSKH, số khách có mua trong kỳ, và tỷ lệ
 *   khách quay lại (khách đã từng mua trước kỳ).
 * - **Tỉ lệ chuyển đổi**: mẫu số là TỔNG ĐƠN phát sinh trong kỳ (kể cả đơn hủy) chứ không
 *   phải lượt truy cập, nên phễu đo "đơn vào rồi đi được tới đâu": chốt đơn → xác nhận →
 *   thu đủ tiền → giao xong. Mọi tỉ lệ vì thế luôn nằm trong 0-100%.
 *
 * `conversations` không gắn `location_id` nên bộ lọc kho không áp được vào số phiên tương
 * tác — chỉ số đó luôn là toàn hệ thống.
 */

/** Đơn vị gom nhóm của biểu đồ, suy ra từ độ dài kỳ. Riêng của màn này, khác `TimeBucket`. */
export type DashboardBucket = 'hour' | 'day' | 'month';

export type DashboardRange =
  | 'today'
  | 'yesterday'
  | 'this_week'
  | 'last_week'
  | 'this_month'
  | 'last_month'
  | 'this_year'
  | 'last_year'
  | 'custom';

export type DashboardPeriod = {
  range: DashboardRange;
  from: Date;
  /** Mốc loại trừ (`< to`). */
  to: Date;
  prevFrom: Date;
  prevTo: Date;
  bucket: DashboardBucket;
};

export type DashboardParams = {
  prisma: PrismaService;
  period: DashboardPeriod;
  locationIds: bigint[];
  /** `orders.source_name` */
  channel?: string;
  topLimit: number;
  activityLimit: number;
};

const MS_DAY = 24 * 60 * 60 * 1000;

// --- Khoảng thời gian ---

function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Đầu tuần theo ISO (thứ 2). */
function startOfWeek(d: Date) {
  const day = (d.getDay() + 6) % 7; // Monday = 0
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - day);
}

function bucketFor(from: Date, to: Date): DashboardBucket {
  const days = (to.getTime() - from.getTime()) / MS_DAY;
  if (days <= 2) return 'hour';
  if (days <= 92) return 'day';
  return 'month';
}

/**
 * Kỳ so sánh = kỳ liền trước CÙNG LOẠI.
 *
 * Với kỳ ĐANG CHẠY (hôm nay, tuần/tháng/năm này) thì cắt đúng độ dài đã trôi qua — đúng
 * cách Sapo so "Tuần này (24/08 - 26/08)" với "Kỳ trước (17/08 - 19/08)": lùi trọn một
 * tuần rồi lấy đúng 3 ngày, chứ không lấy trọn 7 ngày của tuần trước.
 *
 * Với kỳ ĐÃ TRỌN (hôm qua, tuần/tháng/năm trước) thì phải truyền `prevTo` là chính `from`.
 * Suy ra theo độ dài sẽ sai khi hai kỳ không bằng nhau: tháng 7 có 31 ngày, cộng 31 ngày
 * từ 01/06 ra 02/07 — kỳ so sánh đè lên chính kỳ đang xem.
 */
function withPrev(
  range: DashboardRange,
  from: Date,
  to: Date,
  prevFrom: Date,
  prevTo?: Date,
): DashboardPeriod {
  return {
    range,
    from,
    to,
    prevFrom,
    prevTo:
      prevTo ?? new Date(prevFrom.getTime() + (to.getTime() - from.getTime())),
    bucket: bucketFor(from, to),
  };
}

export function resolveDashboardPeriod(
  range: DashboardRange,
  fromStr?: string,
  toStr?: string,
  now: Date = new Date(),
): DashboardPeriod {
  const today = startOfDay(now);

  switch (range) {
    case 'today':
      return withPrev(
        range,
        today,
        now,
        new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1),
      );
    case 'yesterday': {
      const from = new Date(
        today.getFullYear(),
        today.getMonth(),
        today.getDate() - 1,
      );
      return withPrev(
        range,
        from,
        today,
        new Date(from.getFullYear(), from.getMonth(), from.getDate() - 1),
        from,
      );
    }
    case 'this_week': {
      const from = startOfWeek(now);
      return withPrev(
        range,
        from,
        now,
        new Date(from.getFullYear(), from.getMonth(), from.getDate() - 7),
      );
    }
    case 'last_week': {
      const thisWeek = startOfWeek(now);
      const from = new Date(
        thisWeek.getFullYear(),
        thisWeek.getMonth(),
        thisWeek.getDate() - 7,
      );
      return withPrev(
        range,
        from,
        thisWeek,
        new Date(from.getFullYear(), from.getMonth(), from.getDate() - 7),
        from,
      );
    }
    case 'this_month': {
      const from = new Date(now.getFullYear(), now.getMonth(), 1);
      return withPrev(
        range,
        from,
        now,
        new Date(now.getFullYear(), now.getMonth() - 1, 1),
      );
    }
    case 'last_month': {
      const from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      return withPrev(
        range,
        from,
        new Date(now.getFullYear(), now.getMonth(), 1),
        new Date(now.getFullYear(), now.getMonth() - 2, 1),
        from,
      );
    }
    case 'this_year': {
      const from = new Date(now.getFullYear(), 0, 1);
      return withPrev(range, from, now, new Date(now.getFullYear() - 1, 0, 1));
    }
    case 'last_year': {
      const from = new Date(now.getFullYear() - 1, 0, 1);
      return withPrev(
        range,
        from,
        new Date(now.getFullYear(), 0, 1),
        new Date(now.getFullYear() - 2, 0, 1),
        from,
      );
    }
    default: {
      // custom: `to` là ngày cuối BAO GỒM, kỳ trước là khoảng cùng độ dài liền kề trước đó
      const from = new Date(`${fromStr}T00:00:00`);
      const to = new Date(new Date(`${toStr}T00:00:00`).getTime() + MS_DAY);
      return withPrev(
        'custom',
        from,
        to,
        new Date(from.getTime() - (to.getTime() - from.getTime())),
      );
    }
  }
}

// --- Tiện ích ---

function pctChange(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function rate(part: number, total: number): number {
  return total > 0 ? round1((part / total) * 100) : 0;
}

function metric(current: number, previous: number) {
  return { value: current, previous, change_pct: pctChange(current, previous) };
}

function ymd(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

/**
 * Chỉ số ô (bucket) của một mốc thời gian, tính TƯƠNG ĐỐI so với đầu kỳ. Kỳ hiện tại và kỳ
 * trước dùng chung biểu thức này với `start` riêng, nhờ vậy hai chuỗi tự khớp nhau theo
 * index mà không phải đối chiếu ngày tháng.
 */
function bucketIdxSql(
  bucket: DashboardBucket,
  start: Date,
  column: Prisma.Sql,
): Prisma.Sql {
  if (bucket === 'month') {
    return Prisma.sql`((EXTRACT(YEAR FROM ${column})::int * 12 + EXTRACT(MONTH FROM ${column})::int)
      - (EXTRACT(YEAR FROM ${start}::timestamp)::int * 12 + EXTRACT(MONTH FROM ${start}::timestamp)::int))`;
  }
  const step = bucket === 'hour' ? 3600 : 86400;
  return Prisma.sql`FLOOR(EXTRACT(EPOCH FROM (${column} - ${start}::timestamp)) / ${step})::int`;
}

/** Nhãn trục X, dựng ở JS để kỳ hiện tại và kỳ trước dùng đúng một bộ nhãn. */
export function bucketLabels(period: DashboardPeriod): string[] {
  const { from, to, bucket } = period;
  const labels: string[] = [];
  const cursor = new Date(from);
  while (cursor < to) {
    if (bucket === 'hour') {
      labels.push(`${String(cursor.getHours()).padStart(2, '0')}:00`);
      cursor.setHours(cursor.getHours() + 1);
    } else if (bucket === 'day') {
      labels.push(
        `${String(cursor.getDate()).padStart(2, '0')}/${String(cursor.getMonth() + 1).padStart(2, '0')}`,
      );
      cursor.setDate(cursor.getDate() + 1);
    } else {
      labels.push(
        `${String(cursor.getMonth() + 1).padStart(2, '0')}/${cursor.getFullYear()}`,
      );
      cursor.setMonth(cursor.getMonth() + 1);
    }
  }
  // Kỳ rỗng (vd "Hôm nay" lúc 00:00:00) vẫn phải có 1 cột, nếu không biểu đồ trống trơn
  return labels.length ? labels : ['—'];
}

/** Điều kiện lọc đơn dùng chung cho mọi query của màn này. */
function orderScope(
  p: DashboardParams,
  from: Date,
  to: Date,
  extra: Prisma.Sql = Prisma.empty,
): Prisma.Sql {
  const conditions: Prisma.Sql[] = [
    Prisma.sql`o."created_on" >= ${from}`,
    Prisma.sql`o."created_on" < ${to}`,
    Prisma.sql`o."location_id" IN (${Prisma.join(p.locationIds)})`,
  ];
  if (p.channel) conditions.push(Prisma.sql`o."source_name" = ${p.channel}`);
  const base = Prisma.join(conditions, ' AND ');
  return extra === Prisma.empty ? base : Prisma.sql`${base} AND ${extra}`;
}

// --- Kết quả kinh doanh ---

type BusinessRaw = {
  order_count: bigint | number;
  cancelled_count: bigint | number;
  unpaid_count: bigint | number;
  unfulfilled_count: bigint | number;
  shipping_count: bigint | number;
  total_price: Prisma.Decimal | null;
  total_refunded: Prisma.Decimal | null;
};

/**
 * Mọi chỉ số tiền/đếm của khối "Kết quả kinh doanh" trong MỘT query — các mẫu số phải
 * cùng một tập đơn, tách query dễ lệch khi có đơn ghi thêm giữa hai lần đọc.
 *
 * "Hủy" đếm riêng và KHÔNG nằm trong `order_count`/doanh thu (giống các báo cáo khác:
 * `report-sql.ts` loại đơn `cancelled` khỏi mọi số tiền).
 */
async function queryBusiness(p: DashboardParams, from: Date, to: Date) {
  const rows = await p.prisma.$queryRaw<BusinessRaw[]>`
    SELECT
      COUNT(*) FILTER (WHERE o."status" <> 'cancelled')                    AS order_count,
      COUNT(*) FILTER (WHERE o."status" = 'cancelled')                     AS cancelled_count,
      COUNT(*) FILTER (WHERE o."status" <> 'cancelled'
                         AND o."financial_status" IN ('pending', 'partially_paid'))
                                                                           AS unpaid_count,
      COUNT(*) FILTER (WHERE o."status" <> 'cancelled'
                         AND o."fulfillment_status" IS NULL)               AS unfulfilled_count,
      COUNT(*) FILTER (WHERE o."status" <> 'cancelled' AND EXISTS (
                         SELECT 1 FROM "fulfillments" f
                         WHERE f."order_id" = o."id" AND f."status" = 'success'
                           AND f."shipment_status" IN ('picked_up', 'delivering', 'retry_delivery')
                       ))                                                  AS shipping_count,
      SUM(o."total_price") FILTER (WHERE o."status" <> 'cancelled')        AS total_price,
      SUM(COALESCE(o."total_refunded", 0)) FILTER (WHERE o."status" <> 'cancelled')
                                                                           AS total_refunded
    FROM "orders" o
    WHERE ${orderScope(p, from, to)}
  `;
  const r = rows[0];
  const orderCount = Number(r?.order_count ?? 0);
  const netRevenue = num(r?.total_price) - num(r?.total_refunded);
  return {
    orderCount,
    cancelledCount: Number(r?.cancelled_count ?? 0),
    unpaidCount: Number(r?.unpaid_count ?? 0),
    unfulfilledCount: Number(r?.unfulfilled_count ?? 0),
    shippingCount: Number(r?.shipping_count ?? 0),
    netRevenue,
    avgOrderValue: orderCount > 0 ? Math.round(netRevenue / orderCount) : 0,
  };
}

/** SL hàng thực bán — phải xuống cấp dòng hàng, xem ghi chú `EFFECTIVE_QTY`. */
async function queryItemsSold(p: DashboardParams, from: Date, to: Date) {
  const rows = await p.prisma.$queryRaw<{ quantity: bigint | number | null }[]>`
    SELECT SUM(COALESCE(oi."current_quantity", oi."quantity")) AS quantity
    FROM "order_items" oi
    JOIN "orders" o ON o."id" = oi."order_id"
    WHERE ${orderScope(p, from, to, Prisma.sql`o."status" <> 'cancelled'`)}
  `;
  return Number(rows[0]?.quantity ?? 0);
}

// --- Biểu đồ doanh thu ---

type SeriesRaw = { idx: number; revenue: Prisma.Decimal | null };

async function queryRevenueSeries(
  p: DashboardParams,
  from: Date,
  to: Date,
  size: number,
) {
  const idx = bucketIdxSql(p.period.bucket, from, Prisma.sql`o."created_on"`);
  const rows = await p.prisma.$queryRaw<SeriesRaw[]>`
    SELECT ${idx} AS idx,
           SUM(o."total_price") - SUM(COALESCE(o."total_refunded", 0)) AS revenue
    FROM "orders" o
    WHERE ${orderScope(p, from, to, Prisma.sql`o."status" <> 'cancelled'`)}
    GROUP BY 1
  `;
  const series = new Array<number>(size).fill(0);
  for (const r of rows) {
    const i = Number(r.idx);
    if (i >= 0 && i < size) series[i] = num(r.revenue);
  }
  return series;
}

// --- Thống kê truy cập ---

type TrafficRaw = {
  sessions: bigint | number;
  buyers: bigint | number;
  returning_buyers: bigint | number;
};

/**
 * Một "phiên tương tác" = một hội thoại CSKH có ít nhất một tin nhắn trong kỳ; "khách quay
 * lại" = khách mua trong kỳ mà TRƯỚC kỳ đã từng có đơn không hủy. Hai vế đếm độc lập nhau
 * nên gộp bằng CROSS JOIN thay vì join theo khoá — không có khoá chung nào để join.
 */
async function queryTraffic(p: DashboardParams, from: Date, to: Date) {
  const rows = await p.prisma.$queryRaw<TrafficRaw[]>`
    WITH sess AS (
      SELECT COUNT(DISTINCT cm."conversation_id") AS total
      FROM "conversation_messages" cm
      WHERE cm."created_at" >= ${from} AND cm."created_at" < ${to}
    ),
    buyers AS (
      SELECT DISTINCT o."customer_id" AS customer_id
      FROM "orders" o
      WHERE ${orderScope(
        p,
        from,
        to,
        Prisma.sql`o."status" <> 'cancelled' AND o."customer_id" IS NOT NULL`,
      )}
    )
    SELECT (SELECT total FROM sess) AS sessions,
           COUNT(*)                 AS buyers,
           COUNT(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM "orders" o2
             WHERE o2."customer_id" = b.customer_id
               AND o2."status" <> 'cancelled'
               AND o2."created_on" < ${from}
           ))                       AS returning_buyers
    FROM buyers b
  `;
  const r = rows[0];
  const buyers = Number(r?.buyers ?? 0);
  return {
    sessions: Number(r?.sessions ?? 0),
    buyers,
    returningRate: rate(Number(r?.returning_buyers ?? 0), buyers),
  };
}

/** Chuỗi sparkline cho hai chỉ số đếm được theo ô thời gian. */
async function queryTrafficSeries(p: DashboardParams, size: number) {
  const { from, to, bucket } = p.period;
  const [sessionRows, buyerRows] = await Promise.all([
    p.prisma.$queryRaw<{ idx: number; total: bigint | number }[]>`
      SELECT ${bucketIdxSql(bucket, from, Prisma.sql`cm."created_at"`)} AS idx,
             COUNT(DISTINCT cm."conversation_id") AS total
      FROM "conversation_messages" cm
      WHERE cm."created_at" >= ${from} AND cm."created_at" < ${to}
      GROUP BY 1
    `,
    p.prisma.$queryRaw<{ idx: number; total: bigint | number }[]>`
      SELECT ${bucketIdxSql(bucket, from, Prisma.sql`o."created_on"`)} AS idx,
             COUNT(DISTINCT o."customer_id") AS total
      FROM "orders" o
      WHERE ${orderScope(p, from, to, Prisma.sql`o."status" <> 'cancelled'`)}
      GROUP BY 1
    `,
  ]);

  const fill = (rows: { idx: number; total: bigint | number }[]) => {
    const out = new Array<number>(size).fill(0);
    for (const r of rows) {
      const i = Number(r.idx);
      if (i >= 0 && i < size) out[i] = Number(r.total);
    }
    return out;
  };
  return { sessions: fill(sessionRows), buyers: fill(buyerRows) };
}

// --- Sản phẩm bán chạy ---

type TopProductRaw = {
  variant_id: bigint;
  product_id: bigint | null;
  name: string;
  sku: string;
  quantity: bigint | number;
  revenue: Prisma.Decimal | null;
};

/**
 * Gom theo `variant_id`, KHÔNG gom kèm `oi."name"`/`oi."sku"`: hai cột đó là bản chụp lúc
 * bán, cùng một phiên bản có thể mang nhiều tên qua các đợt đổi tên sản phẩm (đo trên dữ
 * liệu thật: phiên bản 3977 có 4 tên khác nhau). Gom kèm chúng là xé một sản phẩm thành
 * nhiều dòng, mỗi dòng một phần số lượng — hàng bán chạy nhất có thể vì thế mà rớt khỏi top.
 *
 * Tên/SKU hiển thị lấy bản chụp MỚI NHẤT, không lấy tên hiện tại của sản phẩm: bản chụp
 * mang đúng tên phiên bản người bán đã dùng, còn `products.name` chỉ có tên sản phẩm cha.
 */
async function queryTopProducts(p: DashboardParams, from: Date, to: Date) {
  const recent = Prisma.sql`ORDER BY o."created_on" DESC, oi."id" DESC`;
  const rows = await p.prisma.$queryRaw<TopProductRaw[]>`
    SELECT oi."variant_id"                                     AS variant_id,
           v."product_id"                                      AS product_id,
           (ARRAY_AGG(oi."name" ${recent}))[1]                 AS name,
           (ARRAY_AGG(oi."sku" ${recent}))[1]                  AS sku,
           SUM(COALESCE(oi."current_quantity", oi."quantity")) AS quantity,
           SUM(oi."discounted_total")                          AS revenue
    FROM "order_items" oi
    JOIN "orders" o                ON o."id" = oi."order_id"
    LEFT JOIN "product_variants" v ON v."id" = oi."variant_id"
    WHERE ${orderScope(p, from, to, Prisma.sql`o."status" <> 'cancelled'`)}
    GROUP BY oi."variant_id", v."product_id"
    HAVING SUM(COALESCE(oi."current_quantity", oi."quantity")) > 0
    ORDER BY quantity DESC, revenue DESC
    LIMIT ${p.topLimit}
  `;
  return rows.map((r) => ({
    variant_id: r.variant_id?.toString() ?? null,
    product_id: r.product_id?.toString() ?? null,
    name: r.name,
    sku: r.sku,
    quantity: Number(r.quantity),
    revenue: num(r.revenue),
  }));
}

// --- Tỉ lệ chuyển đổi ---

type FunnelRaw = {
  total: bigint | number;
  active: bigint | number;
  confirmed: bigint | number;
  paid: bigint | number;
  fulfilled: bigint | number;
};

/**
 * Phễu đơn hàng. Mẫu số là TỔNG đơn phát sinh trong kỳ, kể cả đơn hủy — đó là điểm khác
 * mọi khối còn lại của màn (chỗ khác luôn loại `cancelled`), và cũng là lý do mọi tỉ lệ ở
 * đây luôn ≤ 100%: mỗi bước là một tập con của cùng tập đơn đó.
 */
async function queryFunnel(p: DashboardParams, from: Date, to: Date) {
  const rows = await p.prisma.$queryRaw<FunnelRaw[]>`
    SELECT COUNT(*)                                                     AS total,
           COUNT(*) FILTER (WHERE o."status" <> 'cancelled')             AS active,
           COUNT(*) FILTER (WHERE o."status" <> 'cancelled'
                              AND o."confirmed_on" IS NOT NULL)          AS confirmed,
           COUNT(*) FILTER (WHERE o."status" <> 'cancelled'
                              AND o."financial_status" = 'paid')         AS paid,
           COUNT(*) FILTER (WHERE o."status" <> 'cancelled'
                              AND o."fulfillment_status" = 'fulfilled')  AS fulfilled
    FROM "orders" o
    WHERE ${orderScope(p, from, to)}
  `;
  const r = rows[0];
  return {
    total: Number(r?.total ?? 0),
    active: Number(r?.active ?? 0),
    confirmed: Number(r?.confirmed ?? 0),
    paid: Number(r?.paid ?? 0),
    fulfilled: Number(r?.fulfilled ?? 0),
  };
}

// --- Nhật ký hoạt động ---

/**
 * `AuditInterceptor` ghi MỌI request ghi vào `activity_logs` với `entity_type='http_request'`
 * — loại ra, nếu không nhật ký chỉ toàn dòng "POST /orders" không đọc được.
 *
 * Sắp theo `id` chứ không phải `created_at`: id tăng dần đồng biến với thời gian, và đi
 * ngược index khoá chính thì Postgres dừng ngay sau khi đủ số dòng, không phải sort cả bảng.
 */
async function queryActivityLog(p: DashboardParams) {
  const rows = await p.prisma.activityLog.findMany({
    where: { entityType: { not: 'http_request' } },
    take: p.activityLimit,
    orderBy: { id: 'desc' },
    include: {
      user: { select: { firstName: true, lastName: true, email: true } },
    },
  });
  return rows.map((entry) => {
    const metadata = (entry.metadata ?? {}) as Record<string, unknown>;
    const name = [entry.user?.firstName, entry.user?.lastName]
      .filter(Boolean)
      .join(' ')
      .trim();
    return {
      id: entry.id.toString(),
      action: entry.action,
      action_label: ACTIVITY_ACTION_LABELS[entry.action] ?? entry.action,
      actor_name: name || entry.user?.email || 'Hệ thống',
      entity_type: entry.entityType,
      entity_id: entry.entityId?.toString() ?? null,
      reference_code: typeof metadata.code === 'string' ? metadata.code : null,
      amount: typeof metadata.amount === 'number' ? metadata.amount : null,
      created_at: entry.createdAt.toISOString(),
    };
  });
}

// --- Ghép màn ---

export async function runDashboardOverview(p: DashboardParams) {
  const { period } = p;
  const labels = bucketLabels(period);
  const size = labels.length;

  const [
    business,
    prevBusiness,
    itemsSold,
    prevItemsSold,
    currentSeries,
    previousSeries,
    traffic,
    prevTraffic,
    trafficSeries,
    topProducts,
    funnel,
    prevFunnel,
    activityLog,
  ] = await Promise.all([
    queryBusiness(p, period.from, period.to),
    queryBusiness(p, period.prevFrom, period.prevTo),
    queryItemsSold(p, period.from, period.to),
    queryItemsSold(p, period.prevFrom, period.prevTo),
    queryRevenueSeries(p, period.from, period.to, size),
    queryRevenueSeries(p, period.prevFrom, period.prevTo, size),
    queryTraffic(p, period.from, period.to),
    queryTraffic(p, period.prevFrom, period.prevTo),
    queryTrafficSeries(p, size),
    queryTopProducts(p, period.from, period.to),
    queryFunnel(p, period.from, period.to),
    queryFunnel(p, period.prevFrom, period.prevTo),
    queryActivityLog(p),
  ]);

  const conversion = rate(funnel.active, funnel.total);
  const prevConversion = rate(prevFunnel.active, prevFunnel.total);

  return {
    period: {
      range: period.range,
      bucket: period.bucket,
      from: ymd(period.from),
      to: ymd(new Date(period.to.getTime() - 1)),
      prev_from: ymd(period.prevFrom),
      prev_to: ymd(new Date(period.prevTo.getTime() - 1)),
    },
    business_results: {
      net_revenue: metric(business.netRevenue, prevBusiness.netRevenue),
      order_count: metric(business.orderCount, prevBusiness.orderCount),
      unpaid_count: metric(business.unpaidCount, prevBusiness.unpaidCount),
      avg_order_value: metric(
        business.avgOrderValue,
        prevBusiness.avgOrderValue,
      ),
      items_sold: metric(itemsSold, prevItemsSold),
      unfulfilled_count: metric(
        business.unfulfilledCount,
        prevBusiness.unfulfilledCount,
      ),
      shipping_count: metric(
        business.shippingCount,
        prevBusiness.shippingCount,
      ),
      cancelled_count: metric(
        business.cancelledCount,
        prevBusiness.cancelledCount,
      ),
    },
    revenue_chart: {
      labels,
      current: currentSeries,
      previous: previousSeries,
    },
    traffic: {
      sessions: {
        ...metric(traffic.sessions, prevTraffic.sessions),
        series: trafficSeries.sessions,
      },
      buyers: {
        ...metric(traffic.buyers, prevTraffic.buyers),
        series: trafficSeries.buyers,
      },
      returning_rate: {
        ...metric(traffic.returningRate, prevTraffic.returningRate),
        series: [],
      },
    },
    top_products: topProducts,
    conversion: {
      order_conversion_rate: metric(conversion, prevConversion),
      total_orders: funnel.total,
      steps: [
        {
          key: 'confirmed',
          label: 'Tỷ lệ xác nhận đơn',
          value: funnel.confirmed,
          rate: rate(funnel.confirmed, funnel.total),
        },
        {
          key: 'paid',
          label: 'Tỷ lệ thu đủ tiền',
          value: funnel.paid,
          rate: rate(funnel.paid, funnel.total),
        },
        {
          key: 'fulfilled',
          label: 'Tỷ lệ giao hàng thành công',
          value: funnel.fulfilled,
          rate: rate(funnel.fulfilled, funnel.total),
        },
      ],
    },
    activity_log: activityLog,
  };
}
