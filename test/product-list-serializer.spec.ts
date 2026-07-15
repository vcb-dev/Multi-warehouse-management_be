import { Prisma } from '@prisma/client';
import { serializeProductListItem } from '../src/modules/products/product.serializer';

const dec = (n: number) => n as unknown as Prisma.Decimal;

describe('serializeProductListItem', () => {
  const base = {
    id: 1n,
    slug: 'ao-thun',
    name: 'Áo thun',
    imageUrl: null,
    brand: null,
    productType: null,
    unit: null,
    tags: [] as string[],
    isPublished: true,
    variants: [
      { sku: 'SKU-A', price: dec(100) },
      { sku: 'SKU-B', price: dec(80) },
      { sku: 'SKU-C', price: dec(120) },
    ],
  };

  it('trả variant_count và skus đầy đủ', () => {
    const row = serializeProductListItem(base);
    expect(row.variant_count).toBe(3);
    expect(row.skus).toEqual(['SKU-A', 'SKU-B', 'SKU-C']);
    expect(row.default_sku).toBe('SKU-A');
    expect(row.price_from).toBe(80);
    expect(row.matched_sku).toBeNull();
  });

  it('matched_sku khi tìm theo SKU phụ', () => {
    const row = serializeProductListItem(base, { searchQuery: 'sku-b' });
    expect(row.matched_sku).toBe('SKU-B');
  });
});
