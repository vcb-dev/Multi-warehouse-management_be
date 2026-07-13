import { Prisma } from '@prisma/client';
import { ProductWithRelations } from './product.repository';

function dec(v: Prisma.Decimal | null | undefined): number | null {
  if (v == null) return null;
  return Number(v);
}

export function serializeProductListItem(
  p: {
    id: bigint;
    slug: string;
    name: string;
    imageUrl: string | null;
    brand: string | null;
    productType: string | null;
    unit: string | null;
    tags: string[];
    isPublished: boolean;
    variants: { sku: string; price: Prisma.Decimal }[];
  },
  opts?: { searchQuery?: string },
) {
  const skus = p.variants.map((v) => v.sku);
  const prices = p.variants.map((v) => Number(v.price));
  const searchQ = opts?.searchQuery?.trim().toLowerCase();
  const matchedSku = searchQ
    ? (skus.find((sku) => sku.toLowerCase().includes(searchQ)) ?? null)
    : null;

  return {
    id: p.id.toString(),
    slug: p.slug,
    name: p.name,
    image_url: p.imageUrl,
    default_sku: skus[0] ?? null,
    skus,
    variant_count: skus.length,
    matched_sku: matchedSku,
    brand: p.brand,
    product_type: p.productType,
    unit: p.unit,
    tags: p.tags,
    price_from: prices.length ? Math.min(...prices) : 0,
    is_published: p.isPublished,
  };
}

export function serializeProductDetail(p: ProductWithRelations) {
  return {
    id: p.id.toString(),
    slug: p.slug,
    name: p.name,
    brand: p.brand,
    product_type: p.productType,
    unit: p.unit,
    tags: p.tags,
    requires_shipping: p.requiresShipping,
    is_published: p.isPublished,
    taxable: p.taxable,
    image_url: p.imageUrl,
    seo_title: p.seoTitle,
    seo_description: p.seoDescription,
    description: p.description,
    short_description: p.shortDescription,
    track_inventory: p.trackInventory,
    allow_backorder: p.allowBackorder,
    tax_industry_group: p.taxIndustryGroup,
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
      option_values: v.optionValues
        .sort((a, b) => a.option.position - b.option.position)
        .map((ov) => ov.value),
    })),
    category_ids: p.categories.map((c) => c.categoryId.toString()),
    sales_channels: p.salesChannels.map((sc) => sc.channel),
    created_at: p.createdAt.toISOString(),
    updated_at: p.updatedAt.toISOString(),
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
