import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class StnItemDto {
  @IsString()
  @IsNotEmpty()
  variant_id!: string;

  @IsString()
  @IsNotEmpty()
  lot_id!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  quantity!: number;
}

export class CreateStockTransferDto {
  @IsString()
  @IsNotEmpty()
  from_warehouse_id!: string;

  @IsString()
  @IsNotEmpty()
  to_warehouse_id!: string;

  /** Mã phiếu tự nhập — bỏ trống thì hệ thống tự sinh (STN000001, ...) */
  @IsOptional()
  @IsString()
  code?: string;

  @IsOptional()
  @IsString()
  note?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => StnItemDto)
  items!: StnItemDto[];
}

/** Sửa phiếu chuyển — chỉ áp dụng cho phiếu ở trạng thái nháp */
export class UpdateStockTransferDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  from_warehouse_id?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  to_warehouse_id?: string;

  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => StnItemDto)
  items?: StnItemDto[];
}

export class StnTransitionDto {
  @IsIn(['submit', 'ship'])
  action!: 'submit' | 'ship';
}

export class ListStockTransfersQueryDto {
  @IsOptional()
  @IsString()
  status?: string;

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
