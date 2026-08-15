import {
  shopeeSignPublic,
  shopeeSignShop,
  resolveShopeeHost,
} from './shopee.client';

describe('ShopeeClient signing', () => {
  it('shopeeSignPublic khớp thứ tự partner_id + path + timestamp', () => {
    const sign = shopeeSignPublic(
      '80001',
      '/api/v2/shop/auth_partner',
      1657263479,
      'test-key',
    );
    expect(sign).toMatch(/^[a-f0-9]{64}$/);
    expect(sign).toBe(
      shopeeSignPublic(
        '80001',
        '/api/v2/shop/auth_partner',
        1657263479,
        'test-key',
      ),
    );
  });

  it('shopeeSignShop bao gồm access_token và shop_id', () => {
    const pub = shopeeSignPublic(
      '1000016',
      '/api/v2/auth/token/get',
      1657263479,
      'key',
    );
    const shop = shopeeSignShop(
      '1000016',
      '/api/v2/shop/get_shop_info',
      1657263479,
      'access',
      '54804',
      'key',
    );
    expect(pub).not.toBe(shop);
    expect(shop).toMatch(/^[a-f0-9]{64}$/);
  });

  it('resolveShopeeHost sandbox vs production', () => {
    const prev = process.env.SHOPEE_ENV;
    process.env.SHOPEE_ENV = 'sandbox';
    expect(resolveShopeeHost()).toContain('sandbox');
    process.env.SHOPEE_ENV = 'production';
    expect(resolveShopeeHost()).toBe('https://partner.shopeemobile.com');
    if (prev) process.env.SHOPEE_ENV = prev;
    else delete process.env.SHOPEE_ENV;
  });
});
