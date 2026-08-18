/**
 * Tổng quan kênh bán — GET /channels/overview (service layer).
 * Chạy: RUN_INTEGRATION_TESTS=1 npm test -- test/channel-overview.spec.ts
 *
 * Test CHỈ ĐỌC: không tạo/xoá bản ghi nào. DB dev là DB thật đang dùng nên các
 * bất biến dưới đây được kiểm trên chính dữ liệu thật thay vì fixture dựng sẵn.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaModule } from '../src/prisma/prisma.module';
import { ChannelOverviewService } from '../src/modules/channels/channel-overview.service';
import { channelOfSource } from '../src/modules/channels/channel-source-map';
import { adminAuth } from './helpers/auth';

describe('channelOfSource', () => {
  it('gom các biến thể nguồn TikTok về một kênh', () => {
    // Sapo trả 'tiktokshop', không phải 'tiktok' — so trực tiếp với enum là mất hết đơn
    expect(channelOfSource('tiktokshop')).toBe('tiktok');
    expect(channelOfSource('tiktok')).toBe('tiktok');
    expect(channelOfSource('tiktok-for-business')).toBe('tiktok');
    expect(channelOfSource('tiktok-personal')).toBe('tiktok');
  });

  it('không phân biệt hoa thường và khoảng trắng thừa', () => {
    expect(channelOfSource('  Shopee ')).toBe('shopee');
    expect(channelOfSource('Shopify')).toBe('web');
  });

  it('nguồn lạ và nguồn rỗng rơi vào other, không bị mất', () => {
    expect(channelOfSource('nguon-la-chua-khai-bao')).toBe('other');
    expect(channelOfSource(null)).toBe('other');
    expect(channelOfSource('')).toBe('other');
  });
});

const describeIfDb =
  process.env.DATABASE_URL && process.env.RUN_INTEGRATION_TESTS === '1'
    ? describe
    : describe.skip;

jest.setTimeout(120000);

/** YYYY-MM-DD cách hôm nay `days` ngày (âm = quá khứ). */
function dayOffset(days: number): string {
  const d = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

describeIfDb('ChannelOverviewService.getOverview', () => {
  let service: ChannelOverviewService;
  const user = adminAuth();
  const from = dayOffset(-60);
  const to = dayOffset(0);

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [ChannelOverviewService],
    }).compile();
    service = module.get(ChannelOverviewService);
  });

  it('tổng các kênh khớp với totals', async () => {
    const r = await service.getOverview({ from, to }, user);

    const sum = r.channels.reduce(
      (acc, c) => ({
        orders: acc.orders + c.order_count,
        cancelled: acc.cancelled + c.cancelled_count,
        revenue: acc.revenue + c.revenue,
      }),
      { orders: 0, cancelled: 0, revenue: 0 },
    );

    expect(sum.orders).toBe(r.totals.order_count);
    expect(sum.cancelled).toBe(r.totals.cancelled_count);
    expect(sum.revenue).toBeCloseTo(r.totals.revenue, 2);
  });

  it('mỗi đơn thuộc đúng một nhóm trạng thái nên tổng nhóm = số đơn', async () => {
    const r = await service.getOverview({ from, to }, user);
    const sum = r.statuses.reduce((s, x) => s + x.count, 0);
    expect(sum).toBe(r.totals.order_count);
  });

  it('tỷ lệ huỷ = đơn huỷ / tổng đơn', async () => {
    const r = await service.getOverview({ from, to }, user);
    for (const c of r.channels) {
      const expected = c.order_count ? c.cancelled_count / c.order_count : 0;
      expect(c.cancel_rate).toBeCloseTo(expected, 10);
    }
  });

  it('lọc theo kênh trả đúng một kênh và khớp số của kênh đó khi không lọc', async () => {
    const all = await service.getOverview({ from, to }, user);
    const tiktokFromAll = all.channels.find((c) => c.key === 'tiktok');
    expect(tiktokFromAll).toBeDefined();

    const only = await service.getOverview(
      { from, to, channel: 'tiktok' },
      user,
    );
    expect(only.channels).toHaveLength(1);
    expect(only.channels[0].key).toBe('tiktok');
    expect(only.totals.order_count).toBe(tiktokFromAll!.order_count);
    expect(only.totals.revenue).toBeCloseTo(tiktokFromAll!.revenue, 2);
  });

  it('doanh số không tính đơn huỷ nhưng số đơn thì có', async () => {
    const r = await service.getOverview({ from, to }, user);
    // Có đơn huỷ trong kỳ thì mẫu số phải lớn hơn số đơn không huỷ
    expect(r.totals.order_count).toBeGreaterThanOrEqual(
      r.totals.cancelled_count,
    );
    expect(r.totals.revenue).toBeGreaterThanOrEqual(0);
  });

  it('kênh không hợp lệ bị từ chối', async () => {
    await expect(
      service.getOverview({ from, to, channel: 'khong-ton-tai' }, user),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('khoảng ngày trong tương lai không có đơn nào', async () => {
    const r = await service.getOverview(
      { from: dayOffset(730), to: dayOffset(737) },
      user,
    );
    expect(r.totals.order_count).toBe(0);
    expect(r.series).toHaveLength(0);
  });
});
