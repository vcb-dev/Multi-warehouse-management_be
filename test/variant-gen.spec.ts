import { VariantService } from '../src/modules/products/variant.service';

describe('VariantService — tích Descartes (P-2)', () => {
  const service = new VariantService();

  it('2×2 options → 4 phiên bản', () => {
    const combos = service.cartesian([
      { name: 'Màu', values: ['Đỏ', 'Xanh'] },
      { name: 'Size', values: ['M', 'L'] },
    ]);
    expect(combos).toHaveLength(4);
    expect(combos).toContainEqual(['Đỏ', 'M']);
    expect(combos).toContainEqual(['Xanh', 'L']);
  });

  it('không option → 1 tổ hợp rỗng', () => {
    expect(service.cartesian([])).toEqual([[]]);
  });

  it('optionKey phân biệt tổ hợp', () => {
    expect(service.optionKey(['Đỏ', 'M'])).not.toBe(
      service.optionKey(['Xanh', 'M']),
    );
  });
});
