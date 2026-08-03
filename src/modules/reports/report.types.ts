import { AuthUser } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../prisma/prisma.service';

/** Nhóm báo cáo — đặt theo catalog của Sapo (help.sapo.vn). */
export type ReportGroup = 'ban_hang' | 'kho' | 'loi_nhuan';

export const REPORT_GROUP_LABEL: Record<ReportGroup, string> = {
  ban_hang: 'Bán hàng',
  kho: 'Kho',
  loi_nhuan: 'Lợi nhuận',
};

/** Bộ lọc một báo cáo chấp nhận — frontend dựng form từ danh sách này. */
export type ReportFilterKey =
  | 'date_range'
  | 'location'
  | 'channel'
  | 'staff'
  | 'bucket';

/** Cách gom nhóm theo thời gian. */
export type TimeBucket = 'day' | 'week' | 'month';

export type ReportColumnType = 'text' | 'number' | 'money' | 'percent' | 'date';

export type ReportColumn = {
  key: string;
  label: string;
  type: ReportColumnType;
  /** Cột có được cộng vào dòng tổng không — tỉ lệ/giá trung bình thì không. */
  summable?: boolean;
};

export type ReportChart = {
  type: 'line' | 'bar';
  /** key cột dùng làm trục X */
  x: string;
  /** các key cột vẽ thành series */
  y: string[];
};

/** Bộ lọc đã chuẩn hoá, service dựng sẵn trước khi gọi `run()`. */
export type ReportContext = {
  prisma: PrismaService;
  user: AuthUser;
  /** Đã áp scope kho của user — luôn là danh sách kho được phép đọc. */
  locationIds: bigint[];
  from: Date;
  to: Date;
  bucket: TimeBucket;
  channel?: string;
  staffId?: bigint;
  page: number;
  pageSize: number;
  /** true khi export: bỏ phân trang, lấy toàn bộ. */
  all?: boolean;
};

export type ReportRow = Record<string, string | number | null>;

export type ReportResult = {
  rows: ReportRow[];
  /** Dòng tổng — key trùng với `columns`. */
  summary: ReportRow;
  total: number;
};

export type ReportDef = {
  id: string;
  group: ReportGroup;
  name: string;
  description: string;
  filters: ReportFilterKey[];
  columns: ReportColumn[];
  chart?: ReportChart;
  /** Cảnh báo hiển thị trên màn báo cáo (vd nguồn giá vốn chưa chuẩn). */
  note?: string;
  run(ctx: ReportContext): Promise<ReportResult>;
};
