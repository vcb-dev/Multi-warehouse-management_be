import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { assertLocationAccess, isAdminUser } from '../../common/auth/access';
import { BusinessException } from '../../common/exceptions/business.exception';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CHANNEL_DEFS,
  ChannelKey,
  OTHER_CHANNEL,
  findChannelDef,
} from './channel-source-map';
import { ChannelOverviewQueryDto } from './channel.dto';

/**
 * Số liệu bán hàng theo kênh cho màn "Kênh bán" — tương đương trang Tổng quan của
 * từng sàn bên Sapo (doanh số, số đơn, đơn huỷ, trạng thái đơn).
 *
 * Nguồn số liệu là bảng `orders` nội bộ (đơn đã đồng bộ về), KHÔNG gọi API sàn: sàn chỉ
 * là nơi đơn sinh ra, còn tồn kho/doanh thu đã chốt ở DB này. Nhờ vậy màn hình hiển thị
 * được ngay cả kênh chưa kết nối trực tiếp (Facebook, POS...).
 *
 * Quy ước đếm — bám theo cách Sapo hiển thị (kiểm chứng trên ảnh màn Shopee: 186/428 =
 * 43.457943% đúng bằng "Tỷ lệ huỷ đơn"):
 * - `order_count` đếm CẢ đơn huỷ (là mẫu số của tỷ lệ huỷ).
 * - `revenue`/`quantity` chỉ tính đơn CHƯA huỷ — cùng quy tắc `orderScopeSql` của module
 *   báo cáo, để hai nơi không lệch số.
 */
@Injectable()
export class ChannelOverviewService {
  constructor(private prisma: PrismaService) {}

  async getOverview(query: ChannelOverviewQueryDto, user: AuthUser) {
    const locationIds = await this.resolveLocations(query.location_id, user);
    const { from, toExclusive } = resolveRange(query.from, query.to);

    const selected = query.channel ? findChannelDef(query.channel) : undefined;
    if (query.channel && !selected) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        `Kênh bán không hợp lệ: ${query.channel}`,
        422,
      );
    }

    const scope = scopeSql(from, toExclusive, locationIds, selected?.key);

    const [byChannel, quantities, series, statuses, connections] =
      await Promise.all([
        this.aggregateByChannel(scope),
        this.quantityByChannel(scope),
        this.dailySeries(scope),
        this.statusBreakdown(scope),
        this.prisma.channelConnection.findMany({
          orderBy: { createdAt: 'desc' },
          include: { location: { select: { id: true, name: true } } },
        }),
      ]);

    const qtyByChannel = new Map(quantities.map((q) => [q.channel, Number(q.quantity)]));
    const shopsByChannel = new Map<string, typeof connections>();
    for (const conn of connections) {
      const list = shopsByChannel.get(conn.channel) ?? [];
      list.push(conn);
      shopsByChannel.set(conn.channel, list);
    }

    const statsByChannel = new Map(byChannel.map((r) => [r.channel, r]));
    const defs = selected ? [selected] : [...CHANNEL_DEFS, OTHER_CHANNEL];

    const channels = defs
      .map((def) => {
        const row = statsByChannel.get(def.key);
        const orderCount = Number(row?.order_count ?? 0);
        const cancelled = Number(row?.cancelled_count ?? 0);
        return {
          key: def.key,
          label: def.label,
          connectable: def.connectable,
          order_count: orderCount,
          cancelled_count: cancelled,
          // Không có đơn nào thì tỷ lệ huỷ là 0, không phải NaN
          cancel_rate: orderCount ? cancelled / orderCount : 0,
          quantity: qtyByChannel.get(def.key) ?? 0,
          revenue: Number(row?.revenue ?? 0),
          shops: (shopsByChannel.get(def.key) ?? []).map((c) => ({
            id: c.id.toString(),
            shop_id: c.shopId,
            shop_name: c.shopName,
            connected_at: c.createdAt,
            access_token_expires_at: c.accessTokenExpiresAt,
            location: c.location
              ? { id: c.location.id.toString(), name: c.location.name }
              : null,
          })),
        };
      })
      // Kênh không có đơn lẫn không kết nối được thì ẩn cho đỡ rác, trừ khi user chọn đích danh
      .filter(
        (c) => selected || c.order_count > 0 || c.connectable || c.shops.length > 0,
      );

    const totals = channels.reduce(
      (acc, c) => ({
        order_count: acc.order_count + c.order_count,
        cancelled_count: acc.cancelled_count + c.cancelled_count,
        quantity: acc.quantity + c.quantity,
        revenue: acc.revenue + c.revenue,
      }),
      { order_count: 0, cancelled_count: 0, quantity: 0, revenue: 0 },
    );

    return {
      from,
      to: new Date(toExclusive.getTime() - 1000),
      channel: selected?.key ?? null,
      totals: {
        ...totals,
        cancel_rate: totals.order_count
          ? totals.cancelled_count / totals.order_count
          : 0,
      },
      channels,
      series: series.map((s) => ({
        date: s.day,
        order_count: Number(s.order_count),
        revenue: Number(s.revenue),
      })),
      statuses: statuses.map((s) => ({
        key: s.status_key,
        label: STATUS_LABELS[s.status_key] ?? s.status_key,
        count: Number(s.count),
      })),
    };
  }

  private aggregateByChannel(scope: Prisma.Sql) {
    return this.prisma.$queryRaw<
      { channel: ChannelKey; order_count: bigint; cancelled_count: bigint; revenue: Prisma.Decimal | null }[]
    >`
      SELECT ${CHANNEL_EXPR} AS channel,
             COUNT(*)                                                          AS order_count,
             COUNT(*) FILTER (WHERE o."status" = 'cancelled')                   AS cancelled_count,
             SUM(o."total_price") FILTER (WHERE o."status" <> 'cancelled')      AS revenue
      FROM "orders" o
      WHERE ${scope}
      GROUP BY 1
    `;
  }

  /** Số sản phẩm bán ra — phải xuống dòng hàng nên tách khỏi query đếm đơn. */
  private quantityByChannel(scope: Prisma.Sql) {
    return this.prisma.$queryRaw<{ channel: ChannelKey; quantity: bigint | null }[]>`
      SELECT ${CHANNEL_EXPR} AS channel,
             SUM(COALESCE(oi."current_quantity", oi."quantity")) AS quantity
      FROM "orders" o
      JOIN "order_items" oi ON oi."order_id" = o."id"
      WHERE ${scope} AND o."status" <> 'cancelled'
      GROUP BY 1
    `;
  }

  private dailySeries(scope: Prisma.Sql) {
    return this.prisma.$queryRaw<
      { day: string; order_count: bigint; revenue: Prisma.Decimal | null }[]
    >`
      SELECT TO_CHAR(DATE_TRUNC('day', o."created_on"), 'YYYY-MM-DD')      AS day,
             COUNT(*)                                                     AS order_count,
             SUM(o."total_price") FILTER (WHERE o."status" <> 'cancelled') AS revenue
      FROM "orders" o
      WHERE ${scope}
      GROUP BY 1
      ORDER BY 1
    `;
  }

  /**
   * Chặng xử lý của đơn. Mỗi đơn rơi vào đúng một nhóm (CASE dừng ở nhánh khớp đầu tiên)
   * nên tổng các nhóm = `order_count`.
   */
  private statusBreakdown(scope: Prisma.Sql) {
    return this.prisma.$queryRaw<{ status_key: string; count: bigint }[]>`
      SELECT CASE
               WHEN o."status" = 'cancelled'            THEN 'cancelled'
               WHEN o."fulfillment_status" = 'fulfilled' THEN 'fulfilled'
               WHEN o."fulfillment_status" = 'partial'   THEN 'partial'
               WHEN o."confirmed_on" IS NULL             THEN 'awaiting_confirmation'
               ELSE 'processing'
             END AS status_key,
             COUNT(*) AS count
      FROM "orders" o
      WHERE ${scope}
      GROUP BY 1
    `;
  }

  /** Giống `ReportService.resolveLocations` — admin thấy toàn bộ kho, user thường chỉ kho được gán. */
  private async resolveLocations(
    locationId: string | undefined,
    user: AuthUser,
  ): Promise<bigint[]> {
    if (locationId) {
      const id = BigInt(locationId);
      assertLocationAccess(user, id);
      return [id];
    }
    if (isAdminUser(user)) {
      const all = await this.prisma.location.findMany({ select: { id: true } });
      return all.map((l) => l.id);
    }
    if (!user.locationIds.length) {
      throw new BusinessException(
        'FORBIDDEN_SCOPE',
        'Tài khoản chưa được gán kho nào nên không có dữ liệu kênh bán',
        403,
      );
    }
    return user.locationIds;
  }
}

const STATUS_LABELS: Record<string, string> = {
  awaiting_confirmation: 'Chờ xác nhận',
  processing: 'Chờ xử lý',
  partial: 'Giao một phần',
  fulfilled: 'Đã giao hàng',
  cancelled: 'Đã huỷ',
};

/**
 * `source_name` → khoá kênh, dựng ngay trong SQL để việc gom nhóm nằm ở DB.
 * Sinh từ `CHANNEL_DEFS` nên thêm alias nguồn mới chỉ phải sửa một chỗ.
 */
const CHANNEL_EXPR: Prisma.Sql = Prisma.sql`CASE ${Prisma.join(
  CHANNEL_DEFS.map(
    (def) =>
      Prisma.sql`WHEN LOWER(TRIM(COALESCE(o."source_name", ''))) IN (${Prisma.join(
        def.sources.map((s) => Prisma.sql`${s}`),
      )}) THEN ${def.key}`,
  ),
  ' ',
)} ELSE 'other' END`;

function scopeSql(
  from: Date,
  toExclusive: Date,
  locationIds: bigint[],
  channel?: ChannelKey,
): Prisma.Sql {
  const conditions: Prisma.Sql[] = [
    Prisma.sql`o."created_on" >= ${from}`,
    Prisma.sql`o."created_on" < ${toExclusive}`,
    Prisma.sql`o."location_id" IN (${Prisma.join(locationIds)})`,
  ];
  if (channel) {
    conditions.push(Prisma.sql`${CHANNEL_EXPR} = ${channel}`);
  }
  return Prisma.join(conditions, ' AND ');
}

/** Mặc định 30 ngày gần nhất. `to` là mốc loại trừ nên phải cộng trọn ngày cuối. */
function resolveRange(from?: string, to?: string) {
  const now = new Date();
  const end = to ? new Date(`${to}T00:00:00`) : now;
  const toExclusive = to
    ? new Date(end.getTime() + 24 * 60 * 60 * 1000)
    : new Date(now.getTime() + 1000);
  const start = from
    ? new Date(`${from}T00:00:00`)
    : new Date(toExclusive.getTime() - 30 * 24 * 60 * 60 * 1000);
  return { from: start, toExclusive };
}
