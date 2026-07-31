import { Prisma } from '@prisma/client';
import { ReportContext, TimeBucket } from '../report.types';

/**
 * Mảnh SQL dùng chung cho mọi báo cáo. Gom vào một chỗ để ba quy tắc tính số dễ sai
 * (ghi trong docs/sapo-schema-mapping.md) chỉ phải viết đúng một lần.
 */

/** Decimal/null của Prisma → number, để cộng dồn ở tầng JS. */
export function num(v: Prisma.Decimal | number | null | undefined): number {
  if (v == null) return 0;
  return typeof v === 'number' ? v : Number(v);
}

/** Gom nhóm theo thời gian, trả về nhãn đã format sẵn cho trục X. */
export function bucketExpr(bucket: TimeBucket): Prisma.Sql {
  switch (bucket) {
    case 'month':
      return Prisma.sql`TO_CHAR(DATE_TRUNC('month', o."created_on"), 'MM/YYYY')`;
    case 'week':
      return Prisma.sql`TO_CHAR(DATE_TRUNC('week', o."created_on"), 'IYYY-"W"IW')`;
    default:
      return Prisma.sql`TO_CHAR(DATE_TRUNC('day', o."created_on"), 'DD/MM/YYYY')`;
  }
}

/**
 * Điều kiện lọc chung cho các báo cáo dựa trên `orders` (alias `o`).
 *
 * Hai điểm bắt buộc đúng:
 * - **Loại đơn huỷ**: doanh thu không được tính đơn `cancelled`.
 * - **KHÔNG lọc `status='closed'`**: Sapo gần như không đóng đơn (1.144/87.911 đơn thật),
 *   lọc theo đó sẽ mất gần hết doanh thu. Mọi đơn chưa huỷ đều tính.
 */
export function orderScopeSql(ctx: ReportContext): Prisma.Sql {
  const conditions: Prisma.Sql[] = [
    Prisma.sql`o."status" <> 'cancelled'`,
    Prisma.sql`o."created_on" >= ${ctx.from}`,
    Prisma.sql`o."created_on" < ${ctx.to}`,
    Prisma.sql`o."location_id" IN (${Prisma.join(ctx.locationIds)})`,
  ];
  if (ctx.channel) {
    conditions.push(Prisma.sql`o."source_name" = ${ctx.channel}`);
  }
  if (ctx.staffId != null) {
    conditions.push(Prisma.sql`o."assignee_id" = ${ctx.staffId}`);
  }
  return Prisma.join(conditions, ' AND ');
}

/**
 * Số lượng thực bán của một dòng hàng. Sapo tính `subtotal_line_items_quantity` từ
 * `current_quantity` (đã trừ dòng huỷ/hoàn), không phải `quantity` gốc — dùng sai lệch
 * ~7.900 đơn trên dữ liệu thật.
 */
export const EFFECTIVE_QTY = Prisma.sql`COALESCE(oi."current_quantity", oi."quantity")`;

/**
 * Giá vốn một đơn vị: ưu tiên snapshot chốt lúc bán, thiếu thì lấy giá vốn hiện tại của
 * phiên bản (đơn tạo trước khi có cột `order_items.cost_price`).
 */
export const UNIT_COST = Prisma.sql`COALESCE(oi."cost_price", v."cost", 0)`;
