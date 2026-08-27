import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/** Các màn danh sách có bộ lọc lưu sẵn. */
export const SAVED_FILTER_RESOURCES = [
  'orders',
  'inventory',
  'products',
  'shipments',
] as const;

export type SavedFilterResource = (typeof SAVED_FILTER_RESOURCES)[number];

export class ListSavedFiltersQueryDto {
  @IsIn(SAVED_FILTER_RESOURCES)
  resource!: SavedFilterResource;
}

export class CreateSavedFilterDto {
  @IsIn(SAVED_FILTER_RESOURCES)
  resource!: SavedFilterResource;

  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name!: string;

  /**
   * Query string đã chuẩn hoá, vd `financial_status=pending&tags=vip`.
   * Cho phép rỗng: "tất cả" cũng là một bộ lọc hợp lệ.
   */
  @IsString()
  @MaxLength(2000)
  query!: string;

  /** Đặt true để lưu thành bộ lọc dùng chung toàn shop (chỉ admin). */
  @IsOptional()
  @IsBoolean()
  shared?: boolean;
}

export class UpdateSavedFilterDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  query?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  position?: number;
}
