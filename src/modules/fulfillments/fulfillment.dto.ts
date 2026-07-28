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
  @IsIn([PackingStatus.cho_dan_phieu, PackingStatus.da_dong_goi])
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
  tracking_code?: string;

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
  from_name?: string;

  @IsOptional()
  @IsString()
  from_phone?: string;

  @IsOptional()
  @IsString()
  from_address?: string;
}

export class UpdateShipmentStatusDto {
  @IsIn([
    ShipmentStatus.dang_giao,
    ShipmentStatus.da_giao,
    ShipmentStatus.giao_loi,
    ShipmentStatus.da_hoan,
  ])
  status!: ShipmentStatus;
}

export class CancelFulfillmentDto {
  @IsOptional()
  @IsString()
  reason?: string;
}

export class CarrierWebhookDto {
  @IsString()
  tracking_code!: string;

  @IsString()
  status!: string;
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
  /** Token/API key mô phỏng — lưu vào connection_config chờ adapter thật */
  @IsOptional()
  @IsString()
  token?: string;

  @IsOptional()
  @IsString()
  shop_id?: string;
}
