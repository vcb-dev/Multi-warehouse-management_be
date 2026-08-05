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
  /** "YYYY-MM". Mặc định tháng hiện tại. Bỏ qua nếu có `week`. */
  @IsOptional()
  @IsString()
  month?: string;

  /** "YYYY-Www" (ISO week, vd "2026-W32"). Có giá trị thì ưu tiên hơn `month`. */
  @IsOptional()
  @IsString()
  week?: string;

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
