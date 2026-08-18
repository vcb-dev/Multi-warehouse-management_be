import { NotificationTopic } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';

/** Copy của helper trong inventory.dto.ts — query string chỉ có chuỗi, không có boolean. */
function toBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === true || value === 'true' || value === '1') return true;
  if (value === false || value === 'false' || value === '0') return false;
  return undefined;
}

export class ListNotificationsQueryDto {
  /** Chỉ lấy chưa đọc — dùng cho tab "Chưa đọc" ở trang /thong-bao. */
  @IsOptional()
  @Transform(({ value }) => toBoolean(value))
  @IsBoolean()
  unread_only?: boolean;

  /**
   * Nhận chuỗi Sapo (`orders/create`) từ client, đổi sang tên thành viên enum Prisma
   * (`orders_create`) — Prisma enum không cho `/` trong tên nên hai bên lệch nhau.
   * Giá trị lạ giữ nguyên để `@IsEnum` bắt và trả 400 thay vì lọt xuống query.
   */
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.replace('/', '_') : value,
  )
  @IsEnum(NotificationTopic)
  topic?: NotificationTopic;

  /**
   * Phân trang keyset: lấy các thông báo có id NHỎ HƠN giá trị này (cũ hơn).
   *
   * `@Matches` là bắt buộc chứ không phải cho đẹp: service làm `BigInt(before_id)`, mà
   * `BigInt("abc")` ném SyntaxError không ai bắt ⇒ 500 thay vì 400. Chặn ngay ở pipe.
   */
  // `\d*` chứ không phải `\d+`: chấp nhận chuỗi rỗng (caller ghép `before_id=${x ?? ''}`
  // thì phải hiểu là "không lọc", không phải lỗi 400). Service bỏ qua giá trị rỗng.
  @IsOptional()
  @Matches(/^\d*$/, { message: 'before_id phải là số nguyên dương' })
  before_id?: string;

  // @Type thay vì @Transform: khớp cách mọi query DTO khác trong dự án đang làm
  // (order.dto.ts, inventory.dto.ts) và hoạt động đúng với transform:true ở main.ts.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class MarkReadDto {
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  ids: string[];
}

export class UpdateNotificationSettingDto {
  @IsOptional()
  @IsBoolean()
  app_enabled?: boolean;

  /** Ghi được nhưng CHƯA có tác dụng — chưa có luồng gửi email nào đọc field này. */
  @IsOptional()
  @IsBoolean()
  email_enabled?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  recipient_permissions?: string[];
}
