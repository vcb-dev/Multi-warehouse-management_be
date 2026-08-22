/**
 * Link mở đơn gốc trên trang quản trị của sàn — cái Sapo hiển thị dưới tên "Mã tham chiếu".
 *
 * Vì sao phải tự ghép chứ không lấy từ API sàn: **cả TikTok Open API lẫn Shopee Open API đều
 * không trả về URL nào**. Đo ngày 20/08/2026 trên đơn thật `585632061840066454`: payload
 * TikTok chỉ có `id`, còn `source_url` mà Sapo trả về là chuỗi Sapo tự ghép. Giữ nguyên đúng
 * dạng chuỗi Sapo đang dùng để đơn kéo thẳng từ sàn và đơn cũ đồng bộ qua Sapo mở ra cùng
 * một chỗ, không phải hai kiểu link cho cùng một đơn.
 *
 * Hạn chế đã biết, cố ý chấp nhận: link **không mang định danh gian hàng**. Shop bán trên 3
 * gian TikTok, nên nếu Seller Center đang đứng ở gian khác thì phải tự đổi gian mới thấy đơn.
 * Vì vậy `orders.channel_shop_name` phải hiển thị kèm link chứ không chỉ mỗi mã.
 */

/** Kênh có trang quản trị mở được đơn theo mã. */
export type LinkableChannel = 'tiktok' | 'shopee';

/** `orders.source_name` (chuỗi Sapo, tự do) → kênh dựng được link. */
const CHANNEL_BY_SOURCE_NAME: Record<string, LinkableChannel> = {
  tiktokshop: 'tiktok',
  tiktok: 'tiktok',
  shopee: 'shopee',
};

/**
 * `tiktok-for-business`/`tiktok-personal` KHÔNG có ở đây: đó là đơn chat qua Sapo Chat
 * OmniAI, `source_identifier` của chúng là conversationId của Sapo chứ không phải mã đơn
 * sàn — ghép vào link Seller Center sẽ ra trang trống.
 */
export function linkableChannelOf(
  sourceName: string | null | undefined,
): LinkableChannel | null {
  if (!sourceName) return null;
  return CHANNEL_BY_SOURCE_NAME[sourceName.toLowerCase()] ?? null;
}

/**
 * Link tới đơn trên trang quản trị của sàn. `identifier` là mã đơn bên sàn
 * (TikTok `order_id`, Shopee `order_sn`) — với hai kênh này trùng luôn `orders.name`.
 */
export function marketplaceOrderUrl(
  channel: LinkableChannel,
  identifier: string,
): string {
  const id = encodeURIComponent(identifier);
  switch (channel) {
    case 'tiktok':
      // `selected_sort`/`tab` là tham số Sapo đang dùng — giữ y hệt để link mở ra đúng
      // khung nhìn quen thuộc (tất cả đơn, sắp xếp mặc định).
      return `https://seller-vn.tiktok.com/order?main_order_id[]=${id}&selected_sort=6&tab=all`;
    case 'shopee':
      return `https://banhang.shopee.vn/portal/sale?search=${id}`;
  }
}

/**
 * Đuôi kênh mà Sapo gắn vào `channel_definition.branch_name`, theo từng kênh.
 *
 * Sapo ghi tên gian hàng kèm đuôi ("Viễn Chí Bảo - Tiktokshop", "Miêu Bạc - Shopee") còn API
 * sàn trả tên trần ("Viễn Chí Bảo"). Hai nguồn cùng đổ vào một cột `orders.channel_shop_name`
 * nên không cắt đuôi thì cùng một gian hàng hiện thành hai dòng khác nhau trên UI.
 */
const SHOP_NAME_SUFFIX: Record<LinkableChannel, RegExp> = {
  tiktok: /\s*-\s*tiktok\s*shop\s*$/i,
  shopee: /\s*-\s*shopee\s*$/i,
};

/**
 * Tên gian hàng chuẩn hoá — bỏ đuôi kênh do Sapo gắn thêm.
 *
 * Chỉ cắt đúng đuôi của kênh đang xét, KHÔNG cắt mọi cụm " - X" cuối chuỗi: gian hàng hoàn
 * toàn có thể tên thật là "Minco Accessories - Outlet", cắt bừa là hỏng tên. Kênh không dựng
 * được link (đơn chat, pos, web...) thì trả nguyên chuỗi.
 *
 * Đuôi kênh là thừa trên UI vì màn đơn hàng đã hiện "Nguồn đơn" ngay phía trên "Gian hàng".
 */
export function normalizeChannelShopName(
  sourceName: string | null | undefined,
  rawName: string | null | undefined,
): string | null {
  const name = rawName?.trim();
  if (!name) return null;
  const channel = linkableChannelOf(sourceName);
  if (!channel) return name;
  return name.replace(SHOP_NAME_SUFFIX[channel], '').trim() || name;
}

/** Tiện dụng cho backfill: từ `source_name` + mã đơn ra link, `null` nếu kênh không mở được. */
export function orderUrlFromSourceName(
  sourceName: string | null | undefined,
  identifier: string | null | undefined,
): string | null {
  const channel = linkableChannelOf(sourceName);
  if (!channel || !identifier) return null;
  return marketplaceOrderUrl(channel, identifier);
}
