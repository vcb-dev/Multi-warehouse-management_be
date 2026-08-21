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
      { sku: 'SKU-A', barcode: null, price: dec(100), unit: null },
      { sku: 'SKU-B', barcode: null, price: dec(80), unit: null },
      { sku: 'SKU-C', barcode: null, price: dec(120), unit: null },
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

  // Đợt import Sapo cũ ghi SKU giả và đẩy mã thật xuống barcode — tìm theo mã
  // thật vẫn phải chỉ ra được mã đã khớp.
  it('matched_sku lấy barcode khi SKU là mã giả', () => {
    const row = serializeProductListItem(
      {
        ...base,
        variants: [
          {
            sku: 'SAPO-V-205911101',
            barcode: 'N610390',
            price: dec(100),
            unit: null,
          },
        ],
      },
      { searchQuery: 'n610390' },
    );
    expect(row.matched_sku).toBe('N610390');
  });

  it('ưu tiên SKU thật hơn barcode khi cả hai cùng khớp', () => {
    const row = serializeProductListItem(
      {
        ...base,
        variants: [
          { sku: 'N610390', barcode: 'N610390', price: dec(100), unit: null },
        ],
      },
      { searchQuery: 'n610390' },
    );
    expect(row.matched_sku).toBe('N610390');
  });
});
