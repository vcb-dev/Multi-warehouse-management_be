import {
  ArrayNotEmpty,
  IsArray,
  IsDateString,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';

export class CreateApiKeyDto {
  @IsString()
  @MinLength(3)
  name: string;

  /** vd `product-monthly-ops` — endpoint tích hợp key này được phép gọi. */
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  scopes: string[];

  /** Bỏ trống = không giới hạn (xem được mọi kho). */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  location_ids?: string[];

  @IsOptional()
  @IsDateString()
  expires_at?: string;
}
