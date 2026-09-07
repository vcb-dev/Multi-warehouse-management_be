import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

function toBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === true || value === 'true' || value === '1') return true;
  if (value === false || value === 'false' || value === '0') return false;
  return undefined;
}

export class ProductOptionDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsArray()
  @IsString({ each: true })
  values!: string[];
}

export class ProductVariantDto {
  @IsArray()
  @IsString({ each: true })
  option_values!: string[];

  @IsString()
  @MinLength(1)
  sku!: string;

  @IsNumber()
  @Min(0)
  price!: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  cost?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  compare_at_price?: number;

  @IsOptional()
  @IsString()
  barcode?: string;

  @IsOptional()
  @IsString()
  image_url?: string;

  @IsOptional()
  @IsNumber()
  weight?: number;

  @IsOptional()
  @IsString()
  weight_unit?: string;

  /** Ghi đè riêng cho variant — nếu bỏ trống sẽ dùng giá trị chung của sản phẩm (dto cấp trên) */
  @IsOptional()
  @IsString()
  unit?: string;

  @IsOptional()
  @IsBoolean()
  taxable?: boolean;

  @IsOptional()
  @IsBoolean()
  requires_shipping?: boolean;

  @IsOptional()
  @IsBoolean()
  track_inventory?: boolean;

  @IsOptional()
  @IsBoolean()
  allow_backorder?: boolean;
}

export class CreateProductDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsString()
  alias?: string;

  /** Áp cho mọi variant trừ khi variant tự ghi đè `unit` riêng */
  @IsOptional()
  @IsString()
  unit?: string;

  @IsOptional()
  @IsString()
  vendor?: string;

  @IsOptional()
  @IsString()
  product_type?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  image_urls?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  sales_channels?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  category_ids?: string[];

  @IsOptional()
  @IsBoolean()
  is_published?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @ValidateNested({ each: true })
  @Type(() => ProductOptionDto)
  options?: ProductOptionDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProductVariantDto)
  variants?: ProductVariantDto[];

  @IsOptional()
  @IsString()
  content?: string;

  @IsOptional()
  @IsString()
  summary?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsString()
  meta_title?: string;

  @IsOptional()
  @IsString()
  meta_description?: string;

  /** Áp cho mọi variant trừ khi variant tự ghi đè riêng */
  @IsOptional()
  @IsBoolean()
  taxable?: boolean;

  @IsOptional()
  @IsString()
  vat_pit_category_code?: string;

  @IsOptional()
  @IsBoolean()
  track_inventory?: boolean;

  @IsOptional()
  @IsBoolean()
  allow_backorder?: boolean;

  @IsOptional()
  @IsBoolean()
  requires_shipping?: boolean;
}

export class UpdateProductDto extends CreateProductDto {}

export class ListProductsQueryDto {
  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @IsString()
  category_id?: string;

  @IsOptional()
  @IsString()
  brand?: string;

  @IsOptional()
  @IsString()
  product_type?: string;

  @IsOptional()
  @Transform(({ obj }: { obj: Record<string, unknown> }) =>
    toBoolean(obj.is_published),
  )
  @IsBoolean()
  is_published?: boolean;

  @IsOptional()
  @IsString()
  channel?: string;

  // --- Chọn nhiều (ngăn bằng dấu phẩy) ---

  /** Nhãn hiệu; `brand` là tên cũ, chỉ nhận một giá trị */
  @IsOptional()
  @IsString()
  vendors?: string;

  /** Loại sản phẩm; `product_type` là tên cũ */
  @IsOptional()
  @IsString()
  product_types?: string;

  /** Danh mục; `category_id` là tên cũ */
  @IsOptional()
  @IsString()
  category_ids?: string;

  /** Kênh bán hàng; `channel` là tên cũ */
  @IsOptional()
  @IsString()
  channels?: string;

  /** Tag — khớp MỘT tag bất kỳ là đủ */
  @IsOptional()
  @IsString()
  tags?: string;

  /** Nhóm ngành nghề tính thuế GTGT, TNCN */
  @IsOptional()
  @IsString()
  vat_pit_category_codes?: string;

  // --- Khoảng ngày ---

  @IsOptional()
  @IsString()
  created_on_min?: string;

  @IsOptional()
  @IsString()
  created_on_max?: string;

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

export class ExportProductsQueryDto extends ListProductsQueryDto {
  /** Các key cột cách nhau bởi dấu phẩy; thứ tự trong chuỗi là thứ tự cột file */
  @IsOptional()
  @IsString()
  fields?: string;

  /** Giới hạn về đúng các sản phẩm được chọn / đang hiển thị */
  @IsOptional()
  @IsString()
  ids?: string;
}

export class ProductInventoryQueryDto {
  @IsOptional()
  @IsString()
  location_id?: string;
}

export class VariantPriceHistoryQueryDto {
  @IsOptional()
  @IsIn(['price', 'cost'])
  field?: 'price' | 'cost';

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  page?: number = 1;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  page_size?: number = 20;
}

/** Query chung cho các endpoint trả danh sách giá trị sẵn có (tag, loại SP) */
export class ProductFacetQueryDto {
  /** Lọc theo chuỗi con, bỏ dấu tiếng Việt — để ô chọn gõ tìm được */
  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(2000)
  @Type(() => Number)
  limit?: number;
}
