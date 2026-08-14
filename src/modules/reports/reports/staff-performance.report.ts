import { Prisma } from '@prisma/client';
import {
  ReportColumn,
  ReportContext,
  ReportDef,
  ReportResult,
  ReportRow,
} from '../report.types';

/**
 * Báo cáo "Hiệu suất nhân viên" — không nằm trong catalog Sapo, tự thêm theo yêu cầu nội
 * bộ: mỗi nhân viên chốt được bao nhiêu đơn, tiếp nhận bao nhiêu khách.
 *
 * Hai nguồn khách tách biệt vì không cùng bảng và không cùng ý nghĩa:
 * - `customers_ordered`: khách phân biệt trong các đơn nhân viên đó chốt (orders.assignee_id).
 * - `customers_received`: khách phân biệt trong hội thoại CSKH được gán cho nhân viên đó
 *   (conversations.assigned_to) — tính cả khách nhắn đến nhưng chưa lên đơn, dedupe theo
 *   customer_id nếu đã gắn, không thì theo số điện thoại (luôn có, conversations không bắt
 *   buộc phải link sẵn customer).
 *
 * "Chốt" dùng cùng quy tắc với báo cáo doanh thu: mọi đơn KHÔNG huỷ (xem report-sql.ts) —
 * `status='closed'` gần như không được set trong data Sapo thật nên không dùng làm điều kiện.
 * Conversations không có location_id nên nhánh CSKH không lọc theo kho.
 */

const COLUMNS: ReportColumn[] = [
  { key: 'label', label: 'Nhân viên', type: 'text' },
  {
    key: 'orders_closed',
    label: 'Đơn đã chốt',
    type: 'number',
    summable: true,
  },
  {
    key: 'customers_ordered',
    label: 'Khách đã chốt đơn',
    type: 'number',
    summable: true,
  },
  {
    key: 'customers_received',
    label: 'Khách tiếp nhận (CSKH)',
    type: 'number',
    summable: true,
  },
];

type RawRow = {
  staff_id: bigint;
  label: string | null;
  orders_closed: bigint | number;
  customers_ordered: bigint | number;
  customers_received: bigint | number;
};

function toRow(r: RawRow): ReportRow {
  return {
    label: r.label ?? '(Chưa đặt tên)',
    orders_closed: Number(r.orders_closed),
    customers_ordered: Number(r.customers_ordered),
    customers_received: Number(r.customers_received),
  };
}

function sumRows(rows: ReportRow[]): ReportRow {
  const summary: ReportRow = { label: 'Tổng cộng' };
  for (const col of COLUMNS) {
    if (!col.summable) continue;
    summary[col.key] = rows.reduce((s, r) => s + Number(r[col.key] ?? 0), 0);
  }
  return summary;
}

async function run(ctx: ReportContext): Promise<ReportResult> {
  const staffFilter =
    ctx.staffId != null
      ? Prisma.sql`AND o."assignee_id" = ${ctx.staffId}`
      : Prisma.empty;
  const staffFilterConv =
    ctx.staffId != null
      ? Prisma.sql`AND c."assigned_to" = ${ctx.staffId}`
      : Prisma.empty;

  const rows = await ctx.prisma.$queryRaw<RawRow[]>`
    WITH order_stats AS (
      SELECT o."assignee_id"                      AS staff_id,
             COUNT(*)                              AS orders_closed,
             COUNT(DISTINCT o."customer_id")        AS customers_ordered
      FROM "orders" o
      WHERE o."status" <> 'cancelled'
        AND o."created_on" >= ${ctx.from}
        AND o."created_on" < ${ctx.to}
        AND o."location_id" IN (${Prisma.join(ctx.locationIds)})
        AND o."assignee_id" IS NOT NULL
        ${staffFilter}
      GROUP BY o."assignee_id"
    ),
    conversation_stats AS (
      SELECT c."assigned_to"                                                    AS staff_id,
             COUNT(DISTINCT COALESCE(c."customer_id"::text, c."customer_phone")) AS customers_received
      FROM "conversations" c
      WHERE c."created_at" >= ${ctx.from}
        AND c."created_at" < ${ctx.to}
        AND c."assigned_to" IS NOT NULL
        ${staffFilterConv}
      GROUP BY c."assigned_to"
    )
    SELECT u."id"                                                                       AS staff_id,
           COALESCE(NULLIF(TRIM(CONCAT_WS(' ', u."first_name", u."last_name")), ''), u."email") AS label,
           COALESCE(os.orders_closed, 0)       AS orders_closed,
           COALESCE(os.customers_ordered, 0)   AS customers_ordered,
           COALESCE(cs.customers_received, 0)  AS customers_received
    FROM "users" u
    LEFT JOIN order_stats os ON os.staff_id = u."id"
    LEFT JOIN conversation_stats cs ON cs.staff_id = u."id"
    WHERE os.staff_id IS NOT NULL OR cs.staff_id IS NOT NULL
    ORDER BY orders_closed DESC, customers_received DESC
  `;

  const all = rows.map(toRow);
  const summary = sumRows(all);
  const paged = ctx.all
    ? all
    : all.slice((ctx.page - 1) * ctx.pageSize, ctx.page * ctx.pageSize);
  return { rows: paged, summary, total: all.length };
}

export const STAFF_PERFORMANCE_REPORTS: ReportDef[] = [
  {
    id: 'staff-performance',
    group: 'nhan_vien',
    name: 'Hiệu suất nhân viên',
    description:
      'Mỗi nhân viên chốt được bao nhiêu đơn và tiếp nhận bao nhiêu khách trong kỳ.',
    filters: ['date_range', 'location', 'staff'],
    columns: COLUMNS,
    chart: {
      type: 'bar',
      x: 'label',
      y: ['orders_closed', 'customers_received'],
    },
    note: 'Đơn "chốt" là mọi đơn không huỷ nhân viên phụ trách (assignee), không lọc theo status=closed vì Sapo hầu như không dùng trạng thái này. Khách "tiếp nhận" tính theo hội thoại CSKH được gán, không phụ thuộc kho.',
    run,
  },
];
