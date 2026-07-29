import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

/** Sapo `customer.addresses[]` */
export class CustomerAddressDto {
  @IsOptional() @IsString() id?: string;
  @IsOptional() @IsString() first_name?: string;
  @IsOptional() @IsString() last_name?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() company?: string;
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
  @IsOptional() @IsBoolean() default?: boolean;
}

export class CreateCustomerDto {
  @IsOptional() @IsString() first_name?: string;
  @IsOptional() @IsString() last_name?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() company?: string;
  /** Sapo `state` — enabled | disabled | invited */
  @IsOptional() @IsString() state?: string;
  /** Sapo `gender` — male | female | other */
  @IsOptional() @IsString() gender?: string;
  @IsOptional() @IsString() dob?: string;
  @IsOptional() @IsBoolean() accepts_marketing?: boolean;
  @IsOptional() @IsBoolean() verified_email?: boolean;
  @IsOptional() @IsString() note?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CustomerAddressDto)
  addresses?: CustomerAddressDto[];

  /** Id nhóm khách hàng — thay thế toàn bộ nhóm hiện tại */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  customer_group_ids?: string[];
}

export class UpdateCustomerDto extends CreateCustomerDto {}

export class ListCustomersQueryDto {
  @IsOptional() @IsString() q?: string;
  /** enabled | disabled | invited */
  @IsOptional() @IsString() state?: string;
  @IsOptional() @IsString() gender?: string;
  @IsOptional() @IsString() customer_group_id?: string;
  /** `has_order` | `no_order` */
  @IsOptional() @IsString() order_filter?: string;
  /** total_spent | orders_count | created_on */
  @IsOptional() @IsString() sort?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) limit?: number;
}

export class CreateCustomerGroupDto {
  @IsString() name!: string;
  @IsOptional() @IsString() code?: string;
  @IsOptional() @IsString() note?: string;
  /** Sapo `type` — auto (theo rules) | manual (chọn tay) */
  @IsOptional() @IsString() type?: string;
  @IsOptional() @IsBoolean() disjunctive?: boolean;
  @IsOptional() rules?: unknown;
}

export class UpdateCustomerGroupDto extends CreateCustomerGroupDto {
  @IsOptional() @IsString() declare name: string;
}

export class SetGroupMembersDto {
  @IsArray()
  @IsString({ each: true })
  customer_ids!: string[];
}
