import { IsIn, IsOptional, IsString } from 'class-validator';

export class ChannelOverviewQueryDto {
  /** YYYY-MM-DD */
  @IsOptional()
  @IsString()
  from?: string;

  @IsOptional()
  @IsString()
  to?: string;

  @IsOptional()
  @IsString()
  location_id?: string;

  /** Khoá kênh (`tiktok`, `shopee`...). Bỏ trống = tổng hợp toàn bộ kênh. */
  @IsOptional()
  @IsString()
  channel?: string;
}

export class TiktokSyncDto {
  /** YYYY-MM-DD theo giờ Việt Nam. Bỏ trống = 7 ngày gần nhất. */
  @IsOptional()
  @IsString()
  from?: string;

  @IsOptional()
  @IsString()
  to?: string;

  /**
   * `created` (mặc định) lấy đơn MỚI của khoảng ngày; `updated` lấy đơn CÓ THAY ĐỔI trong
   * khoảng — cần khi muốn cập nhật trạng thái của đơn tạo từ trước khoảng đó.
   */
  @IsOptional()
  @IsIn(['created', 'updated'])
  filter_by?: 'created' | 'updated';
}
