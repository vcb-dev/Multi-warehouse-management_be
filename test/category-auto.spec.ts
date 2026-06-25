import { CategoryService } from '../src/modules/categories/category.service';

describe('CategoryService — auto_conditions (P-4)', () => {
  const service = new CategoryService(null as never);

  it('match brand', () => {
    expect(
      service.matchesAuto(
        { brand: 'Nike', productType: null, tags: [] },
        { brand: 'Nike' },
      ),
    ).toBe(true);
  });

  it('không match brand khác', () => {
    expect(
      service.matchesAuto(
        { brand: 'Adidas', productType: null, tags: [] },
        { brand: 'Nike' },
      ),
    ).toBe(false);
  });

  it('match tags AND', () => {
    expect(
      service.matchesAuto(
        { brand: null, productType: null, tags: ['sale', 'new'] },
        { tags: ['sale'] },
      ),
    ).toBe(true);
  });
});
