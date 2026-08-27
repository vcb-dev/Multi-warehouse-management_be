import {
  bucketLabels,
  resolveDashboardPeriod,
} from '../src/modules/reports/reports/dashboard-overview.report';

/** Thứ tư 26/08/2026, 15:30 — cùng mốc với ảnh chụp màn Tổng quan của Sapo dùng để đối chiếu. */
const NOW = new Date(2026, 7, 26, 15, 30, 0);

const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

describe('kỳ xem của màn Tổng quan', () => {
  it('"Tuần này" lấy từ thứ 2, so với đúng khoảng đó của tuần trước', () => {
    const p = resolveDashboardPeriod('this_week', undefined, undefined, NOW);
    expect(ymd(p.from)).toBe('2026-08-24');
    expect(ymd(p.prevFrom)).toBe('2026-08-17');
    // Kỳ trước cắt đúng độ dài đã trôi qua (17/08 → 19/08), không lấy trọn 7 ngày
    expect(ymd(new Date(p.prevTo.getTime() - 1))).toBe('2026-08-19');
  });

  it('kỳ so sánh KHÔNG BAO GIỜ đè lên kỳ đang xem', () => {
    const ranges = [
      'today',
      'yesterday',
      'this_week',
      'last_week',
      'this_month',
      'last_month',
      'this_year',
      'last_year',
    ] as const;
    for (const range of ranges) {
      const p = resolveDashboardPeriod(range, undefined, undefined, NOW);
      expect(p.prevFrom.getTime()).toBeLessThan(p.prevTo.getTime());
      expect(p.prevTo.getTime()).toBeLessThanOrEqual(p.from.getTime());
    }
  });

  it('kỳ đang chạy so với đúng độ dài đã trôi qua của kỳ trước', () => {
    for (const range of [
      'today',
      'this_week',
      'this_month',
      'this_year',
    ] as const) {
      const p = resolveDashboardPeriod(range, undefined, undefined, NOW);
      expect(p.to.getTime() - p.from.getTime()).toBe(
        p.prevTo.getTime() - p.prevFrom.getTime(),
      );
    }
  });

  it('"Tháng trước" so với trọn tháng liền trước, không cộng dồn theo số ngày', () => {
    const p = resolveDashboardPeriod('last_month', undefined, undefined, NOW);
    expect(ymd(p.from)).toBe('2026-07-01');
    expect(ymd(p.prevFrom)).toBe('2026-06-01');
    // Tháng 7 có 31 ngày, tháng 6 chỉ 30 — cộng theo độ dài sẽ ra 02/07, đè lên kỳ đang xem
    expect(ymd(p.prevTo)).toBe('2026-07-01');
  });

  it('kỳ trọn vẹn (hôm qua, tuần/tháng/năm trước) kết thúc đúng lúc kỳ hiện tại bắt đầu', () => {
    expect(
      ymd(resolveDashboardPeriod('yesterday', undefined, undefined, NOW).to),
    ).toBe('2026-08-26');
    expect(
      ymd(resolveDashboardPeriod('last_week', undefined, undefined, NOW).to),
    ).toBe('2026-08-24');
    expect(
      ymd(resolveDashboardPeriod('last_month', undefined, undefined, NOW).to),
    ).toBe('2026-08-01');
    expect(
      ymd(resolveDashboardPeriod('last_year', undefined, undefined, NOW).to),
    ).toBe('2026-01-01');
  });

  it('"Tùy chọn" tính cả ngày cuối, kỳ trước là khoảng liền kề cùng độ dài', () => {
    const p = resolveDashboardPeriod('custom', '2026-08-01', '2026-08-10', NOW);
    expect(ymd(p.from)).toBe('2026-08-01');
    expect(ymd(new Date(p.to.getTime() - 1))).toBe('2026-08-10');
    expect(ymd(p.prevFrom)).toBe('2026-07-22');
  });

  it('chọn đơn vị gom nhóm theo độ dài kỳ: giờ → ngày → tháng', () => {
    expect(
      resolveDashboardPeriod('today', undefined, undefined, NOW).bucket,
    ).toBe('hour');
    expect(
      resolveDashboardPeriod('this_week', undefined, undefined, NOW).bucket,
    ).toBe('day');
    expect(
      resolveDashboardPeriod('this_month', undefined, undefined, NOW).bucket,
    ).toBe('day');
    expect(
      resolveDashboardPeriod('this_year', undefined, undefined, NOW).bucket,
    ).toBe('month');
  });
});

describe('nhãn trục X', () => {
  it('phủ đúng số ô của kỳ và dừng ở ô đang dở', () => {
    const today = resolveDashboardPeriod('today', undefined, undefined, NOW);
    // 00:00 đến 15:xx là 16 ô giờ
    expect(bucketLabels(today)).toHaveLength(16);
    expect(bucketLabels(today)[0]).toBe('00:00');
    expect(bucketLabels(today)[15]).toBe('15:00');

    expect(
      bucketLabels(
        resolveDashboardPeriod('this_week', undefined, undefined, NOW),
      ),
    ).toEqual(['24/08', '25/08', '26/08']);

    const year = bucketLabels(
      resolveDashboardPeriod('this_year', undefined, undefined, NOW),
    );
    expect(year).toHaveLength(8);
    expect(year[0]).toBe('01/2026');
  });

  it('kỳ chưa có ô nào vẫn trả 1 nhãn — biểu đồ không được rỗng khung', () => {
    const midnight = new Date(2026, 7, 26, 0, 0, 0);
    expect(
      bucketLabels(
        resolveDashboardPeriod('today', undefined, undefined, midnight),
      ),
    ).toHaveLength(1);
  });
});
