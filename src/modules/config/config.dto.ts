import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

/**
 * Sửa thông tin người gửi của kho. Bỏ trống trường = giữ nguyên; gửi '' = xoá
 * (phiếu giao + hãng vận chuyển quay về dùng tên/SĐT của kho).
 * Không cho sửa name/phone/địa chỉ gốc: đó là dữ liệu chi nhánh đồng bộ từ Sapo.
 */
export class UpdateLocationSenderDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  sender_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  @Matches(/^[0-9+\s().-]*$/, {
    message: 'sender_phone chỉ gồm chữ số, dấu cách và + . - ( )',
  })
  sender_phone?: string;
}
