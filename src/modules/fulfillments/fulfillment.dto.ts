import {
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  PackingStatus,
  ShipmentStatus,
  ShippingFeePayer,
  ShippingProviderType,
} from '@prisma/client';

export class CreatePackingDto {
  @IsString()
  order_id!: string;

  @IsOptional()
  @IsString()
  packer_id?: string;
}

export class UpdatePackingStatusDto {
  @IsIn([PackingStatus.packing, PackingStatus.packed])
  status!: PackingStatus;
}

export class PushShipmentDto {
  @IsString()
  order_id!: string;

  @IsEnum(ShippingProviderType)
  shipping_type!: ShippingProviderType;

  @IsString()
  provider_id!: string;

  @IsOptional()
  @IsString()
  service_code?: string;

  @IsOptional()
  @IsString()
  tracking_number?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  shipping_fee?: number;

  @IsOptional()
  @IsEnum(ShippingFeePayer)
  fee_payer?: ShippingFeePayer;

  @IsOptional()
  @IsNumber()
  @Min(0)
  cod_amount?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  weight_grams?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  length_cm?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  width_cm?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  height_cm?: number;

  @IsOptional()
  @IsString()
  delivery_requirement?: string;

  @IsOptional()
  @IsString()
  note?: string;

  @IsString()
  @MinLength(1)
  to_name!: string;

  @IsString()
  @MinLength(1)
  to_phone!: string;

  @IsString()
  @MinLength(1)
  to_address!: string;

  @IsOptional()
  @IsString()
  to_ward?: string;

  @IsOptional()
  @IsString()
  to_district?: string;

  @IsOptional()
  @IsString()
  to_province?: string;

  @IsOptional()
  @IsString()
  location_id?: string;

  @IsOptional()
  @IsString()
  origin_name?: string;

  @IsOptional()
  @IsString()
  origin_phone?: string;

  @IsOptional()
  @IsString()
  origin_address1?: string;
}

export class UpdateShipmentStatusDto {
  @IsIn([
    ShipmentStatus.picked_up,
    ShipmentStatus.delivering,
    ShipmentStatus.delivered,
    ShipmentStatus.retry_delivery,
    ShipmentStatus.returning,
    ShipmentStatus.returned,
  ])
  status!: ShipmentStatus;
}

export class CancelFulfillmentDto {
  @IsOptional()
  @IsString()
  reason?: string;
}

export class CarrierWebhookDto {
  /** GHN payload */
  @IsOptional()
  @IsString()
  OrderCode?: string;

  @IsOptional()
  @IsString()
  Status?: string;

  @IsOptional()
  @IsString()
  Type?: string;

  @IsOptional()
  ShopID?: number | string;

  /** Stub / hãng khác — snake_case */
  @IsOptional()
  @IsString()
  tracking_number?: string;

  @IsOptional()
  @IsString()
  status?: string;
}

/**
 * Payload webhook trạng thái đơn của GHN — GHN gửi PascalCase nên DTO giữ nguyên tên field
 * của họ (khác `CarrierWebhookDto` là định dạng snake_case tự định nghĩa cho hãng mô phỏng).
 * Mọi field đều optional: GHN gửi tập field khác nhau theo `Type`, và
 * `ValidationPipe({ whitelist: true })` sẽ lược bớt field lạ chứ không báo lỗi.
 */
export class GhnWebhookDto {
  @IsOptional()
  @IsString()
  OrderCode?: string;

  @IsOptional()
  @IsString()
  ClientOrderCode?: string;

  /** Create | Switch_status | Update_weight | Update_cod | Update_fee */
  @IsOptional()
  @IsString()
  Type?: string;

  @IsOptional()
  @IsString()
  Status?: string;

  @IsOptional()
  ShopID?: number | string;

  @IsOptional()
  @IsNumber()
  CODAmount?: number;

  @IsOptional()
  @IsNumber()
  TotalFee?: number;

  /** Khối lượng quy đổi GHN cân lại (gram) */
  @IsOptional()
  @IsNumber()
  ConvertedWeight?: number;

  @IsOptional()
  @IsNumber()
  Weight?: number;

  @IsOptional()
  @IsString()
  Reason?: string;

  @IsOptional()
  @IsString()
  ReasonCode?: string;

  @IsOptional()
  @IsString()
  Warehouse?: string;

  @IsOptional()
  @IsString()
  Time?: string;
}

/**
 * Payload webhook trạng thái đơn của ViettelPost — bọc trong `{ DATA, TOKEN }`, khác payload
 * phẳng của GHN. `ORDER_STATUS` là mã số (mục 8 tài liệu, 101–550), không phải chuỗi như GHN.
 */
/**
 * `DATA` cố tình để dạng object mở (không whitelist field con) thay vì class riêng như trước:
 * payload thật của VTP (theo tài liệu `partner2.viettelpost.vn/document/webhook`) có ~25 field
 * tuỳ trạng thái đơn (ORDER_STATUSDATE, MONEY_FEECOD, EMPLOYEE_NAME, POD, DETAIL[], v.v.), nhiều
 * hơn hẳn số field service này thực sự đọc — và tài liệu còn lẫn cả field lỗi chính tả
 * (`LOCALION_CURRENTLY` cạnh `LOCATION_CURRENTLY`). Dùng class liệt kê hết dễ vỡ mỗi khi VTP đổi
 * field; ValidationPipe toàn cục bật `whitelist + forbidNonWhitelisted` nên nếu vẫn dùng class
 * cũ, mọi request webhook thật sẽ bị 400 vì các field chưa khai (đã xác nhận bằng curl thật).
 */
export class VtpWebhookDto {
  @IsOptional()
  @IsObject()
  DATA?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  TOKEN?: string;
}

/** Callback ticket của GHN — snake_case (khác webhook đơn hàng, vốn PascalCase). */
export class GhnTicketCallbackDto {
  @IsOptional()
  id?: number | string;

  @IsOptional()
  @IsString()
  order_code?: string;

  @IsOptional()
  @IsString()
  type?: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  status_id?: number;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  client_id?: string | number;

  @IsOptional()
  @IsString()
  c_name?: string;

  @IsOptional()
  @IsString()
  c_email?: string;

  @IsOptional()
  c_phone?: string | number;

  @IsOptional()
  attachments?: unknown;

  @IsOptional()
  conversations?: {
    body?: string;
    from_email?: string;
    created_at?: string;
    attachments?: unknown;
  }[];

  @IsOptional()
  @IsString()
  created_at?: string;

  @IsOptional()
  @IsString()
  updated_at?: string;
}

/** 4 nhóm ticket GHN cho phép tạo — key ngắn, service map sang chuỗi tiếng Việt của GHN. */
export const CARRIER_TICKET_CATEGORIES = [
  'tu_van',
  'hoi_giao_lay_tra_hang',
  'thay_doi_thong_tin',
  'khieu_nai',
] as const;

export class CreateCarrierTicketDto {
  /** Vận đơn cần mở ticket (id nội bộ của fulfillment) */
  @IsString()
  fulfillment_id!: string;

  @IsIn(CARRIER_TICKET_CATEGORIES)
  category!: (typeof CARRIER_TICKET_CATEGORIES)[number];

  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  description!: string;

  @IsOptional()
  @IsString()
  contact_email?: string;
}

export class ReplyCarrierTicketDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  description!: string;
}

export class ListProvidersQueryDto {
  @IsOptional()
  @IsEnum(ShippingProviderType)
  type?: ShippingProviderType;
}

export class ProviderQuotesQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  weight_grams?: number;
}

export class CreateShippingPartnerDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  note?: string;
}

export class UpdateShippingProviderDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  is_active?: boolean;
}

export class ConnectProviderDto {
  /** Token API của hãng (GHN: Token API; ViettelPost: tham số bí mật lấy từ web VTP) */
  @IsString()
  @MinLength(1)
  token!: string;

  /** ShopId — chỉ GHN cần (validate riêng ở `verifyGhn`); ViettelPost không dùng field này. */
  @IsOptional()
  @IsString()
  shop_id?: string;
}

export class ListShipmentsQueryDto {
  @IsOptional() @IsString() q?: string;
  @IsOptional() @IsString() tab?: string;
  @IsOptional() @IsString() shipment_status?: string;
  @IsOptional() @IsString() location_id?: string;
  @IsOptional() @IsString() provider_id?: string;
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page_size?: number;
}

export class ShipmentOverviewQueryDto {
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
}
