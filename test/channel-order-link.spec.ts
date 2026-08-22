/**
 * Link "Mã tham chiếu" — khoá lại đúng dạng chuỗi Sapo đang dùng.
 * Chạy: npm test -- test/channel-order-link.spec.ts
 *
 * Hai URL mong đợi dưới đây **chép nguyên** từ `source_url` mà API Sapo trả về cho đơn thật
 * (đo 20/08/2026). Đây là toàn bộ lý do bài test tồn tại: đơn cũ đồng bộ qua Sapo và đơn mới
 * kéo thẳng từ sàn phải mở ra cùng một chỗ, lệch một tham số là hai kiểu link cho cùng một đơn.
 */
import {
  linkableChannelOf,
  marketplaceOrderUrl,
  normalizeChannelShopName,
  orderUrlFromSourceName,
} from '../src/modules/channels/channel-order-link';

describe('marketplaceOrderUrl', () => {
  it('TikTok — giống hệt source_url của Sapo', () => {
    expect(marketplaceOrderUrl('tiktok', '585632061840066454')).toBe(
      'https://seller-vn.tiktok.com/order?main_order_id[]=585632061840066454&selected_sort=6&tab=all',
    );
  });

  it('Shopee — giống hệt source_url của Sapo', () => {
    expect(marketplaceOrderUrl('shopee', '260820SUNRWDUD')).toBe(
      'https://banhang.shopee.vn/portal/sale?search=260820SUNRWDUD',
    );
  });
});

describe('linkableChannelOf', () => {
  it('nhận các chuỗi source_name thật của kênh sàn', () => {
    expect(linkableChannelOf('tiktokshop')).toBe('tiktok');
    expect(linkableChannelOf('shopee')).toBe('shopee');
  });

  it('KHÔNG nhận đơn chat, dù tên có chữ tiktok', () => {
    // `source_identifier` của nhóm này là conversationId của Sapo Chat OmniAI
    // (`6a858f582281d800012ea120`), ghép vào link Seller Center sẽ ra trang trống.
    expect(linkableChannelOf('tiktok-for-business')).toBeNull();
    expect(linkableChannelOf('tiktok-personal')).toBeNull();
    expect(linkableChannelOf('facebook')).toBeNull();
    expect(linkableChannelOf(null)).toBeNull();
  });
});

/**
 * Tên gian hàng dưới đây **chép nguyên** từ `channel_definition.branch_name` mà Sapo trả về
 * (đo 21/08/2026 trên mẫu 300 đơn thật) — đủ 7 gian hàng đang bán.
 */
describe('normalizeChannelShopName', () => {
  it('cắt đuôi kênh Sapo gắn thêm', () => {
    expect(normalizeChannelShopName('tiktokshop', 'Viễn Chí Bảo - Tiktokshop')).toBe(
      'Viễn Chí Bảo',
    );
    expect(
      normalizeChannelShopName('tiktokshop', 'Viễn Chí Bảo Silver - Tiktokshop'),
    ).toBe('Viễn Chí Bảo Silver');
    expect(
      normalizeChannelShopName('tiktokshop', 'Trang sức Viễn Chí Bảo - Tiktokshop'),
    ).toBe('Trang sức Viễn Chí Bảo');
    expect(normalizeChannelShopName('shopee', 'Miêu Bạc - Shopee')).toBe('Miêu Bạc');
    expect(normalizeChannelShopName('shopee', 'Minco Accessories - Shopee')).toBe(
      'Minco Accessories',
    );
    expect(
      normalizeChannelShopName('shopee', 'Viễn Chí Bảo Art Silver - Shopee'),
    ).toBe('Viễn Chí Bảo Art Silver');
  });

  it('idempotent — tên trần của API sàn giữ nguyên', () => {
    // Sync trực tiếp lấy tên từ API sàn, vốn đã không có đuôi; chạy lại backfill nhiều lần
    // cũng không được gặm dần tên gian hàng.
    expect(normalizeChannelShopName('tiktokshop', 'Viễn Chí Bảo')).toBe('Viễn Chí Bảo');
    expect(normalizeChannelShopName('shopee', 'Miêu Bạc')).toBe('Miêu Bạc');
  });

  it('chỉ cắt đuôi của ĐÚNG kênh đang xét', () => {
    // Không được cắt bừa mọi cụm " - X": gian hàng có thể tên thật như vậy.
    expect(normalizeChannelShopName('shopee', 'Minco Accessories - Outlet')).toBe(
      'Minco Accessories - Outlet',
    );
    expect(normalizeChannelShopName('tiktokshop', 'Miêu Bạc - Shopee')).toBe(
      'Miêu Bạc - Shopee',
    );
  });

  it('kênh không phải sàn thì giữ nguyên, rỗng thì null', () => {
    expect(normalizeChannelShopName('facebook', 'Viễn Chí Bảo - Tiktokshop')).toBe(
      'Viễn Chí Bảo - Tiktokshop',
    );
    expect(normalizeChannelShopName('tiktokshop', null)).toBeNull();
    expect(normalizeChannelShopName('tiktokshop', '   ')).toBeNull();
  });
});

describe('orderUrlFromSourceName', () => {
  it('trả null khi thiếu mã hoặc kênh không mở được', () => {
    expect(orderUrlFromSourceName('tiktokshop', null)).toBeNull();
    expect(orderUrlFromSourceName('pos', 'HK100666')).toBeNull();
  });

  it('ghép được từ source_name thật', () => {
    expect(orderUrlFromSourceName('shopee', '260820SUNRWDUD')).toBe(
      'https://banhang.shopee.vn/portal/sale?search=260820SUNRWDUD',
    );
  });
});
