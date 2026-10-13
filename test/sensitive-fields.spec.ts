/**
 * Che giá vốn / lợi nhuận theo quyền — hàm thuần và interceptor, không đụng DB.
 */
import { lastValueFrom, of } from 'rxjs';
import {
  COST_KEYS,
  PROFIT_KEYS,
  redactKeys,
  stripKeys,
  withoutCostColumns,
} from '../src/common/auth/sensitive-fields';
import { CostVisibilityInterceptor } from '../src/common/interceptors/cost-visibility.interceptor';
import { ReportService } from '../src/modules/reports/report.service';
import { adminAuth, staffAuth } from './helpers/auth';

const withCost = staffAuth({ systemPermissions: ['product:view_cost'] });
const withoutCost = staffAuth({ systemPermissions: ['report:view'] });

describe('redactKeys', () => {
  it('đặt giá vốn về null ở mọi tầng, giữ nguyên hình dạng và trường khác', () => {
    const body = {
      data: [
        { sku: 'A', price: 100, cost: 60, variants: [{ id: 1, cost: 55 }] },
      ],
      summary: { stock_value: 1200, on_hand: 20 },
      total: 1,
    };
    expect(redactKeys(body, COST_KEYS)).toEqual({
      data: [
        { sku: 'A', price: 100, cost: null, variants: [{ id: 1, cost: null }] },
      ],
      summary: { stock_value: null, on_hand: 20 },
      total: 1,
    });
    // Không sửa object gốc — response có thể đang được cache/dùng lại
    expect(body.data[0].cost).toBe(60);
  });

  it('bỏ hẳn dòng lịch sử thay đổi giá vốn, giữ dòng giá bán', () => {
    const history = {
      data: [
        { id: '1', field: 'price', old_value: 90, new_value: 100 },
        { id: '2', field: 'cost', old_value: 50, new_value: 60 },
      ],
    };
    expect(redactKeys(history, COST_KEYS).data).toEqual([
      { id: '1', field: 'price', old_value: 90, new_value: 100 },
    ]);
  });

  it('lợi nhuận che luôn giá vốn — có doanh thu và giá vốn là tính ra lợi nhuận', () => {
    const kpi = { revenue: 1000, cost: 700, profit: 300, profit_margin: 0.3 };
    expect(redactKeys(kpi, PROFIT_KEYS)).toEqual({
      revenue: 1000,
      cost: null,
      profit: null,
      profit_margin: null,
    });
  });
});

describe('stripKeys', () => {
  it('xoá giá vốn khỏi body ghi để không ghi đè giá vốn thật bằng 0', () => {
    const body = {
      name: 'Nhẫn',
      variants: [{ sku: 'A', price: 100, cost: 0 }],
    };
    stripKeys(body, COST_KEYS);
    expect(body).toEqual({
      name: 'Nhẫn',
      variants: [{ sku: 'A', price: 100 }],
    });
  });
});

describe('withoutCostColumns', () => {
  const columns = [{ key: 'sku' }, { key: 'cost' }, { key: 'stock_value' }];

  it('người có quyền thấy đủ cột; admin luôn thấy', () => {
    expect(withoutCostColumns(columns, withCost)).toHaveLength(3);
    expect(withoutCostColumns(columns, adminAuth())).toHaveLength(3);
  });

  it('người không có quyền mất cột giá vốn trong file xuất và báo cáo', () => {
    expect(withoutCostColumns(columns, withoutCost)).toEqual([{ key: 'sku' }]);
  });
});

describe('CostVisibilityInterceptor', () => {
  function run(
    user: unknown,
    method: string,
    body: unknown,
    response: unknown,
  ) {
    const req = { user, method, body };
    const context = {
      switchToHttp: () => ({ getRequest: () => req }),
    } as never;
    const result = lastValueFrom(
      new CostVisibilityInterceptor().intercept(context, {
        handle: () => of(response),
      }) as never,
    );
    return { req, result };
  }

  it('không có quyền: che response và bỏ giá vốn khỏi body ghi', async () => {
    const { req, result } = run(
      withoutCost,
      'PUT',
      { variants: [{ price: 100, cost: 0 }] },
      { data: { cost: 60, price: 100 } },
    );
    expect(await result).toEqual({ data: { cost: null, price: 100 } });
    expect(req.body).toEqual({ variants: [{ price: 100 }] });
  });

  it('có quyền: không đụng gì', async () => {
    const { req, result } = run(
      withCost,
      'PUT',
      { variants: [{ cost: 70 }] },
      { data: { cost: 60 } },
    );
    expect(await result).toEqual({ data: { cost: 60 } });
    expect(req.body).toEqual({ variants: [{ cost: 70 }] });
  });
});

describe('ReportService — quyền báo cáo lợi nhuận', () => {
  const service = new ReportService(null as never);
  const reportOnly = staffAuth({ systemPermissions: ['report:view'] });
  const withProfit = staffAuth({
    systemPermissions: ['report:view', 'report:view_profit'],
  });

  it('thư viện báo cáo ẩn nhóm Lợi nhuận với người không có quyền', () => {
    const groups = (u: never) => service.catalog(u).data.map((g) => g.group);
    expect(groups(reportOnly as never)).not.toContain('loi_nhuan');
    expect(groups(withProfit as never)).toContain('loi_nhuan');
    expect(groups(adminAuth() as never)).toContain('loi_nhuan');
  });

  it('chạy thẳng một báo cáo lợi nhuận bằng URL cũng bị chặn', async () => {
    const profitId = service
      .catalog(withProfit)
      .data.find((g) => g.group === 'loi_nhuan')!.reports[0].id;
    await expect(
      service.run(profitId, {} as never, reportOnly),
    ).rejects.toThrow('Bạn không có quyền xem báo cáo lợi nhuận');
    await expect(
      service.exportExcel(profitId, {} as never, reportOnly),
    ).rejects.toThrow('Bạn không có quyền xem báo cáo lợi nhuận');
  });
});
