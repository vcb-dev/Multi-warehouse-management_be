import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MinLength,
  ValidateNested,
} from 'class-validator';

const SALES_CHANNELS = ['shopee', 'tiktok', 'facebook', 'pos', 'website'] as const;

export type AutoConditions = {
  vendor?: string;
  product_type?: string;
  tags?: string[];
};

export class AutoConditionsDto implements AutoConditions {
  @IsOptional()
  @IsString()
  vendor?: string;

  @IsOptional()
  @IsString()
  product_type?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];
}

export class CreateCategoryDto {
  @IsString()
  @IsNotEmpty({ message: 'Tên danh mục không được để trống' })
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d+$/, { message: 'parent_id phải là số' })
  parent_id?: string;

  @IsOptional()
  @IsString()
  image_url?: string;

  @IsIn(['manual', 'auto'], { message: 'condition_type phải là manual hoặc auto' })
  condition_type!: 'manual' | 'auto';

  @IsOptional()
  @ValidateNested()
  @Type(() => AutoConditionsDto)
  auto_conditions?: AutoConditionsDto;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @IsIn(SALES_CHANNELS, { each: true })
  sales_channels?: string[];
}
