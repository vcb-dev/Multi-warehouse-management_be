import { Prisma } from '@prisma/client';
import { serializeProductListItem } from '../src/modules/products/product.serializer';

const dec = (n: number) => n as unknown as Prisma.Decimal;

describe('serializeProductListItem', () => {
  const base = {
    id: 1n,
    alias: 'ao-thun',
    name: 'Áo thun',
    imageUrl: null,
    vendor: null,
    productType: null,
    tags: [] as string[],
    status: 'active',
    variants: [
      { sku: 'SKU-A', price: dec(100), unit: null },
      { sku: 'SKU-B', price: dec(80), unit: null },
      { sku: 'SKU-C', price: dec(120), unit: null },
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
