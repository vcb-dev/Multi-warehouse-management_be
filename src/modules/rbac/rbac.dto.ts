import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateRoleDto {
  @IsString()
  @MaxLength(120)
  name!: string;

  @IsString()
  @MaxLength(60)
  code!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayUnique()
  permission_keys?: string[];
}

export class UpdateRoleDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayUnique()
  permission_keys?: string[];
}

export class InviteUserDto {
  @IsOptional()
  @IsString()
  @MaxLength(60)
  first_name?: string;

  @IsString()
  @MaxLength(60)
  last_name!: string;

  @IsEmail()
  email!: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;
}

export class UpdateUserStatusDto {
  @IsBoolean()
  is_active!: boolean;
}

class WarehouseRoleAssignmentDto {
  @IsString()
  location_id!: string;

  @IsString()
  role_id!: string;
}

export class PutWarehouseRolesDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WarehouseRoleAssignmentDto)
  assignments!: WarehouseRoleAssignmentDto[];
}

export class UpdateUserPermissionsDto {
  @IsArray()
  @IsString({ each: true })
  @ArrayUnique()
  permission_keys!: string[];
}

export class AcceptInviteDto {
  @IsString()
  @MinLength(6)
  password!: string;
}

export class ListUsersQueryDto {
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}
