import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class StocktakeItemDto {
  @IsString()
  @IsNotEmpty()
  variant_id!: string;

  /**
   * Số đếm thực tế. Bỏ trống = CHƯA đếm (khác hẳn đếm ra 0): dòng chưa đếm bị bỏ qua khi
   * cân bằng, còn đếm ra 0 nghĩa là hết sạch hàng và sẽ kéo tồn về 0.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  counted_quantity?: number;

  @IsOptional()
  @IsString()
  note?: string;
}

export class CreateStocktakeDto {
  @IsString()
  @IsNotEmpty()
  location_id!: string;

  @IsOptional()
  @IsString()
  note?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => StocktakeItemDto)
  items!: StocktakeItemDto[];
}

/** Sửa phiếu — chỉ áp dụng khi phiếu còn ở trạng thái `dang_kiem`. */
export class UpdateStocktakeDto {
  @IsOptional()
  @IsString()
  note?: string;

  /**
   * Danh sách dòng ĐẦY ĐỦ của phiếu (không phải patch từng dòng): dòng vắng mặt sẽ bị xoá
   * khỏi phiếu. Gửi patch từng phần thì không xoá được dòng thừa mà không thêm route riêng.
   */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => StocktakeItemDto)
  items?: StocktakeItemDto[];
}

export class ListStocktakesQueryDto {
  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  location_id?: string;

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
