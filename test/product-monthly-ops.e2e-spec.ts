/**
 * E2E cho dashboard "Sản phẩm — Vận hành theo tháng" (GET /reports/san-pham-van-hanh-theo-thang).
 * Endpoint chỉ SELECT nên chạy thẳng trên DB thật, không cần dọn dữ liệu sau test — xem
 * scripts-tmp/smoke-product-monthly-ops.ts cho cách chạy tay khi cần soi output đầy đủ.
 *
 * Chạy: RUN_INTEGRATION_TESTS=1 npm test -- test/product-monthly-ops.e2e-spec.ts
 */
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { ReportsModule } from '../src/modules/reports/reports.module';
import { ReportService } from '../src/modules/reports/report.service';
import { BusinessException } from '../src/common/exceptions/business.exception';
import type { AuthUser } from '../src/common/decorators/current-user.decorator';

/** Admin toàn hệ thống — bỏ qua giới hạn kho được gán, khớp cách resolveLocations() xử lý admin. */
const admin: AuthUser = {
  userId: 0n,
  email: 'system-test@local.dev',
  roles: [],
  locationIds: [],
  isAdmin: true,
};

const describeIfDb =
  process.env.DATABASE_URL && process.env.RUN_INTEGRATION_TESTS === '1'
    ? describe
    : describe.skip;

describeIfDb('product monthly ops (integration)', () => {
  let reports: ReportService;
  let prisma: PrismaService;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [PrismaModule, ReportsModule],
    }).compile();
    reports = module.get(ReportService);
    prisma = module.get(PrismaService);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // Admin quét toàn bộ kho nên query nặng hơn mức mặc định 5s của jest.
  it('trả đủ khối dữ liệu cho dashboard, không lọc', async () => {
    const res = await reports.productMonthlyOps({ month: '2026-07' }, admin);

    expect(res.period).toEqual({
      year: 2026,
      month: 7,
      from: '2026-06-30',
      to: '2026-07-31',
    });
    expect(res.filters).toEqual({ category_id: null, location_id: null });

    // Thẻ KPI
    expect(typeof res.kpis.products_ordered.value).toBe('number');
    expect(typeof res.kpis.products_shipped.value).toBe('number');
    expect(typeof res.kpis.ship_to_order_rate.value).toBe('number');
    expect(typeof res.kpis.products_out_of_stock.value).toBe('number');
    expect(res.kpis.products_ordered.value).toBeGreaterThanOrEqual(0);

    // Bảng top sản phẩm — mỗi dòng có đủ field và order_count > 0 (do HAVING trong SQL)
    expect(Array.isArray(res.top_ordered_products)).toBe(true);
    for (const row of res.top_ordered_products) {
      expect(row.order_count).toBeGreaterThan(0);
      expect(typeof row.product_id).toBe('string');
      expect(typeof row.name).toBe('string');
    }

    // Bảng thiếu hàng — mọi dòng phải thực sự âm (khả dụng < nhu cầu) và nhu cầu > 0
    // nên shortage = available - demand luôn < available.
    expect(res.out_of_stock.summary.count).toBe(res.out_of_stock.items.length);
    for (const item of res.out_of_stock.items) {
      expect(item.shortage).toBeLessThan(0);
      expect(item.shortage).toBeLessThan(item.available);
      expect(item.stuck_orders).toBeGreaterThan(0);
    }

    // Chỉ số bổ sung
    expect(typeof res.additional_metrics.revenue.value).toBe('number');
    expect(Array.isArray(res.additional_metrics.category_distribution)).toBe(
      true,
    );
    const pctSum = res.additional_metrics.category_distribution.reduce(
      (s, c) => s + c.pct,
      0,
    );
    // Tổng % các danh mục phải xấp xỉ 100 (sai số làm tròn 1 chữ số thập phân)
    if (res.additional_metrics.category_distribution.length) {
      expect(pctSum).toBeGreaterThan(95);
      expect(pctSum).toBeLessThanOrEqual(100.5);
    }
    expect(
      res.additional_metrics.products_without_orders.value,
    ).toBeGreaterThanOrEqual(0);
    expect(
      res.additional_metrics.avg_processing_days.value,
    ).toBeGreaterThanOrEqual(0);
    expect(
      res.additional_metrics.cancel_return_rate.value,
    ).toBeGreaterThanOrEqual(0);
  }, 15_000);

  it('lọc theo category_id chỉ trả sản phẩm thuộc danh mục đó', async () => {
    const category = await prisma.category.findFirst({
      where: { products: { some: {} } },
      select: { id: true, name: true },
    });
    if (!category) return; // DB test không có danh mục nào có sản phẩm — bỏ qua

    const res = await reports.productMonthlyOps(
      { month: '2026-07', category_id: category.id.toString() },
      admin,
    );

    expect(res.filters.category_id).toBe(category.id.toString());
    for (const row of res.top_ordered_products) {
      expect(row.category).toBe(category.name);
    }
  });

  it('tháng không hợp lệ → BusinessException VALIDATION_ERROR', async () => {
    await expect(
      reports.productMonthlyOps({ month: '2026-13' }, admin),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await expect(
      reports.productMonthlyOps({ month: 'not-a-month' }, admin),
    ).rejects.toBeInstanceOf(BusinessException);
  });

  it('lọc theo tuần (ISO week) trả đúng khoảng ngày và đủ khối dữ liệu', async () => {
    const res = await reports.productMonthlyOps({ week: '2026-W27' }, admin);

    expect(res.period).toEqual({
      year: 2026,
      week: 27,
      from: '2026-06-28',
      to: '2026-07-05',
    });
    expect(typeof res.kpis.products_ordered.value).toBe('number');
    expect(Array.isArray(res.top_ordered_products)).toBe(true);
  }, 15_000);

  it('tuần không hợp lệ → BusinessException VALIDATION_ERROR', async () => {
    await expect(
      reports.productMonthlyOps({ week: '2026-W99' }, admin),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await expect(
      reports.productMonthlyOps({ week: 'not-a-week' }, admin),
    ).rejects.toBeInstanceOf(BusinessException);
  });

  it('truyền cả month và week → BusinessException VALIDATION_ERROR', async () => {
    await expect(
      reports.productMonthlyOps({ month: '2026-07', week: '2026-W27' }, admin),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('lọc theo ngày trả đúng khoảng ngày và đủ khối dữ liệu', async () => {
    const res = await reports.productMonthlyOps({ day: '2026-07-15' }, admin);

    expect(res.period).toEqual({
      year: 2026,
      month: 7,
      day: 15,
      from: '2026-07-14',
      to: '2026-07-15',
    });
    expect(typeof res.kpis.products_ordered.value).toBe('number');
    expect(Array.isArray(res.top_ordered_products)).toBe(true);
  }, 15_000);

  it('ngày không hợp lệ → BusinessException VALIDATION_ERROR', async () => {
    await expect(
      reports.productMonthlyOps({ day: '2026-02-30' }, admin),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await expect(
      reports.productMonthlyOps({ day: 'not-a-day' }, admin),
    ).rejects.toBeInstanceOf(BusinessException);
  });

  it('lọc theo khoảng ngày (from/to) trả đúng khoảng và đủ khối dữ liệu', async () => {
    const res = await reports.productMonthlyOps(
      { from: '2026-07-01', to: '2026-07-10' },
      admin,
    );

    expect(res.period).toEqual({ from: '2026-06-30', to: '2026-07-10' });
    expect(typeof res.kpis.products_ordered.value).toBe('number');
    expect(Array.isArray(res.top_ordered_products)).toBe(true);
  }, 15_000);

  it('chỉ truyền from hoặc to (thiếu 1 vế) → BusinessException VALIDATION_ERROR', async () => {
    await expect(
      reports.productMonthlyOps({ from: '2026-07-01' }, admin),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await expect(
      reports.productMonthlyOps({ to: '2026-07-10' }, admin),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('from sau to → BusinessException VALIDATION_ERROR', async () => {
    await expect(
      reports.productMonthlyOps({ from: '2026-07-10', to: '2026-07-01' }, admin),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('truyền nhiều hơn 1 kiểu lọc thời gian → BusinessException VALIDATION_ERROR', async () => {
    await expect(
      reports.productMonthlyOps({ day: '2026-07-15', month: '2026-07' }, admin),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await expect(
      reports.productMonthlyOps(
        { from: '2026-07-01', to: '2026-07-10', week: '2026-W27' },
        admin,
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });
});
