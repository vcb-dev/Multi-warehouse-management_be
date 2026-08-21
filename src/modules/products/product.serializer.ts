import { Prisma } from '@prisma/client';
import { ProductWithRelations } from './product.repository';

function dec(v: Prisma.Decimal | null | undefined): number | null {
  if (v == null) return null;
  return Number(v);
}

export function serializeProductListItem(
  p: {
    id: bigint;
    alias: string;
    name: string;
    imageUrl: string | null;
    vendor: string | null;
    productType: string | null;
    tags: string[];
    status: string;
    variants: {
      sku: string;
      barcode: string | null;
      price: Prisma.Decimal;
      unit: string | null;
    }[];
  },
  opts?: { searchQuery?: string },
) {
  const skus = p.variants.map((v) => v.sku);
  const prices = p.variants.map((v) => Number(v.price));
  const searchQ = opts?.searchQuery?.trim().toLowerCase();
  // Tìm kiếm khớp cả barcode (mã thật của đợt import SKU giả) — trả về đúng mã
  // đã khớp để giao diện tô sáng, nếu không người dùng thấy kết quả mà không
  // hiểu vì sao nó khớp.
  const matchedSku = searchQ
    ? (skus.find((sku) => sku.toLowerCase().includes(searchQ)) ??
      p.variants.find((v) => v.barcode?.toLowerCase().includes(searchQ))
        ?.barcode ??
      null)
    : null;

  return {
    id: p.id.toString(),
    alias: p.alias,
    name: p.name,
    image_url: p.imageUrl,
    default_sku: skus[0] ?? null,
    skus,
    variant_count: skus.length,
    matched_sku: matchedSku,
    vendor: p.vendor,
    product_type: p.productType,
    unit: p.variants[0]?.unit ?? null,
    tags: p.tags,
    price_from: prices.length ? Math.min(...prices) : 0,
    is_published: p.status === 'active',
  };
}

export function serializeProductDetail(p: ProductWithRelations) {
  // requires_shipping/taxable/track_inventory/allow_backorder/unit sống ở variant
  // theo Sapo (Phase 2) — rollup từ variant đầu tiên để form 1-bộ-cờ hiện tại của
  // FE không phải đổi; variant[].* trong response vẫn có giá trị đầy đủ per-row.
  const firstVariant = p.variants[0];

  return {
    id: p.id.toString(),
    alias: p.alias,
    name: p.name,
    vendor: p.vendor,
    product_type: p.productType,
    unit: firstVariant?.unit ?? null,
    tags: p.tags,
    requires_shipping: firstVariant?.requiresShipping ?? true,
    is_published: p.status === 'active',
    taxable: firstVariant?.taxable ?? true,
    image_url: p.imageUrl,
    meta_title: p.metaTitle,
    meta_description: p.metaDescription,
    content: p.content,
    summary: p.summary,
    track_inventory: (firstVariant?.inventoryManagement ?? 'bizweb') !== '',
    allow_backorder: firstVariant?.inventoryPolicy === 'continue',
    vat_pit_category_code: p.vatPitCategoryCode,
    images: p.images.map((img) => ({
      id: img.id.toString(),
      url: img.url,
      position: img.position,
      is_primary: img.isPrimary,
    })),
    options: p.options.map((o) => ({
      id: o.id.toString(),
      name: o.name,
      position: o.position,
      values: [
        ...new Set(
          p.variants.flatMap((v) =>
            v.optionValues
              .filter((ov) => ov.optionId === o.id)
              .map((ov) => ov.value),
          ),
        ),
      ],
    })),
    variants: p.variants.map((v) => ({
      id: v.id.toString(),
      sku: v.sku,
      barcode: v.barcode,
      price: dec(v.price)!,
      compare_at_price: dec(v.compareAtPrice),
      cost: dec(v.cost)!,
      weight: dec(v.weight),
      weight_unit: v.weightUnit,
      image_url: v.imageUrl,
      enabled: v.enabled,
      unit: v.unit,
      taxable: v.taxable,
      requires_shipping: v.requiresShipping,
      track_inventory: v.inventoryManagement !== '',
      allow_backorder: v.inventoryPolicy === 'continue',
      option_values: v.optionValues
        .sort((a, b) => a.option.position - b.option.position)
        .map((ov) => ov.value),
    })),
    category_ids: p.categories.map((c) => c.categoryId.toString()),
    sales_channels: p.salesChannels.map((sc) => sc.channel),
    created_at: p.createdOn.toISOString(),
    updated_at: p.modifiedOn.toISOString(),
  };
}

export function slugify(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}
