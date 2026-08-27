import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
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
  location_id!: string;

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

/** Sapo `shipping_address` / `billing_address` */
export class ShippingAddressDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() first_name?: string;
  @IsOptional() @IsString() last_name?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() address1?: string;
  @IsOptional() @IsString() address2?: string;
  @IsOptional() @IsString() ward?: string;
  @IsOptional() @IsString() ward_code?: string;
  @IsOptional() @IsString() district?: string;
  @IsOptional() @IsString() district_code?: string;
  @IsOptional() @IsString() province?: string;
  @IsOptional() @IsString() province_code?: string;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsString() country?: string;
  @IsOptional() @IsString() country_code?: string;
  @IsOptional() @IsString() zip?: string;
  @IsOptional() @IsString() company?: string;
}

export class CreateOrderDto {
  @IsString()
  location_id!: string;

  /** Kênh bán (facebook/tiktokshop/shopee/web/pos/zalo/...) — chuỗi tự do theo Sapo */
  @IsOptional()
  @IsString()
  source_name?: string;

  @IsOptional()
  @IsString()
  customer_id?: string;

  @IsOptional()
  @IsString()
  assigned_to?: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  created_on?: string;

  @IsOptional()
  @IsString()
  expected_delivery_date?: string;

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
  total_discounts?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  total_shipping_price?: number;

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
  total_received?: number;

  // --- Giao hàng (chỉ lưu thông tin, không tự tạo vận đơn) ---
  @IsOptional()
  @IsEnum(OrderDeliveryMode)
  delivery_mode?: OrderDeliveryMode;

  /// Sapo gửi/nhận địa chỉ giao hàng dưới dạng object `shipping_address`
  @IsOptional()
  @ValidateNested()
  @Type(() => ShippingAddressDto)
  shipping_address?: ShippingAddressDto;

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
  location_id?: string;

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

  /** Danh sách tag cách nhau bởi dấu phẩy — đơn khớp MỘT tag bất kỳ là đủ. */
  @IsOptional()
  @IsString()
  tags?: string;

  @IsOptional()
  @IsString()
  q?: string;

  // --- Trạng thái (chọn nhiều, ngăn bằng dấu phẩy) ---

  /** pending | partially_paid | paid | refunded | partially_refunded */
  @IsOptional()
  @IsString()
  financial_status?: string;

  /** unfulfilled (chưa xử lý, = NULL) | partial | fulfilled */
  @IsOptional()
  @IsString()
  fulfillment_status?: string;

  /** no_return | in_progress | returned */
  @IsOptional()
  @IsString()
  return_status?: string;

  /** no_refund | partial | refunded */
  @IsOptional()
  @IsString()
  refund_status?: string;

  /** no_restock | partial | restocked */
  @IsOptional()
  @IsString()
  restock_status?: string;

  /** Trạng thái đóng gói — xét trên phiếu xử lý của đơn */
  @IsOptional()
  @IsString()
  packing_status?: string;

  /** Trạng thái giao hàng — xét trên vận đơn của đơn */
  @IsOptional()
  @IsString()
  shipment_status?: string;

  // --- Thực thể (danh sách id) ---

  /** Nhiều chi nhánh; thay cho `location_id` đơn lẻ */
  @IsOptional()
  @IsString()
  location_ids?: string;

  @IsOptional()
  @IsString()
  customer_ids?: string;

  /** Nhiều nhân viên phụ trách; thay cho `assigned_to` đơn lẻ */
  @IsOptional()
  @IsString()
  assigned_to_ids?: string;

  /** Lọc đơn có chứa một trong các phiên bản sản phẩm này */
  @IsOptional()
  @IsString()
  variant_ids?: string;

  // --- Mốc thời gian (mỗi sự kiện một trục riêng) ---

  /** Ngày đặt hàng; `from`/`to` là tên cũ của cặp này */
  @IsOptional()
  @IsString()
  created_on_min?: string;

  @IsOptional()
  @IsString()
  created_on_max?: string;

  @IsOptional()
  @IsString()
  confirmed_on_min?: string;

  @IsOptional()
  @IsString()
  confirmed_on_max?: string;

  @IsOptional()
  @IsString()
  completed_on_min?: string;

  @IsOptional()
  @IsString()
  completed_on_max?: string;

  @IsOptional()
  @IsString()
  cancelled_on_min?: string;

  @IsOptional()
  @IsString()
  cancelled_on_max?: string;

  @IsOptional()
  @IsString()
  paid_on_min?: string;

  @IsOptional()
  @IsString()
  paid_on_max?: string;

  /** Số lượng sản phẩm trên đơn (cột `subtotal_line_items_quantity`) */
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  item_quantity_min?: number;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  item_quantity_max?: number;

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

  /** Tên theo Sapo Open API của `page_size` */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  limit?: number;
}

/**
 * Ba loại file của Sapo: `order` = tổng quan mỗi đơn 1 dòng, `detail` = mỗi
 * dòng hàng 1 dòng, `product` = gộp theo SKU trên toàn bộ đơn đã lọc.
 */
export const ORDER_EXPORT_MODES = ['order', 'product', 'detail'] as const;

export class ExportOrdersQueryDto extends ListOrdersQueryDto {
  @IsOptional()
  @IsIn(ORDER_EXPORT_MODES)
  mode?: (typeof ORDER_EXPORT_MODES)[number];

  /** Các key cột cách nhau bởi dấu phẩy; thứ tự trong chuỗi là thứ tự cột file */
  @IsOptional()
  @IsString()
  fields?: string;

  /** Giới hạn về đúng các đơn được chọn / đang hiển thị (id cách nhau bởi dấu phẩy) */
  @IsOptional()
  @IsString()
  ids?: string;
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
  expected_delivery_date?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  total_discounts?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  total_shipping_price?: number;

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

  /** Lý do hủy — chỉ dùng khi action = 'cancel' */
  @IsOptional()
  @IsString()
  reason?: string;
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
  location_id!: string;

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
  location_id!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items!: OrderItemDto[];
}
