/**
 * Bộ lọc kho của báo cáo: một kho, nhiều kho (`location_ids=1,4`), hoặc để trống.
 * Không đụng DB — Prisma giả chỉ ghi lại danh sách kho mà SQL báo cáo nhận được.
 */
import { ReportService } from '../src/modules/reports/report.service';
import { adminAuth, staffAuth } from './helpers/auth';

/**
 * Lấy danh sách kho từ `IN (${Prisma.join(ctx.locationIds)})` trong câu SQL báo cáo.
 * `Prisma.Sql` chỉ là type ở runtime nên nhận diện theo hình dạng `{ strings, values }`.
 */
function locationsSentToSql(call: unknown[]): string[] {
  const joined = call
    .slice(1)
    .find(
      (v): v is { values: unknown[] } =>
        typeof v === 'object' && v !== null && 'strings' in v && 'values' in v,
    );
  return (joined?.values ?? []).map(String);
}

function makeService() {
  const queryRaw = jest.fn().mockResolvedValue([]);
  const prisma = {
    $queryRaw: queryRaw,
    location: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ id: 1n }, { id: 4n }, { id: 7n }]),
    },
  };
  return { service: new ReportService(prisma as never), queryRaw };
}

describe('ReportService — chọn nhiều kho', () => {
  const staff = staffAuth({
    systemPermissions: ['report:view'],
    locationIds: [1n, 4n],
  });

  it('location_ids nhiều kho đi thẳng vào SQL, bỏ trùng', async () => {
    const { service, queryRaw } = makeService();
    await service.run(
      'inventory-stock',
      { location_ids: '1, 4,1' } as never,
      staff,
    );
    expect(locationsSentToSql(queryRaw.mock.calls[0])).toEqual(['1', '4']);
  });

  it('location_id cũ (báo cáo đã ghim) vẫn chạy, kể cả khi lưu nhiều kho', async () => {
    const { service, queryRaw } = makeService();
    await service.run('inventory-stock', { location_id: '4' } as never, staff);
    expect(locationsSentToSql(queryRaw.mock.calls[0])).toEqual(['4']);

    await service.run(
      'inventory-stock',
      { location_id: '1,4' } as never,
      staff,
    );
    expect(locationsSentToSql(queryRaw.mock.calls[1])).toEqual(['1', '4']);
  });

  it('location_ids được ưu tiên hơn location_id', async () => {
    const { service, queryRaw } = makeService();
    await service.run(
      'inventory-ledger',
      { location_id: '1', location_ids: '4' } as never,
      staff,
    );
    expect(locationsSentToSql(queryRaw.mock.calls[0])).toEqual(['4']);
  });

  it('một kho ngoài phạm vi được gán làm hỏng cả yêu cầu', async () => {
    const { service, queryRaw } = makeService();
    await expect(
      service.run('inventory-stock', { location_ids: '1,7' } as never, staff),
    ).rejects.toThrow('FORBIDDEN_SCOPE');
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('mã kho không phải số báo 422 thay vì vỡ BigInt thành 500', async () => {
    const { service } = makeService();
    await expect(
      service.run('inventory-stock', { location_ids: '1,abc' } as never, staff),
    ).rejects.toThrow('Mã kho không hợp lệ');
  });

  it('để trống: nhân viên lấy kho được gán, admin lấy mọi kho', async () => {
    const { service, queryRaw } = makeService();
    await service.run('inventory-stock', {} as never, staff);
    expect(locationsSentToSql(queryRaw.mock.calls[0])).toEqual(['1', '4']);

    await service.run(
      'inventory-stock',
      { location_ids: '' } as never,
      adminAuth(),
    );
    expect(locationsSentToSql(queryRaw.mock.calls[1])).toEqual(['1', '4', '7']);
  });

  it('xuất Excel nhận cùng bộ lọc nhiều kho', async () => {
    const { service, queryRaw } = makeService();
    await service.exportExcel(
      'inventory-stock',
      { location_ids: '1,4' } as never,
      staff,
    );
    expect(locationsSentToSql(queryRaw.mock.calls[0])).toEqual(['1', '4']);
  });
});
