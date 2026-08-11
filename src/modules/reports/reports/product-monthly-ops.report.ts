import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { num } from './report-sql';

/**
 * Dashboard "Sản phẩm — Vận hành theo tháng". Không dùng khung `ReportDef` chung (bảng đơn +
 * dòng tổng) vì màn này gồm nhiều khối khác hình dạng (thẻ KPI, 2 bảng, nhóm chỉ số phụ) —
 * mỗi khối là một câu query riêng, gom lại ở đây.
 *
 * Quy ước áp dụng xuyên suốt (không có ở Sapo, chọn cho nhất quán):
 * - "Lên đơn" = có dòng hàng trên đơn KHÔNG huỷ, tính theo `orders.created_on`.
 * - "Xuất hàng" = có phiếu giao (`fulfillments.status = 'success'`), tính theo
 *   `fulfillments.created_on` (mốc duy nhất luôn có giá trị; `issued_on`/`shipment_created_on`
 *   nullable nên dùng sẽ bỏ sót phiếu).
 * - "Thiếu hàng" = nhu cầu (số lượng trên đơn trong tháng CHƯA giao xong: fulfillment_status
 *   null hoặc partial) vượt quá tồn khả dụng HIỆN TẠI — tồn không có lịch sử theo ngày nên
 *   không thể tính "khả dụng tại thời điểm trong tháng".
 */

export type ProductMonthlyOpsParams = {
  prisma: PrismaService;
  from: Date;
  to: Date;
  prevFrom: Date;
  locationIds: bigint[];
  categoryId?: bigint;
  topLimit: number;
};

function pctChange(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/**
 * `EXISTS (...)` lọc theo danh mục — dùng subquery thay vì JOIN để không nhân dòng khi tính
 * SUM/COUNT. Mọi query gọi hàm này đều join bảng products với alias `p`.
 */
function categoryExistsSql(categoryId: bigint | undefined): Prisma.Sql {
  if (categoryId == null) return Prisma.empty;
  return Prisma.sql`AND EXISTS (
    SELECT 1 FROM "product_categories" pc
    WHERE pc."product_id" = p."id" AND pc."category_id" = ${categoryId}
  )`;
}

// --- KPI: SP lên đơn trong tháng ---

type OrderedRaw = {
  current_count: bigint | number;
  previous_count: bigint | number;
};

async function queryProductsOrdered(p: ProductMonthlyOpsParams) {
  const rows = await p.prisma.$queryRaw<OrderedRaw[]>`
    SELECT
      COUNT(DISTINCT v."product_id") FILTER (WHERE o."created_on" >= ${p.from}) AS current_count,
      COUNT(DISTINCT v."product_id") FILTER (WHERE o."created_on" < ${p.from})  AS previous_count
    FROM "order_items" oi
    JOIN "orders" o           ON o."id" = oi."order_id"
    JOIN "product_variants" v ON v."id" = oi."variant_id"
    JOIN "products" p         ON p."id" = v."product_id"
    WHERE o."status" <> 'cancelled'
      AND o."created_on" >= ${p.prevFrom} AND o."created_on" < ${p.to}
      AND o."location_id" IN (${Prisma.join(p.locationIds)})
      ${categoryExistsSql(p.categoryId)}
  `;
  const r = rows[0];
  return {
    current: Number(r?.current_count ?? 0),
    previous: Number(r?.previous_count ?? 0),
  };
}

// --- KPI: SP đã xuất hàng ---

async function queryProductsShipped(p: ProductMonthlyOpsParams) {
  const rows = await p.prisma.$queryRaw<OrderedRaw[]>`
    SELECT
      COUNT(DISTINCT v."product_id") FILTER (WHERE f."created_on" >= ${p.from}) AS current_count,
      COUNT(DISTINCT v."product_id") FILTER (WHERE f."created_on" < ${p.from})  AS previous_count
    FROM "fulfillment_line_items" fli
    JOIN "fulfillments" f     ON f."id" = fli."fulfillment_id"
    JOIN "orders" o           ON o."id" = f."order_id"
    JOIN "product_variants" v ON v."id" = fli."variant_id"
    JOIN "products" p         ON p."id" = v."product_id"
    WHERE f."status" = 'success'
      AND f."created_on" >= ${p.prevFrom} AND f."created_on" < ${p.to}
      AND o."location_id" IN (${Prisma.join(p.locationIds)})
      ${categoryExistsSql(p.categoryId)}
  `;
  const r = rows[0];
  return {
    current: Number(r?.current_count ?? 0),
    previous: Number(r?.previous_count ?? 0),
  };
}

// --- SP thiếu hàng khi lên đơn ---

type ShortageRaw = {
  variant_id: bigint;
  sku: string;
  product_name: string;
  demand_qty: bigint | number;
  stuck_orders: bigint | number;
  available_qty: bigint | number;
};

async function queryOutOfStock(p: ProductMonthlyOpsParams) {
  const rows = await p.prisma.$queryRaw<ShortageRaw[]>`
    WITH demand AS (
      SELECT v."id" AS variant_id, v."sku" AS sku, p."name" AS product_name,
             SUM(COALESCE(oi."current_quantity", oi."quantity")) AS demand_qty,
             COUNT(DISTINCT o."id") AS stuck_orders
      FROM "order_items" oi
      JOIN "orders" o           ON o."id" = oi."order_id"
      JOIN "product_variants" v ON v."id" = oi."variant_id"
      JOIN "products" p         ON p."id" = v."product_id"
      WHERE o."status" <> 'cancelled'
        AND o."created_on" >= ${p.from} AND o."created_on" < ${p.to}
        AND o."location_id" IN (${Prisma.join(p.locationIds)})
        AND (o."fulfillment_status" IS NULL OR o."fulfillment_status" = 'partial')
        ${categoryExistsSql(p.categoryId)}
      GROUP BY v."id", v."sku", p."name"
    ),
    avail AS (
      SELECT "variant_id", SUM("available") AS available_qty
      FROM "inventory_levels"
      WHERE "location_id" IN (${Prisma.join(p.locationIds)})
      GROUP BY "variant_id"
    )
    SELECT d.variant_id, d.sku, d.product_name, d.demand_qty, d.stuck_orders,
           COALESCE(a.available_qty, 0) AS available_qty
    FROM demand d
    LEFT JOIN avail a ON a."variant_id" = d.variant_id
    WHERE COALESCE(a.available_qty, 0) - d.demand_qty < 0
    ORDER BY (COALESCE(a.available_qty, 0) - d.demand_qty) ASC
  `;

  const items = rows.map((r) => ({
    variant_id: r.variant_id.toString(),
    sku: r.sku,
    product_name: r.product_name,
    shortage: Number(r.available_qty) - Number(r.demand_qty),
    available: Number(r.available_qty),
    stuck_orders: Number(r.stuck_orders),
  }));

  let totalStuckOrders = 0;
  if (items.length) {
    const variantIds = rows.map((r) => r.variant_id);
    const stuck = await p.prisma.$queryRaw<{ total: bigint | number }[]>`
      SELECT COUNT(DISTINCT o."id") AS total
      FROM "order_items" oi
      JOIN "orders" o ON o."id" = oi."order_id"
      WHERE oi."variant_id" IN (${Prisma.join(variantIds)})
        AND o."status" <> 'cancelled'
        AND o."created_on" >= ${p.from} AND o."created_on" < ${p.to}
        AND o."location_id" IN (${Prisma.join(p.locationIds)})
        AND (o."fulfillment_status" IS NULL OR o."fulfillment_status" = 'partial')
    `;
    totalStuckOrders = Number(stuck[0]?.total ?? 0);
  }

  return {
    items,
    summary: { count: items.length, total_stuck_orders: totalStuckOrders },
  };
}

// --- Top sản phẩm được order nhiều nhất ---

type TopOrderedRaw = {
  product_id: bigint;
  product_name: string;
  category_name: string | null;
  order_count: bigint | number;
  quantity: bigint | number;
  prev_order_count: bigint | number;
};

async function queryTopOrderedProducts(p: ProductMonthlyOpsParams) {
  const rows = await p.prisma.$queryRaw<TopOrderedRaw[]>`
    SELECT p."id" AS product_id, p."name" AS product_name,
           (SELECT c."name" FROM "product_categories" pc
              JOIN "categories" c ON c."id" = pc."category_id"
              WHERE pc."product_id" = p."id"
              ORDER BY pc."position" ASC LIMIT 1)            AS category_name,
           COUNT(DISTINCT o."id") FILTER (WHERE o."created_on" >= ${p.from})    AS order_count,
           SUM(COALESCE(oi."current_quantity", oi."quantity"))
             FILTER (WHERE o."created_on" >= ${p.from})                        AS quantity,
           COUNT(DISTINCT o."id") FILTER (WHERE o."created_on" < ${p.from})     AS prev_order_count
    FROM "order_items" oi
    JOIN "orders" o           ON o."id" = oi."order_id"
    JOIN "product_variants" v ON v."id" = oi."variant_id"
    JOIN "products" p         ON p."id" = v."product_id"
    WHERE o."status" <> 'cancelled'
      AND o."created_on" >= ${p.prevFrom} AND o."created_on" < ${p.to}
      AND o."location_id" IN (${Prisma.join(p.locationIds)})
      ${categoryExistsSql(p.categoryId)}
    GROUP BY p."id", p."name"
    HAVING COUNT(DISTINCT o."id") FILTER (WHERE o."created_on" >= ${p.from}) > 0
    ORDER BY order_count DESC, quantity DESC
    LIMIT ${p.topLimit}
  `;

  return rows.map((r) => {
    const orderCount = Number(r.order_count);
    const prevOrderCount = Number(r.prev_order_count);
    return {
      product_id: r.product_id.toString(),
      name: r.product_name,
      category: r.category_name,
      order_count: orderCount,
      quantity: Number(r.quantity),
      change_pct: pctChange(orderCount, prevOrderCount),
    };
  });
}

// --- Chỉ số bổ sung ---

type RevenueRaw = {
  current_revenue: Prisma.Decimal | null;
  previous_revenue: Prisma.Decimal | null;
};

/** Doanh thu tính ở cấp dòng hàng (tiền hàng sau giảm giá) để lọc được theo danh mục —
 * KHÔNG gồm phí vận chuyển/thuế toàn đơn nên khác báo cáo "Doanh thu theo thời gian". */
async function queryRevenue(p: ProductMonthlyOpsParams) {
  const rows = await p.prisma.$queryRaw<RevenueRaw[]>`
    SELECT
      SUM(oi."discounted_total") FILTER (WHERE o."created_on" >= ${p.from}) AS current_revenue,
      SUM(oi."discounted_total") FILTER (WHERE o."created_on" < ${p.from})  AS previous_revenue
    FROM "order_items" oi
    JOIN "orders" o           ON o."id" = oi."order_id"
    JOIN "product_variants" v ON v."id" = oi."variant_id"
    JOIN "products" p         ON p."id" = v."product_id"
    WHERE o."status" <> 'cancelled'
      AND o."created_on" >= ${p.prevFrom} AND o."created_on" < ${p.to}
      AND o."location_id" IN (${Prisma.join(p.locationIds)})
      ${categoryExistsSql(p.categoryId)}
  `;
  const r = rows[0];
  return {
    current: num(r?.current_revenue),
    previous: num(r?.previous_revenue),
  };
}

type CategoryDistRaw = {
  category_name: string | null;
  revenue: Prisma.Decimal | null;
};

/** Bỏ qua bộ lọc danh mục đang chọn — mục đích là so sánh GIỮA các danh mục. */
async function queryCategoryDistribution(p: ProductMonthlyOpsParams) {
  const rows = await p.prisma.$queryRaw<CategoryDistRaw[]>`
    SELECT cat."name" AS category_name, SUM(oi."discounted_total") AS revenue
    FROM "order_items" oi
    JOIN "orders" o           ON o."id" = oi."order_id"
    JOIN "product_variants" v ON v."id" = oi."variant_id"
    JOIN "products" p         ON p."id" = v."product_id"
    LEFT JOIN LATERAL (
      SELECT c."name" FROM "product_categories" pc
        JOIN "categories" c ON c."id" = pc."category_id"
        WHERE pc."product_id" = p."id"
        ORDER BY pc."position" ASC LIMIT 1
    ) cat ON true
    WHERE o."status" <> 'cancelled'
      AND o."created_on" >= ${p.from} AND o."created_on" < ${p.to}
      AND o."location_id" IN (${Prisma.join(p.locationIds)})
    GROUP BY cat."name"
    ORDER BY revenue DESC
  `;
  const total = rows.reduce((s, r) => s + num(r.revenue), 0);
  return rows.map((r) => {
    const revenue = num(r.revenue);
    return {
      category: r.category_name ?? '(Chưa phân loại)',
      revenue,
      pct: total > 0 ? round1((revenue / total) * 100) : 0,
    };
  });
}

async function queryProductsWithoutOrders(
  p: ProductMonthlyOpsParams,
  orderedCount: number,
) {
  // Không lọc theo `status = 'active'`: dữ liệu đồng bộ hiện chỉ có 93/13036 sản phẩm mang
  // status active (phần lớn kẹt ở default "draft"), trong khi hàng nghìn sản phẩm "draft"
  // vẫn phát sinh đơn thật — lọc theo status sẽ khiến chỉ số này sai gần như toàn bộ.
  const rows = await p.prisma.$queryRaw<{ total: bigint | number }[]>`
    SELECT COUNT(*) AS total
    FROM "products" p
    WHERE p."is_discontinued" = false
      ${categoryExistsSql(p.categoryId)}
  `;
  const total = Number(rows[0]?.total ?? 0);
  return Math.max(0, total - orderedCount);
}

async function queryAvgProcessingDays(p: ProductMonthlyOpsParams) {
  const categoryFilter =
    p.categoryId == null
      ? Prisma.empty
      : Prisma.sql`AND EXISTS (
          SELECT 1 FROM "fulfillment_line_items" fli
          JOIN "product_variants" v2 ON v2."id" = fli."variant_id"
          JOIN "product_categories" pc ON pc."product_id" = v2."product_id"
          WHERE fli."fulfillment_id" = f."id" AND pc."category_id" = ${p.categoryId}
        )`;
  const rows = await p.prisma.$queryRaw<{ avg_days: Prisma.Decimal | null }[]>`
    SELECT AVG(EXTRACT(EPOCH FROM (f."created_on" - o."created_on")) / 86400.0) AS avg_days
    FROM "fulfillments" f
    JOIN "orders" o ON o."id" = f."order_id"
    WHERE f."status" = 'success'
      AND f."created_on" >= ${p.from} AND f."created_on" < ${p.to}
      AND o."location_id" IN (${Prisma.join(p.locationIds)})
      ${categoryFilter}
  `;
  return round1(num(rows[0]?.avg_days));
}

async function queryCancelReturnRate(p: ProductMonthlyOpsParams) {
  const categoryFilter =
    p.categoryId == null
      ? Prisma.empty
      : Prisma.sql`AND EXISTS (
          SELECT 1 FROM "order_items" oi
          JOIN "product_variants" v ON v."id" = oi."variant_id"
          JOIN "products" p2 ON p2."id" = v."product_id"
          JOIN "product_categories" pc ON pc."product_id" = p2."id"
          WHERE oi."order_id" = o."id" AND pc."category_id" = ${p.categoryId}
        )`;
  const rows = await p.prisma.$queryRaw<
    { total_orders: bigint | number; cancelled_or_returned: bigint | number }[]
  >`
    SELECT
      COUNT(DISTINCT o."id") AS total_orders,
      COUNT(DISTINCT o."id") FILTER (
        WHERE o."status" = 'cancelled' OR o."return_status" <> 'no_return'
      ) AS cancelled_or_returned
    FROM "orders" o
    WHERE o."created_on" >= ${p.from} AND o."created_on" < ${p.to}
      AND o."location_id" IN (${Prisma.join(p.locationIds)})
      ${categoryFilter}
  `;
  const total = Number(rows[0]?.total_orders ?? 0);
  const bad = Number(rows[0]?.cancelled_or_returned ?? 0);
  return total > 0 ? round1((bad / total) * 100) : 0;
}

export async function runProductMonthlyOps(p: ProductMonthlyOpsParams) {
  const [
    ordered,
    shipped,
    outOfStock,
    topOrderedProducts,
    revenue,
    categoryDistribution,
    avgProcessingDays,
    cancelReturnRate,
  ] = await Promise.all([
    queryProductsOrdered(p),
    queryProductsShipped(p),
    queryOutOfStock(p),
    queryTopOrderedProducts(p),
    queryRevenue(p),
    queryCategoryDistribution(p),
    queryAvgProcessingDays(p),
    queryCancelReturnRate(p),
  ]);

  const productsWithoutOrders = await queryProductsWithoutOrders(
    p,
    ordered.current,
  );

  const shipToOrderRate =
    ordered.current > 0 ? round1((shipped.current / ordered.current) * 100) : 0;

  return {
    kpis: {
      products_ordered: {
        value: ordered.current,
        change_pct: pctChange(ordered.current, ordered.previous),
      },
      products_shipped: {
        value: shipped.current,
        change_pct: pctChange(shipped.current, shipped.previous),
      },
      ship_to_order_rate: { value: shipToOrderRate },
      products_out_of_stock: { value: outOfStock.summary.count },
    },
    top_ordered_products: topOrderedProducts,
    out_of_stock: outOfStock,
    additional_metrics: {
      revenue: {
        value: revenue.current,
        change_pct: pctChange(revenue.current, revenue.previous),
      },
      category_distribution: categoryDistribution,
      products_without_orders: { value: productsWithoutOrders },
      avg_processing_days: { value: avgProcessingDays },
      cancel_return_rate: { value: cancelReturnRate },
    },
  };
}
