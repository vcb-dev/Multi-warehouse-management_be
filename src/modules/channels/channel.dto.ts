import { IsOptional, IsString } from 'class-validator';

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
