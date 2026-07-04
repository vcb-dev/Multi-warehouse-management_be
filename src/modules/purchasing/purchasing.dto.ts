import { Type } from 'class-transformer';
import {
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class PoItemDto {
  @IsString()
  @IsNotEmpty()
  variant_id!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  quantity!: number;

  @Type(() => Number)
  @Min(0)
  unit_price!: number;
}

export class CreatePurchaseOrderDto {
  @IsString()
  @IsNotEmpty()
  supplier_id!: string;

  @IsString()
  @IsNotEmpty()
  branch_id!: string;

  @IsString()
  @IsNotEmpty()
  warehouse_id!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PoItemDto)
  items!: PoItemDto[];
}

export class PoTransitionDto {
  @IsIn(['submit', 'close', 'cancel'])
  action!: 'submit' | 'close' | 'cancel';
}

export class ListPurchaseOrdersQueryDto {
  @IsOptional()
  @IsIn(['don_nhap', 'cho_nhap', 'da_nhap', 'huy'])
  status?: string;

  @IsOptional()
  @IsString()
  supplier_id?: string;

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

export class LotInputDto {
  @IsString()
  @IsNotEmpty()
  code!: string;

  @IsOptional()
  @IsDateString()
  manufactured_at?: string;

  @IsOptional()
  @IsDateString()
  expired_at?: string;
}

export class ReiItemDto {
  @IsString()
  @IsNotEmpty()
  variant_id!: string;

  @ValidateNested()
  @Type(() => LotInputDto)
  lot!: LotInputDto;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  quantity!: number;

  @Type(() => Number)
  @Min(0)
  unit_price!: number;
}

export class CreateGoodsReceiptDto {
  @IsString()
  @IsNotEmpty()
  supplier_id!: string;

  @IsString()
  @IsNotEmpty()
  warehouse_id!: string;

  @IsOptional()
  @IsString()
  purchase_order_id?: string;

  @IsOptional()
  @IsString()
  assigned_to_id?: string;

  @IsOptional()
  @IsDateString()
  expected_receipt_at?: string;

  @IsOptional()
  @IsDateString()
  invoice_at?: string;

  @IsOptional()
  @IsString()
  order_code?: string;

  @IsOptional()
  @IsString()
  reference_code?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  discount_amount?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  extra_cost?: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReiItemDto)
  items!: ReiItemDto[];
}

export class ListGoodsReceiptsQueryDto {
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

export class PvnItemDto {
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

  @Type(() => Number)
  @Min(0)
  unit_price!: number;
}

export class CreatePurchaseReturnDto {
  @IsString()
  @IsNotEmpty()
  supplier_id!: string;

  @IsString()
  @IsNotEmpty()
  warehouse_id!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PvnItemDto)
  items!: PvnItemDto[];
}

export class ListPurchaseReturnsQueryDto {
  @IsOptional()
  @IsString()
  supplier_id?: string;

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
