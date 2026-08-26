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
  location_id!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PoItemDto)
  items!: PoItemDto[];

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  deposit_amount?: number;
}

export class UpdatePurchaseOrderDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  supplier_id?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  location_id?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PoItemDto)
  items?: PoItemDto[];

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  deposit_amount?: number;
}

export class PoTransitionDto {
  @IsIn(['submit', 'close', 'cancel'])
  action!: 'submit' | 'close' | 'cancel';
}

export class ListPurchaseOrdersQueryDto {
  @IsOptional()
  @IsIn(['draft', 'pending', 'received', 'cancelled'])
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

export class ReiItemDto {
  @IsString()
  @IsNotEmpty()
  variant_id!: string;

  /** PO gắn riêng cho dòng này — ưu tiên hơn purchase_order_id của cả phiếu */
  @IsOptional()
  @IsString()
  purchase_order_id?: string;

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
  location_id!: string;

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

  /** Ký hiệu hóa đơn NCC — VD: 2C26MYY */
  @IsOptional()
  @IsString()
  invoice_symbol?: string;

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

export class PayGoodsReceiptDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  amount?: number;
}

export class ListGoodsReceiptsQueryDto {
  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  supplier_id?: string;

  /** Danh sách trạng thái thanh toán, phân tách dấu phẩy — VD: unpaid,partially_paid */
  @IsOptional()
  @IsString()
  payment_status?: string;

  @IsOptional()
  @IsDateString()
  date_from?: string;

  @IsOptional()
  @IsDateString()
  date_to?: string;

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
  location_id!: string;

  /** Có giá trị khi tạo "trả hàng nhập theo đơn" — gắn phiếu trả với đúng đơn nhập gốc */
  @IsOptional()
  @IsString()
  goods_receipt_id?: string;

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
  @IsDateString()
  date_from?: string;

  @IsOptional()
  @IsDateString()
  date_to?: string;

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
