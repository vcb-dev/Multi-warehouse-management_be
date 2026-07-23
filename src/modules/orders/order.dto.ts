import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { OrderDeliveryMode, OrderSource } from '@prisma/client';

export class OrderItemDto {
  @IsString()
  variant_id!: string;

  @IsString()
  warehouse_id!: string;

  @IsInt()
  @Min(1)
  quantity!: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  price?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  discount?: number;
}

export class CreateOrderDto {
  @IsString()
  branch_id!: string;

  @IsOptional()
  @IsEnum(OrderSource)
  source?: OrderSource;

  @IsOptional()
  @IsString()
  customer_id?: string;

  @IsOptional()
  @IsString()
  assigned_to?: string;

  @IsOptional()
  @IsString()
  code?: string;

  @IsOptional()
  @IsString()
  ordered_at?: string;

  @IsOptional()
  @IsString()
  expected_delivery_at?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items!: OrderItemDto[];

  @IsOptional()
  @IsNumber()
  @Min(0)
  discount_total?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  shipping_fee?: number;

  @IsOptional()
  @IsString()
  shipping_method?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  tax_rate?: number;

  /** Số tiền khách thanh toán ngay khi tạo đơn — phần còn lại ghi công nợ */
  @IsOptional()
  @IsNumber()
  @Min(0)
  paid_amount?: number;

  // --- Giao hàng (chỉ lưu thông tin, không tự tạo vận đơn) ---
  @IsOptional()
  @IsEnum(OrderDeliveryMode)
  delivery_mode?: OrderDeliveryMode;

  @IsOptional()
  @IsString()
  delivery_to_name?: string;

  @IsOptional()
  @IsString()
  delivery_to_phone?: string;

  @IsOptional()
  @IsString()
  delivery_to_address?: string;

  @IsOptional()
  @IsString()
  delivery_to_ward?: string;

  @IsOptional()
  @IsString()
  delivery_to_district?: string;

  @IsOptional()
  @IsString()
  delivery_to_province?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  delivery_cod_amount?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  delivery_weight_grams?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  delivery_length_cm?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  delivery_width_cm?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  delivery_height_cm?: number;

  @IsOptional()
  @IsString()
  delivery_requirement?: string;

  @IsOptional()
  @IsString()
  delivery_note?: string;

  // --- Hóa đơn điện tử (chỉ lưu thông tin, không tích hợp tra cứu/xuất thật) ---
  @IsOptional()
  @IsString()
  invoice_tax_code?: string;

  @IsOptional()
  @IsString()
  invoice_company_name?: string;

  @IsOptional()
  @IsString()
  invoice_address?: string;

  @IsOptional()
  @IsString()
  invoice_buyer_name?: string;

  @IsOptional()
  @IsString()
  invoice_id_card?: string;

  @IsOptional()
  @IsString()
  invoice_budget_code?: string;

  @IsOptional()
  @IsString()
  invoice_phone?: string;

  @IsOptional()
  @IsString()
  invoice_email?: string;

  @IsOptional()
  @IsBoolean()
  invoice_sell_to_consumer?: boolean;
}

export class ListOrdersQueryDto {
  @IsOptional()
  @IsString()
  status?: string;

  /** 'thieu_hang' | 'du_hang' — lọc theo tồn vật lý có đủ cho các dòng hàng
   * hay không; chỉ áp dụng cho đơn chưa xử lý (ordered/processing). */
  @IsOptional()
  @IsString()
  stock_status?: string;

  @IsOptional()
  @IsString()
  branch_id?: string;

  @IsOptional()
  @IsString()
  warehouse_id?: string;

  @IsOptional()
  @IsString()
  source?: string;

  /** Danh sách nguồn cách nhau bởi dấu phẩy, ví dụ `shopee,facebook` */
  @IsOptional()
  @IsString()
  sources?: string;

  @IsOptional()
  @IsString()
  assigned_to?: string;

  @IsOptional()
  @IsString()
  from?: string;

  @IsOptional()
  @IsString()
  to?: string;

  @IsOptional()
  @IsString()
  tags?: string;

  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  page?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  page_size?: number;
}

export class UpdateOrderDto {
  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsString()
  assigned_to?: string;

  @IsOptional()
  @IsString()
  expected_delivery_at?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  discount_total?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  shipping_fee?: number;

  @IsOptional()
  @IsString()
  shipping_method?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  tax_rate?: number;
}

export class OrderTransitionDto {
  @IsString()
  @MinLength(1)
  action!: 'cancel' | 'complete' | 'processing' | 'ship';
}

export class ListOrderReturnsQueryDto {
  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  page?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  page_size?: number;
}

export class PayOrderDto {
  /** Bỏ trống = thanh toán toàn bộ số còn phải thu */
  @IsOptional()
  @IsNumber()
  @Min(0)
  amount?: number;
}

export class CreateCustomerDebtAdjustmentDto {
  @IsNumber()
  amount!: number;

  @IsString()
  @MinLength(1)
  reason!: string;
}

export class ListCustomerLedgerQueryDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  page?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  page_size?: number;
}

export class CreateOrderReturnDto {
  @IsString()
  order_id!: string;

  @IsOptional()
  @IsString()
  reason?: string;

  @IsNumber()
  @Min(0)
  refund_amount!: number;

  @IsOptional()
  restock?: boolean;

  /** true: trừ vào công nợ KH (không tạo phiếu chi); false/mặc định: hoàn tiền ngay */
  @IsOptional()
  @IsBoolean()
  deduct_from_debt?: boolean;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OrderReturnItemDto)
  items!: OrderReturnItemDto[];
}

export class OrderReturnItemDto {
  @IsString()
  variant_id!: string;

  @IsString()
  warehouse_id!: string;

  @IsInt()
  @Min(1)
  quantity!: number;

  @IsNumber()
  @Min(0)
  price!: number;
}

export class ChannelWebhookDto {
  @IsEnum(OrderSource)
  source!: OrderSource;

  @IsOptional()
  @IsString()
  external_id?: string;

  @IsOptional()
  @IsString()
  customer_phone?: string;

  @IsOptional()
  @IsString()
  customer_name?: string;

  @IsString()
  branch_id!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items!: OrderItemDto[];
}
