import { CategoryService } from '../src/modules/categories/category.service';

describe('CategoryService — auto_conditions (P-4)', () => {
  const service = new CategoryService(null as never);

  it('match brand', () => {
    expect(
      service.matchesAuto(
        { vendor: 'Nike', productType: null, tags: [] },
        { vendor: 'Nike' },
      ),
    ).toBe(true);
  });

  it('không match brand khác', () => {
    expect(
      service.matchesAuto(
        { vendor: 'Adidas', productType: null, tags: [] },
        { vendor: 'Nike' },
      ),
    ).toBe(false);
  });

  it('match tags AND', () => {
    expect(
      service.matchesAuto(
        { vendor: null, productType: null, tags: ['sale', 'new'] },
        { tags: ['sale'] },
      ),
    ).toBe(true);
  });
});
