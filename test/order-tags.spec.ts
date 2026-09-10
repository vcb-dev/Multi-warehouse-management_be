/**
 * `GET /orders/tags` — gợi ý tag cho ô nhập tag của đơn.
 *
 * Là raw SQL (unnest + unaccent) nên Prisma không diễn tả được và tsc sạch
 * không nói lên điều gì; phải chạy thật mới biết câu SQL đúng. Chỉ ĐỌC.
 * Chạy: RUN_INTEGRATION_TESTS=1 npm test -- test/order-tags.spec.ts
 */
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { OrdersModule } from '../src/modules/orders/orders.module';
// VouchersModule là @Global nên OrdersModule không khai import; TestingModule
// dựng riêng thì phải nạp tay, nếu không OrderService thiếu VoucherService.
import { VouchersModule } from '../src/modules/vouchers/vouchers.module';
import { OrderService } from '../src/modules/orders/order.service';

const describeIfDb =
  process.env.DATABASE_URL && process.env.RUN_INTEGRATION_TESTS === '1'
    ? describe
    : describe.skip;

describeIfDb('gợi ý tag của đơn hàng', () => {
  let orders: OrderService;
  let prisma: PrismaService;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [PrismaModule, VouchersModule, OrdersModule],
    }).compile();
    orders = module.get(OrderService);
    prisma = module.get(PrismaService);
  }, 60_000);

  afterAll(() => prisma.$disconnect());

  it('xếp theo số đơn giảm dần — tag rác dùng 1 lần không chen lên đầu', async () => {
    const res = await orders.listTags({ limit: 20 });

    expect(res.data.length).toBeGreaterThan(0);
    expect(res.data.length).toBeLessThanOrEqual(20);
    const counts = res.data.map((r) => r.order_count);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
    // 46.221/58.769 tag chỉ dùng đúng 1 lần: nếu thứ tự sai thì trang đầu toàn rác.
    expect(counts[0]).toBeGreaterThan(1);
    for (const row of res.data) {
      expect(typeof row.tag).toBe('string');
      expect(row.tag).not.toBe('');
    }
  }, 60_000);

  it('gõ không dấu vẫn tìm ra tag có dấu', async () => {
    // "Không cọc" là tag thật đang dùng nhiều nhất có dấu tiếng Việt.
    const [top] = (await orders.listTags({ limit: 1 })).data;
    const khongDau = top.tag.normalize('NFD').replace(/[̀-ͯ]/g, '');

    const res = await orders.listTags({ q: khongDau, limit: 20 });
    expect(res.data.map((r) => r.tag)).toContain(top.tag);
  }, 60_000);

  it('khớp một phần ở giữa chuỗi', async () => {
    const [top] = (await orders.listTags({ limit: 1 })).data;
    const giua = top.tag.slice(1, Math.max(2, top.tag.length - 1));

    const res = await orders.listTags({ q: giua, limit: 50 });
    expect(res.data.map((r) => r.tag)).toContain(top.tag);
  }, 60_000);

  it('không khớp gì thì trả rỗng, không trả cả bảng', async () => {
    const res = await orders.listTags({
      q: 'zzz-khong-bao-gio-co-tag-nay-zzz',
      limit: 20,
    });
    expect(res.data).toEqual([]);
  }, 60_000);
});
