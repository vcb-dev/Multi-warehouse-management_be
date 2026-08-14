import { PrismaService } from '../../prisma/prisma.service';

/**
 * Customer.id "mua lại": SĐT (sau khi chuẩn hoá — bỏ ký tự không phải số, quy
 * `84xxxxxxxxx` (11 số) về `0xxxxxxxxx`, thêm `0` nếu thiếu số đầu) xuất hiện
 * trên từ 2 đơn hàng trở lên. So khớp theo SĐT (orders.phone) thay vì customer_id
 * vì cùng một khách có thể phát sinh nhiều bản ghi Customer khác nhau khi đồng bộ.
 */
export async function findRepeatCustomerIds(
  prisma: PrismaService,
): Promise<bigint[]> {
  const rows = await prisma.$queryRaw<{ id: bigint }[]>`
    WITH repeat_keys AS (
      SELECT
        CASE
          WHEN regexp_replace(o.phone, '\D', '', 'g') LIKE '84%'
           AND length(regexp_replace(o.phone, '\D', '', 'g')) = 11
            THEN '0' || right(regexp_replace(o.phone, '\D', '', 'g'), 9)
          WHEN length(regexp_replace(o.phone, '\D', '', 'g')) = 9
            THEN '0' || regexp_replace(o.phone, '\D', '', 'g')
          ELSE regexp_replace(o.phone, '\D', '', 'g')
        END AS phone_key
      FROM orders o
      WHERE o.phone IS NOT NULL AND btrim(o.phone) <> ''
      GROUP BY phone_key
      HAVING count(*) > 1
    )
    SELECT c.id
    FROM customers c
    WHERE c.phone IS NOT NULL AND btrim(c.phone) <> ''
      AND (
        CASE
          WHEN regexp_replace(c.phone, '\D', '', 'g') LIKE '84%'
           AND length(regexp_replace(c.phone, '\D', '', 'g')) = 11
            THEN '0' || right(regexp_replace(c.phone, '\D', '', 'g'), 9)
          WHEN length(regexp_replace(c.phone, '\D', '', 'g')) = 9
            THEN '0' || regexp_replace(c.phone, '\D', '', 'g')
          ELSE regexp_replace(c.phone, '\D', '', 'g')
        END
      ) IN (SELECT phone_key FROM repeat_keys)
  `;
  return rows.map((r) => r.id);
}
