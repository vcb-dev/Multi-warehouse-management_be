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
