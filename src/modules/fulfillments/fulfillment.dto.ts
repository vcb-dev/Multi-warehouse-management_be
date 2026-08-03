import {
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
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
    ShipmentStatus.delivering,
    ShipmentStatus.delivered,
    ShipmentStatus.retry_delivery,
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
  /** Token API của hãng (GHN: Token) */
  @IsString()
  @MinLength(1)
  token!: string;

  /** ShopId GHN (bắt buộc với provider code=ghn) */
  @IsString()
  @MinLength(1)
  shop_id!: string;
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
