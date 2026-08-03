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

/** Sapo `customer_group.rules[]` — một điều kiện của nhóm tự động */
export class CustomerGroupRuleDto {
  /** Xem danh mục ở GET /customer-groups/rule-options */
  @IsString() column!: string;
  /** equals | not_equals | greater_than | less_than | contains | ... */
  @IsString() relation!: string;
  /** Bỏ trống với relation không cần giá trị (is_set / is_not_set) */
  @IsOptional() @IsString() condition?: string;
}

export class CreateCustomerGroupDto {
  @IsString() name!: string;
  @IsOptional() @IsString() code?: string;
  @IsOptional() @IsString() note?: string;
  /** Sapo `type` — auto (theo rules) | manual (chọn tay) */
  @IsOptional() @IsString() type?: string;
  /** Sapo `disjunctive`: true = thoả 1 điều kiện bất kỳ (OR), false = thoả mọi điều kiện (AND) */
  @IsOptional() @IsBoolean() disjunctive?: boolean;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CustomerGroupRuleDto)
  rules?: CustomerGroupRuleDto[];
}

/**
 * Sửa nhóm là cập nhật từng phần: mọi trường bỏ trống đều giữ nguyên giá trị cũ.
 * Không kế thừa `CreateCustomerGroupDto` vì `name` ở đó bắt buộc, mà TypeScript
 * không cho lớp con nới một thuộc tính bắt buộc thành tuỳ chọn.
 */
export class UpdateCustomerGroupDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() note?: string;
  /** Sapo `type` — auto (theo rules) | manual (chọn tay) */
  @IsOptional() @IsString() type?: string;
  @IsOptional() @IsBoolean() disjunctive?: boolean;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CustomerGroupRuleDto)
  rules?: CustomerGroupRuleDto[];
}

/** Đếm thử số khách khớp điều kiện trước khi lưu nhóm */
export class PreviewCustomerGroupDto {
  @IsOptional() @IsBoolean() disjunctive?: boolean;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CustomerGroupRuleDto)
  rules!: CustomerGroupRuleDto[];
}

export class SetGroupMembersDto {
  @IsArray()
  @IsString({ each: true })
  customer_ids!: string[];
}
