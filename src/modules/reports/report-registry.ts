import { ReportDef, ReportGroup, REPORT_GROUP_LABEL } from './report.types';
import { INVENTORY_REPORTS } from './reports/inventory.report';
import { PROFIT_REPORTS } from './reports/profit.report';
import { SALES_REVENUE_REPORTS } from './reports/sales-revenue.report';

/**
 * Danh mục báo cáo. Thêm báo cáo mới = thêm một `ReportDef` vào đây; màn danh sách và màn
 * chi tiết ở frontend đều dựng từ metadata này nên không phải sửa UI.
 *
 * Đợt 1 theo catalog Sapo: Bán hàng (doanh thu) + Kho + Lợi nhuận. Đợt 2 dự kiến: Trả hàng,
 * Thông tin giao hàng, Khách hàng, Thanh toán.
 */
const ALL_REPORTS: ReportDef[] = [
  ...SALES_REVENUE_REPORTS,
  ...INVENTORY_REPORTS,
  ...PROFIT_REPORTS,
];

const BY_ID = new Map(ALL_REPORTS.map((r) => [r.id, r]));

export function getReport(id: string): ReportDef | undefined {
  return BY_ID.get(id);
}

export function listReports(): ReportDef[] {
  return ALL_REPORTS;
}

/** Catalog cho màn thư viện — gom theo nhóm, bỏ hàm `run`. */
export function reportCatalog() {
  const groups: ReportGroup[] = ['ban_hang', 'kho', 'loi_nhuan'];
  return groups.map((group) => ({
    group,
    group_label: REPORT_GROUP_LABEL[group],
    reports: ALL_REPORTS.filter((r) => r.group === group).map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      group: r.group,
      group_label: REPORT_GROUP_LABEL[group],
      filters: r.filters,
      note: r.note ?? null,
    })),
  }));
}
