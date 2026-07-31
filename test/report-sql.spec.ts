import { Prisma } from '@prisma/client';
import {
  EFFECTIVE_QTY,
  UNIT_COST,
  bucketExpr,
  num,
  orderScopeSql,
} from '../src/modules/reports/reports/report-sql';
import type { ReportContext } from '../src/modules/reports/report.types';

function ctx(over: Partial<ReportContext> = {}): ReportContext {
  return {
    prisma: {} as ReportContext['prisma'],
    user: { userId: 1n, email: '', roles: [], locationIds: [1n] },
    locationIds: [1n, 2n],
    from: new Date('2026-01-01'),
    to: new Date('2026-02-01'),
    bucket: 'day',
    page: 1,
    pageSize: 20,
    ...over,
  };
}

/** Prisma.Sql giữ phần chữ ở `strings` và giá trị ở `values`. */
const sqlText = (s: Prisma.Sql) => s.strings.join('?');

describe('BC-2 quy tắc lọc đơn cho báo cáo', () => {
  it('LUÔN loại đơn huỷ khỏi doanh thu', () => {
    expect(sqlText(orderScopeSql(ctx()))).toContain(`"status" <> 'cancelled'`);
  });

  it('KHÔNG lọc theo status=closed — Sapo gần như không đóng đơn', () => {
    const text = sqlText(orderScopeSql(ctx()));
    expect(text).not.toContain(`'closed'`);
    expect(text).not.toContain('fulfillment_status');
  });

  it('luôn giới hạn theo kho user được phép đọc', () => {
    const scope = orderScopeSql(ctx({ locationIds: [7n, 9n] }));
    expect(sqlText(scope)).toContain('location_id');
    expect(scope.values).toEqual(expect.arrayContaining([7n, 9n]));
  });

  it('khoảng thời gian là nửa mở [from, to) để không đếm trùng mốc', () => {
    const scope = orderScopeSql(ctx());
    const text = sqlText(scope);
    expect(text).toContain('"created_on" >=');
    expect(text).toContain('"created_on" <');
    expect(text).not.toContain('"created_on" <=');
  });

  it('chỉ thêm điều kiện kênh/nhân viên khi thực sự có lọc', () => {
    expect(sqlText(orderScopeSql(ctx()))).not.toContain('source_name');
    expect(sqlText(orderScopeSql(ctx({ channel: 'shopee' })))).toContain(
      'source_name',
    );
    expect(sqlText(orderScopeSql(ctx()))).not.toContain('assignee_id');
    expect(sqlText(orderScopeSql(ctx({ staffId: 5n })))).toContain(
      'assignee_id',
    );
  });
});

describe('BC-3 số lượng và giá vốn của dòng hàng', () => {
  it('ưu tiên current_quantity — Sapo tính số lượng sau khi trừ dòng huỷ/hoàn', () => {
    const text = sqlText(EFFECTIVE_QTY);
    expect(text).toContain('current_quantity');
    expect(text.indexOf('current_quantity')).toBeLessThan(
      text.indexOf('"quantity"'),
    );
  });

  it('giá vốn ưu tiên snapshot lúc bán, thiếu mới lấy giá vốn hiện tại', () => {
    const text = sqlText(UNIT_COST);
    expect(text.indexOf('cost_price')).toBeLessThan(text.indexOf('v."cost"'));
    // không có cả hai thì phải là 0, không được NULL làm hỏng phép SUM
    expect(text).toContain('0');
  });
});

describe('BC-4 gom nhóm thời gian', () => {
  it('mỗi bucket dùng đúng DATE_TRUNC tương ứng', () => {
    expect(sqlText(bucketExpr('day'))).toContain(`'day'`);
    expect(sqlText(bucketExpr('week'))).toContain(`'week'`);
    expect(sqlText(bucketExpr('month'))).toContain(`'month'`);
  });
});

describe('BC-5 chuyển Decimal sang number', () => {
  it('null/undefined thành 0 để phép cộng dồn không ra NaN', () => {
    expect(num(null)).toBe(0);
    expect(num(undefined)).toBe(0);
  });

  it('giữ nguyên giá trị của Decimal và number', () => {
    expect(num(new Prisma.Decimal('1234.56'))).toBe(1234.56);
    expect(num(42)).toBe(42);
  });
});
