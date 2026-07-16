import { InventoryBucket } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

function toBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === true || value === 'true' || value === '1') return true;
  if (value === false || value === 'false' || value === '0') return false;
  return undefined;
}

export class ListInventoryQueryDto {
  @IsOptional()
  @IsString()
  warehouse_id?: string;

  @IsOptional()
  @IsString()
  variant_id?: string;

  /** Danh sách variant_id, phân tách dấu phẩy — dùng để giới hạn kết quả về đúng tập sản phẩm cho trước (VD: sản phẩm có trong PO của NCC) */
  @IsOptional()
  @IsString()
  variant_ids?: string;

  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @Transform(({ value }) => toBoolean(value))
  @IsBoolean()
  low_stock?: boolean;

  @IsOptional()
  @IsIn(['in_stock', 'out_of_stock'])
  stock_status?: 'in_stock' | 'out_of_stock';

  /** Đầu kỳ NXT (ISO date) — mặc định đầu tháng hiện tại; kỳ kết thúc ở hiện tại */
  @IsOptional()
  @IsString()
  date_from?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page_size?: number = 20;
}

export class ListMovementsQueryDto {
  @IsOptional()
  @IsString()
  warehouse_id?: string;

  @IsOptional()
  @IsEnum(InventoryBucket)
  bucket?: InventoryBucket;

  @IsOptional()
  @IsString()
  from?: string;

  @IsOptional()
  @IsString()
  to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page_size?: number = 20;
}

export class ListLotsQueryDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  variant_id?: string;

  @IsOptional()
  @IsString()
  warehouse_id?: string;

  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page_size?: number = 20;
}
