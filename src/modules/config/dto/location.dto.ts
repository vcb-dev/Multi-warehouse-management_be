import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

function toBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === true || value === 'true' || value === '1') return true;
  if (value === false || value === 'false' || value === '0') return false;
  return undefined;
}
// Create: bỏ field trống. Update: trống → null để xóa giá trị cũ.
function emptyToUndef(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  return t === '' ? undefined : t;
}

function emptyToNull(value: unknown): unknown {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string') return value;
  const t = value.trim();
  return t === '' ? null : t;
}

/** VN: 0xxxxxxxxx hoặc +84xxxxxxxxx, cho phép khoảng trắng */
const VN_PHONE = /^(\+?84|0)\d{8,10}$/;

export class ListLocationsQueryDto {
  @IsOptional()
  @Transform(({ value }) => toBoolean(value))
  @IsBoolean()
  include_inactive?: boolean;
}

export class CreateLocationDto {
  @IsString()
  @IsNotEmpty({ message: 'Tên kho không được để trống' })
  @MaxLength(255)
  name!: string;

  @IsOptional()
  @Transform(({ value }) => emptyToUndef(value))
  @IsString()
  @MaxLength(64)
  code?: string;

  @IsOptional()
  @Transform(({ value }) => emptyToUndef(value))
  @IsString()
  @Matches(VN_PHONE, { message: 'Số điện thoại không hợp lệ' })
  phone?: string;

  @IsOptional()
  @Transform(({ value }) => emptyToUndef(value))
  @IsEmail({}, { message: 'Email không hợp lệ' })
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  address1?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  province?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  district?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  ward?: string;

  @IsOptional()
  @IsBoolean()
  default_location?: boolean;

  @IsOptional()
  @IsBoolean()
  inventory_management?: boolean;
}

export class UpdateLocationDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'Tên kho không được để trống' })
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @Transform(({ value }) => emptyToNull(value))
  @IsString()
  @MaxLength(64)
  code?: string | null;

  @IsOptional()
  @Transform(({ value }) => emptyToNull(value))
  @IsString()
  @Matches(VN_PHONE, { message: 'Số điện thoại không hợp lệ' })
  phone?: string | null;

  @IsOptional()
  @Transform(({ value }) => emptyToNull(value))
  @IsEmail({}, { message: 'Email không hợp lệ' })
  email?: string | null;

  @IsOptional()
  @Transform(({ value }) => emptyToNull(value))
  @IsString()
  @MaxLength(255)
  address1?: string | null;

  @IsOptional()
  @Transform(({ value }) => emptyToNull(value))
  @IsString()
  @MaxLength(128)
  province?: string | null;

  @IsOptional()
  @Transform(({ value }) => emptyToNull(value))
  @IsString()
  @MaxLength(128)
  district?: string | null;

  @IsOptional()
  @Transform(({ value }) => emptyToNull(value))
  @IsString()
  @MaxLength(128)
  ward?: string | null;

  @IsOptional()
  @IsBoolean()
  default_location?: boolean;

  @IsOptional()
  @IsBoolean()
  inventory_management?: boolean;

  @IsOptional()
  @IsIn(['active', 'inactive'])
  status?: 'active' | 'inactive';
}
