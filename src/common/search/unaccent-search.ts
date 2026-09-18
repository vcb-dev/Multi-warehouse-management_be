import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Search không phân biệt dấu tiếng Việt (unaccent) — Prisma's `contains`/`ILIKE`
 * chỉ bỏ qua hoa/thường, không bỏ dấu, nên phải dùng raw SQL với extension
 * `unaccent` của Postgres (bật ở migration `enable_unaccent_extension`).
 */

/**
 * Trần số id trả về mỗi lần tìm.
 *
 * Mọi hàm ở đây đều được dùng theo kiểu `where: { id: { in: ids } }`, mà Prisma
 * dịch `in` thành MỘT bind variable cho mỗi id — Postgres chỉ nhận 32.767 cái
 * trong một prepared statement. Gõ đúng một chữ vào ô tìm khách là vượt trần
 * ("a" khớp 41.550 dòng, "8" khớp 53.031 trên 56k khách), và triệu chứng là API
 * trả 500 ("Không tải được danh sách khách") chứ không phải một danh sách dài.
 *
 * 20k vẫn thừa cho cả trang danh sách (20-50 dòng mỗi trang) lẫn dropdown (20
 * dòng); chỉ những từ khoá một hai ký tự mới bị cắt, và chúng vốn không dùng để
 * tìm ra một khách cụ thể.
 */
const MAX_SEARCH_IDS = 20_000;

/**
 * Phần số của từ khoá sau khi bỏ mọi ký tự không phải số và bỏ đầu số `0`/`84`,
 * `null` nếu từ khoá không đủ số để coi là SĐT.
 *
 * `customers.phone` lưu dạng quốc tế `+84…` (52.025/56.001 dòng, do đồng bộ
 * Sapo) còn người dùng gõ và paste `0…`, nên `ILIKE '%0397679424%'` KHÔNG BAO
 * GIỜ khớp `+84397679424` — trước đây phải tự sửa đầu số thành `84…` mới tìm ra
 * khách đã có, và hậu quả là tạo trùng khách. Cắt đầu số ở cả hai phía rồi mới
 * so thì `0397679424`, `84397679424`, `+84 397 679 424` và `397679424` cùng ra
 * một kết quả.
 *
 * Cố ý KHÔNG đòi đủ 9-10 số: người dùng vừa gõ dở đã muốn thấy khách hiện ra,
 * nên 4 số là đủ (`0397` cũng tìm được), còn ngắn hơn thì để `ILIKE` thường lo.
 */
export function phoneSearchDigits(q: string): string | null {
  const digits = q.replace(/\D/g, '');
  if (digits.length < 4) return null;
  return digits.replace(/^(?:84|0)/, '');
}

/**
 * Điều kiện "cột SĐT khớp phần số của từ khoá", dùng chung cho mọi bảng;
 * `FALSE` khi từ khoá không phải SĐT, để dùng thẳng trong `CASE`.
 *
 * `anchored` = khớp từ đầu số thuê bao (`0397` ra người mang số `0397…` chứ
 * không phải người có `397` lọt giữa số) — dùng để xếp hạng.
 *
 * `'\\D'` phải escape đôi: trong template literal `'\D'` bị JS nuốt backslash,
 * tới Postgres chỉ còn `'D'` (xoá đúng chữ D) nên `+84…` không được chuẩn hoá —
 * cùng cái bẫy đã sửa ở `repeat-customer-search.ts`.
 */
function phoneMatch(
  column: Prisma.Sql,
  digits: string | null,
  anchored = false,
) {
  if (!digits) return Prisma.sql`FALSE`;
  const pattern = anchored ? `${digits}%` : `%${digits}%`;
  return Prisma.sql`regexp_replace(
        regexp_replace(COALESCE(${column}, ''), '\\D', '', 'g'),
        '^(84|0)', ''
      ) LIKE ${pattern}`;
}

/**
 * Product.id khớp tên, nhãn hiệu, SKU hoặc barcode của 1 trong các biến thể.
 * Phải tìm cả `barcode`: đợt import Sapo cũ ghi SKU giả (`SAPO-V-<id>`) và đẩy
 * mã thật xuống `barcode`, nên bỏ cột này là mất hẳn khả năng tìm theo mã hàng.
 */
export async function findProductIdsByQuery(
  prisma: PrismaService,
  q: string,
  limit = MAX_SEARCH_IDS,
): Promise<bigint[]> {
  const pattern = `%${q}%`;
  const rows = await prisma.$queryRaw<{ id: bigint }[]>`
    SELECT DISTINCT p.id
    FROM products p
    LEFT JOIN product_variants v ON v.product_id = p.id
    WHERE unaccent(p.name) ILIKE unaccent(${pattern})
       OR unaccent(COALESCE(p.vendor, '')) ILIKE unaccent(${pattern})
       OR unaccent(v.sku) ILIKE unaccent(${pattern})
       OR unaccent(COALESCE(v.barcode, '')) ILIKE unaccent(${pattern})
    ORDER BY p.id DESC
    LIMIT ${limit}
  `;
  return rows.map((r) => r.id);
}

/** ProductVariant.id khớp SKU/barcode của chính nó hoặc tên sản phẩm */
export async function findVariantIdsByQuery(
  prisma: PrismaService,
  q: string,
  limit = MAX_SEARCH_IDS,
): Promise<bigint[]> {
  const pattern = `%${q}%`;
  const rows = await prisma.$queryRaw<{ id: bigint }[]>`
    SELECT v.id
    FROM product_variants v
    JOIN products p ON p.id = v.product_id
    WHERE unaccent(v.sku) ILIKE unaccent(${pattern})
       OR unaccent(COALESCE(v.barcode, '')) ILIKE unaccent(${pattern})
       OR unaccent(p.name) ILIKE unaccent(${pattern})
    ORDER BY v.id DESC
    LIMIT ${limit}
  `;
  return rows.map((r) => r.id);
}

/** Customer.id khớp họ tên, SĐT (mọi cách viết đầu số), hoặc email */
export async function findCustomerIdsByQuery(
  prisma: PrismaService,
  q: string,
  limit = MAX_SEARCH_IDS,
): Promise<bigint[]> {
  const pattern = `%${q}%`;
  const phone = phoneSearchDigits(q);
  /**
   * Còn một chỗ giữ SĐT nữa là `customer_addresses.phone`: 1.887 khách không có
   * số trên hồ sơ mà chỉ có trên địa chỉ, tìm theo số của họ sẽ ra 0 dòng nếu
   * thiếu nhánh EXISTS này.
   */
  const byPhone = phone
    ? Prisma.sql`
       OR ${phoneMatch(Prisma.sql`c.phone`, phone)}
       OR EXISTS (
            SELECT 1
            FROM customer_addresses a
            WHERE a.customer_id = c.id
              AND ${phoneMatch(Prisma.sql`a.phone`, phone)}
          )`
    : Prisma.empty;
  /**
   * Xếp khớp sát nhất lên trước rồi mới tới khách mới nhất.
   *
   * `LIKE '%…%'` khớp cả giữa một chữ/một số: gõ "Yến Ngọc" ra 335 khách vì
   * unaccent("Ngu-yễn Ngọc Lan") cũng chứa "yen ngoc", gõ "0397" ra cả người
   * mang số `+84984397830`. Dropdown chỉ hiện 20 dòng, nên xếp theo id là đúng
   * người cần tìm nằm ngoài 20 dòng đó — với người dùng thì vẫn là "tìm không
   * ra". Khớp từ đầu số thuê bao xếp trên hết, rồi tới số lọt giữa, rồi tới tên
   * khớp từ đầu một chữ (đầu chuỗi hoặc sau dấu cách).
   */
  const name = Prisma.sql`unaccent(concat_ws(' ', c.first_name, c.last_name))`;
  const rank = Prisma.sql`CASE
        WHEN ${phoneMatch(Prisma.sql`c.phone`, phone, true)} THEN 4
        WHEN ${phoneMatch(Prisma.sql`c.phone`, phone)} THEN 3
        WHEN ${name} ILIKE unaccent(${`${q}%`})
          OR ${name} ILIKE unaccent(${`% ${q}%`}) THEN 2
        ELSE 1
      END`;
  const rows = await prisma.$queryRaw<{ id: bigint }[]>`
    SELECT c.id
    FROM customers c
    WHERE unaccent(COALESCE(c.first_name, '')) ILIKE unaccent(${pattern})
       OR unaccent(COALESCE(c.last_name, '')) ILIKE unaccent(${pattern})
       OR unaccent(COALESCE(c.email, '')) ILIKE unaccent(${pattern})
       OR unaccent(COALESCE(c.phone, '')) ILIKE unaccent(${pattern})
       ${byPhone}
    ORDER BY ${rank} DESC, c.id DESC
    LIMIT ${limit}
  `;
  return rows.map((r) => r.id);
}

/** Supplier.id khớp mã, tên, email, SĐT, hoặc mã số thuế */
export async function findSupplierIdsByQuery(
  prisma: PrismaService,
  q: string,
  limit = MAX_SEARCH_IDS,
): Promise<bigint[]> {
  const pattern = `%${q}%`;
  const phone = phoneSearchDigits(q);
  const byPhone = phone
    ? Prisma.sql`OR ${phoneMatch(Prisma.sql`phone`, phone)}`
    : Prisma.empty;
  const rows = await prisma.$queryRaw<{ id: bigint }[]>`
    SELECT id
    FROM suppliers
    WHERE unaccent(code) ILIKE unaccent(${pattern})
       OR unaccent(name) ILIKE unaccent(${pattern})
       OR unaccent(COALESCE(email, '')) ILIKE unaccent(${pattern})
       OR unaccent(COALESCE(phone, '')) ILIKE unaccent(${pattern})
       OR unaccent(COALESCE(tax_code, '')) ILIKE unaccent(${pattern})
       ${byPhone}
    ORDER BY id DESC
    LIMIT ${limit}
  `;
  return rows.map((r) => r.id);
}

/** Conversation.id khớp tên khách hoặc SĐT */
export async function findConversationIdsByQuery(
  prisma: PrismaService,
  q: string,
  limit = MAX_SEARCH_IDS,
): Promise<bigint[]> {
  const pattern = `%${q}%`;
  const phone = phoneSearchDigits(q);
  const byPhone = phone
    ? Prisma.sql`OR ${phoneMatch(Prisma.sql`customer_phone`, phone)}`
    : Prisma.empty;
  const rows = await prisma.$queryRaw<{ id: bigint }[]>`
    SELECT id
    FROM conversations
    WHERE unaccent(customer_name) ILIKE unaccent(${pattern})
       OR unaccent(customer_phone) ILIKE unaccent(${pattern})
       ${byPhone}
    ORDER BY id DESC
    LIMIT ${limit}
  `;
  return rows.map((r) => r.id);
}

/** Order.id khớp mã đơn, SĐT (mọi cách viết đầu số), hoặc SKU của 1 dòng hàng */
export async function findOrderIdsByQuery(
  prisma: PrismaService,
  q: string,
  limit = MAX_SEARCH_IDS,
): Promise<bigint[]> {
  const pattern = `%${q}%`;
  const phone = phoneSearchDigits(q);
  const byPhone = phone
    ? Prisma.sql`OR ${phoneMatch(Prisma.sql`o.phone`, phone)}`
    : Prisma.empty;
  const rows = await prisma.$queryRaw<{ id: bigint }[]>`
    SELECT DISTINCT o.id
    FROM orders o
    LEFT JOIN order_items oi ON oi.order_id = o.id
    WHERE unaccent(o.name) ILIKE unaccent(${pattern})
       OR unaccent(COALESCE(o.phone, '')) ILIKE unaccent(${pattern})
       OR unaccent(oi.sku) ILIKE unaccent(${pattern})
       ${byPhone}
    ORDER BY o.id DESC
    LIMIT ${limit}
  `;
  return rows.map((r) => r.id);
}
