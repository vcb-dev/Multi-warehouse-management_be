/**
 * Ánh xạ "kênh bán" (khái niệm hiển thị) ↔ `orders.source_name` (chuỗi tự do).
 *
 * Vì sao cần bảng này: `channel_connections.channel` là enum `OrderSource` (`tiktok`,
 * `shopee`...) nhưng `orders.source_name` là chuỗi Sapo trả về, KHÔNG trùng tên — đơn
 * TikTok về dưới `tiktokshop`, `tiktok-for-business`, `tiktok-personal`. Nếu so trực
 * tiếp `source_name = 'tiktok'` thì 18.554 đơn TikTok thật trong DB đều rơi ra ngoài.
 *
 * Danh sách alias lấy từ chính dữ liệu thật (`SELECT DISTINCT source_name FROM orders`),
 * không phải đoán. Nguồn lạ chưa khai báo được gom vào `other` chứ không bị bỏ, để tổng
 * các kênh luôn bằng tổng đơn.
 */

/** Kênh hiển thị trên màn Kênh bán. `key` khớp `channel_connections.channel` khi kênh đó kết nối trực tiếp được. */
export type ChannelKey =
  | 'tiktok'
  | 'shopee'
  | 'facebook'
  | 'web'
  | 'pos'
  | 'zalo'
  | 'other';

export type ChannelDef = {
  key: ChannelKey;
  label: string;
  /** Giá trị `source_name` thuộc kênh này (so sánh không phân biệt hoa thường). */
  sources: string[];
  /** Kênh có thể kết nối trực tiếp qua OAuth (có dòng trong `channel_connections`). */
  connectable: boolean;
};

export const CHANNEL_DEFS: ChannelDef[] = [
  {
    key: 'tiktok',
    label: 'TikTok Shop',
    sources: ['tiktokshop', 'tiktok', 'tiktok-for-business', 'tiktok-personal'],
    connectable: true,
  },
  {
    key: 'shopee',
    label: 'Shopee',
    sources: ['shopee'],
    connectable: true,
  },
  {
    key: 'facebook',
    label: 'Facebook',
    sources: [
      'facebook',
      'facebook_shopping',
      'instagram',
      'live_fb',
      'live-fb',
      'livestream',
      'social',
    ],
    connectable: false,
  },
  {
    key: 'web',
    label: 'Website',
    sources: ['web', 'shopify', 'woocommerce', 'tdh-agency-website'],
    connectable: false,
  },
  { key: 'pos', label: 'POS', sources: ['pos'], connectable: false },
  {
    key: 'zalo',
    label: 'Zalo',
    sources: ['zalo', 'zalo-oa'],
    connectable: false,
  },
];

const CHANNEL_BY_SOURCE = new Map<string, ChannelKey>(
  CHANNEL_DEFS.flatMap((def) =>
    def.sources.map((s) => [s.toLowerCase(), def.key] as [string, ChannelKey]),
  ),
);

export const OTHER_CHANNEL: ChannelDef = {
  key: 'other',
  label: 'Nguồn khác',
  sources: [],
  connectable: false,
};

/** `source_name` của một đơn thuộc kênh nào. Nguồn chưa khai báo → `other`. */
export function channelOfSource(sourceName: string | null): ChannelKey {
  if (!sourceName) return 'other';
  return CHANNEL_BY_SOURCE.get(sourceName.trim().toLowerCase()) ?? 'other';
}

export function findChannelDef(key: string): ChannelDef | undefined {
  return (
    CHANNEL_DEFS.find((d) => d.key === key) ??
    (key === 'other' ? OTHER_CHANNEL : undefined)
  );
}

export function channelLabel(key: ChannelKey): string {
  return findChannelDef(key)?.label ?? key;
}
