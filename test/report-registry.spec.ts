import {
  getReport,
  listReports,
  reportCatalog,
} from '../src/modules/reports/report-registry';

/**
 * Metadata của registry là hợp đồng giữa backend và màn báo cáo động ở frontend: bảng, chart
 * và form lọc đều dựng từ đây. Sai metadata thì UI hỏng mà `tsc` không báo gì.
 */
describe('BC-1 metadata registry báo cáo', () => {
  const reports = listReports();

  it('id không trùng nhau', () => {
    const ids = reports.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('mọi báo cáo đều có cột và cột đầu là nhãn nhóm', () => {
    for (const r of reports) {
      expect(r.columns.length).toBeGreaterThan(1);
      expect(r.columns[0].key).toBe('label');
    }
  });

  it('key cột không trùng trong cùng một báo cáo', () => {
    for (const r of reports) {
      const keys = r.columns.map((c) => c.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('chart chỉ trỏ tới cột thực sự tồn tại', () => {
    for (const r of reports) {
      if (!r.chart) continue;
      const keys = new Set(r.columns.map((c) => c.key));
      expect(keys.has(r.chart.x)).toBe(true);
      for (const y of r.chart.y) expect(keys.has(y)).toBe(true);
    }
  });

  it('báo cáo gom theo thời gian mới được khai bộ lọc bucket', () => {
    for (const r of reports) {
      if (!r.filters.includes('bucket')) continue;
      // bucket chỉ có nghĩa khi trục nhãn là thời gian
      expect(r.columns[0].label).toBe('Thời gian');
    }
  });

  it('tồn kho không nhận bộ lọc thời gian — đó là ảnh chụp hiện tại', () => {
    expect(getReport('ton-kho')!.filters).not.toContain('date_range');
    expect(getReport('so-kho')!.filters).toContain('date_range');
  });

  it('báo cáo lợi nhuận phải cảnh báo về nguồn giá vốn', () => {
    for (const r of reports.filter((x) => x.group === 'loi_nhuan')) {
      expect(r.note).toBeTruthy();
    }
  });

  it('catalog gom đủ 3 nhóm và không bỏ sót báo cáo nào', () => {
    const catalog = reportCatalog();
    expect(catalog.map((g) => g.group)).toEqual([
      'ban_hang',
      'kho',
      'loi_nhuan',
    ]);
    const inCatalog = catalog.flatMap((g) => g.reports).length;
    expect(inCatalog).toBe(reports.length);
  });

  it('catalog không lộ hàm run ra ngoài API', () => {
    for (const r of reportCatalog().flatMap((g) => g.reports)) {
      expect('run' in r).toBe(false);
    }
  });
});
