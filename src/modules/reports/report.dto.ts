import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

/** Query chung cho mọi báo cáo — báo cáo bỏ qua bộ lọc nó không khai trong `filters`. */
export class RunReportQueryDto {
  /** ISO date (YYYY-MM-DD). Mặc định 30 ngày gần nhất. */
  @IsOptional()
  @IsString()
  from?: string;

  @IsOptional()
  @IsString()
  to?: string;

  @IsOptional()
  @IsString()
  location_id?: string;

  /** `orders.source_name` — kênh bán */
  @IsOptional()
  @IsString()
  channel?: string;

  @IsOptional()
  @IsString()
  staff_id?: string;

  @IsOptional()
  @IsIn(['day', 'week', 'month'])
  bucket?: 'day' | 'week' | 'month';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page_size?: number;
}

export class PinReportDto {
  /** Bộ lọc lưu kèm để mở lại báo cáo đúng như lúc ghim. */
  @IsOptional()
  @IsObject()
  filters?: Record<string, unknown>;
}

/** Query cho dashboard "Sản phẩm — Vận hành theo tháng". */
export class ProductMonthlyOpsQueryDto {
  /** "YYYY-MM". Mặc định tháng hiện tại. Bỏ qua nếu có `week`/`day`/`from`+`to`. */
  @IsOptional()
  @IsString()
  month?: string;

  /** "YYYY-Www" (ISO week, vd "2026-W32"). Chỉ chọn một trong `month`/`week`/`day`/`from`+`to`. */
  @IsOptional()
  @IsString()
  week?: string;

  /** "YYYY-MM-DD" — lọc đúng 1 ngày. Chỉ chọn một trong `month`/`week`/`day`/`from`+`to`. */
  @IsOptional()
  @IsString()
  day?: string;

  /** "YYYY-MM-DD" — mốc đầu khoảng tuỳ chọn, phải đi kèm `to`. */
  @IsOptional()
  @IsString()
  from?: string;

  /** "YYYY-MM-DD" — mốc cuối khoảng tuỳ chọn (bao gồm ngày này), phải đi kèm `from`. */
  @IsOptional()
  @IsString()
  to?: string;

  @IsOptional()
  @IsString()
  category_id?: string;

  @IsOptional()
  @IsString()
  location_id?: string;

  /** Số dòng tối đa cho bảng "Top sản phẩm được order nhiều nhất". */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  top_limit?: number;
}

/** Query cho màn "Tổng quan" (trang chủ). */
export class DashboardOverviewQueryDto {
  /** Kỳ xem. Mặc định `this_week` — giống Sapo. `custom` bắt buộc kèm `from` + `to`. */
  @IsOptional()
  @IsIn([
    'today',
    'yesterday',
    'this_week',
    'last_week',
    'this_month',
    'last_month',
    'this_year',
    'last_year',
    'custom',
  ])
  range?:
    | 'today'
    | 'yesterday'
    | 'this_week'
    | 'last_week'
    | 'this_month'
    | 'last_month'
    | 'this_year'
    | 'last_year'
    | 'custom';

  /** "YYYY-MM-DD" — chỉ dùng khi `range=custom`. */
  @IsOptional()
  @IsString()
  from?: string;

  /** "YYYY-MM-DD" — mốc cuối BAO GỒM, chỉ dùng khi `range=custom`. */
  @IsOptional()
  @IsString()
  to?: string;

  @IsOptional()
  @IsString()
  location_id?: string;

  /** `orders.source_name` — nguồn đơn */
  @IsOptional()
  @IsString()
  channel?: string;
}
