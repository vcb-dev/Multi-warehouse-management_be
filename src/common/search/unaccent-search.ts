import { PrismaService } from '../../prisma/prisma.service';

/**
 * Search không phân biệt dấu tiếng Việt (unaccent) — Prisma's `contains`/`ILIKE`
 * chỉ bỏ qua hoa/thường, không bỏ dấu, nên phải dùng raw SQL với extension
 * `unaccent` của Postgres (bật ở migration `enable_unaccent_extension`).
 */

/**
 * Product.id khớp tên, nhãn hiệu, SKU hoặc barcode của 1 trong các biến thể.
 * Phải tìm cả `barcode`: đợt import Sapo cũ ghi SKU giả (`SAPO-V-<id>`) và đẩy
 * mã thật xuống `barcode`, nên bỏ cột này là mất hẳn khả năng tìm theo mã hàng.
 */
export async function findProductIdsByQuery(
  prisma: PrismaService,
  q: string,
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
  `;
  return rows.map((r) => r.id);
}

/** ProductVariant.id khớp SKU/barcode của chính nó hoặc tên sản phẩm */
export async function findVariantIdsByQuery(
  prisma: PrismaService,
  q: string,
): Promise<bigint[]> {
  const pattern = `%${q}%`;
  const rows = await prisma.$queryRaw<{ id: bigint }[]>`
    SELECT v.id
    FROM product_variants v
    JOIN products p ON p.id = v.product_id
    WHERE unaccent(v.sku) ILIKE unaccent(${pattern})
       OR unaccent(COALESCE(v.barcode, '')) ILIKE unaccent(${pattern})
       OR unaccent(p.name) ILIKE unaccent(${pattern})
  `;
  return rows.map((r) => r.id);
}

/** Customer.id khớp họ tên, SĐT, hoặc email */
export async function findCustomerIdsByQuery(
  prisma: PrismaService,
  q: string,
): Promise<bigint[]> {
  const pattern = `%${q}%`;
  const rows = await prisma.$queryRaw<{ id: bigint }[]>`
    SELECT id
    FROM customers
    WHERE unaccent(COALESCE(first_name, '')) ILIKE unaccent(${pattern})
       OR unaccent(COALESCE(last_name, '')) ILIKE unaccent(${pattern})
       OR unaccent(COALESCE(email, '')) ILIKE unaccent(${pattern})
       OR unaccent(COALESCE(phone, '')) ILIKE unaccent(${pattern})
  `;
  return rows.map((r) => r.id);
}

/** Supplier.id khớp mã, tên, email, SĐT, hoặc mã số thuế */
export async function findSupplierIdsByQuery(
  prisma: PrismaService,
  q: string,
): Promise<bigint[]> {
  const pattern = `%${q}%`;
  const rows = await prisma.$queryRaw<{ id: bigint }[]>`
    SELECT id
    FROM suppliers
    WHERE unaccent(code) ILIKE unaccent(${pattern})
       OR unaccent(name) ILIKE unaccent(${pattern})
       OR unaccent(COALESCE(email, '')) ILIKE unaccent(${pattern})
       OR unaccent(COALESCE(phone, '')) ILIKE unaccent(${pattern})
       OR unaccent(COALESCE(tax_code, '')) ILIKE unaccent(${pattern})
  `;
  return rows.map((r) => r.id);
}

/** Conversation.id khớp tên khách hoặc SĐT */
export async function findConversationIdsByQuery(
  prisma: PrismaService,
  q: string,
): Promise<bigint[]> {
  const pattern = `%${q}%`;
  const rows = await prisma.$queryRaw<{ id: bigint }[]>`
    SELECT id
    FROM conversations
    WHERE unaccent(customer_name) ILIKE unaccent(${pattern})
       OR unaccent(customer_phone) ILIKE unaccent(${pattern})
  `;
  return rows.map((r) => r.id);
}

/** Order.id khớp mã đơn, SĐT, hoặc SKU của 1 trong các dòng hàng */
export async function findOrderIdsByQuery(
  prisma: PrismaService,
  q: string,
): Promise<bigint[]> {
  const pattern = `%${q}%`;
  const rows = await prisma.$queryRaw<{ id: bigint }[]>`
    SELECT DISTINCT o.id
    FROM orders o
    LEFT JOIN order_items oi ON oi.order_id = o.id
    WHERE unaccent(o.name) ILIKE unaccent(${pattern})
       OR unaccent(COALESCE(o.phone, '')) ILIKE unaccent(${pattern})
       OR unaccent(oi.sku) ILIKE unaccent(${pattern})
  `;
  return rows.map((r) => r.id);
}
