import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';

export class ListAgedInventoryQueryDto {
  /** Chỉ lấy phiên bản đã tồn ít nhất ngần này ngày (tính tới ngày snapshot). Mặc định 30. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(3650)
  min_days?: number;

  /** Chỉ lấy phiên bản có hàng ở kho này (id kho local). */
  @IsOptional()
  @IsString()
  location_id?: string;

  /** Nhóm hàng, phân tách dấu phẩy — VD `NHẪN,BÔNG TAI`. */
  @IsOptional()
  @IsString()
  product_group?: string;

  /** Tìm theo SKU hoặc tên sản phẩm. */
  @IsOptional()
  @IsString()
  q?: string;

  /** Ngày snapshot `YYYY-MM-DD`; bỏ trống = snapshot mới nhất. */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'snapshot_date phải dạng YYYY-MM-DD',
  })
  snapshot_date?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  page_size?: number;
}
