import { InventoryBucket } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

function toBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === true || value === 'true' || value === '1') return true;
  if (value === false || value === 'false' || value === '0') return false;
  return undefined;
}

export class ListInventoryQueryDto {
  @IsOptional()
  @IsString()
  location_id?: string;

  @IsOptional()
  @IsString()
  variant_id?: string;

  /** Danh sách variant_id, phân tách dấu phẩy — dùng để giới hạn kết quả về đúng tập sản phẩm cho trước (VD: sản phẩm có trong PO của NCC) */
  @IsOptional()
  @IsString()
  variant_ids?: string;

  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @Transform(({ value }) => toBoolean(value))
  @IsBoolean()
  low_stock?: boolean;

  /**
   * `negative` (available < 0) tách riêng khỏi `out_of_stock` (available <= 0): hai cái
   * này lệch nhau rất xa trên dữ liệu thật — 756 dòng âm thật so với 14.395 dòng <= 0.
   * Thông báo cảnh báo âm kho link tới đây nên phải khớp chính xác, không được gộp.
   */
  @IsOptional()
  @IsIn(['in_stock', 'out_of_stock', 'negative'])
  stock_status?: 'in_stock' | 'out_of_stock' | 'negative';

  /** Đầu kỳ NXT (ISO date) — mặc định đầu tháng hiện tại; kỳ kết thúc ở hiện tại */
  @IsOptional()
  @IsString()
  date_from?: string;

  // --- Khoảng số theo chỉ số kho ---
  // Đây là các cột thật trên `inventory_levels`, không phải trạng thái rời rạc.
  // Bao gồm cả hai đầu mút, nên `available_min=0&available_max=0` tìm đúng
  // những dòng hết sạch hàng.

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  on_hand_min?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  on_hand_max?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  available_min?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  available_max?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  committed_min?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  committed_max?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  incoming_min?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  incoming_max?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  packed_min?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  packed_max?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  reserved_min?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  reserved_max?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  unavailable_min?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  unavailable_max?: number;

  // --- Thuộc tính sản phẩm ---

  /** Loại sản phẩm, ngăn bằng dấu phẩy */
  @IsOptional()
  @IsString()
  product_types?: string;

  /** Nhãn hiệu, ngăn bằng dấu phẩy */
  @IsOptional()
  @IsString()
  vendors?: string;

  /** Tag của sản phẩm — khớp MỘT tag bất kỳ là đủ */
  @IsOptional()
  @IsString()
  tags?: string;

  /**
   * Ngày tạo sản phẩm. KHÔNG liên quan tới `date_from` ở trên — `date_from` là
   * mốc tính nhập-xuất-tồn, còn cặp này mới là bộ lọc ngày tạo của Sapo.
   */
  @IsOptional()
  @IsString()
  created_on_min?: string;

  @IsOptional()
  @IsString()
  created_on_max?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page_size?: number = 20;

  /** Tên theo Sapo Open API của `page_size` */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}

export class ExportInventoryQueryDto extends ListInventoryQueryDto {
  /**
   * Các key cột cách nhau bởi dấu phẩy; thứ tự trong chuỗi là thứ tự cột file.
   * Phạm vi "dòng được chọn" dùng lại `variant_ids` chứ không có tham số riêng.
   */
  @IsOptional()
  @IsString()
  fields?: string;
}

export class ListMovementsQueryDto {
  @IsOptional()
  @IsString()
  location_id?: string;

  @IsOptional()
  @IsEnum(InventoryBucket)
  bucket?: InventoryBucket;

  @IsOptional()
  @IsString()
  from?: string;

  @IsOptional()
  @IsString()
  to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page_size?: number = 20;
}
