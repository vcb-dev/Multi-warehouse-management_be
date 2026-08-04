import { IsDateString, IsOptional, IsString, MinLength } from 'class-validator';

export class CreateApiKeyDto {
  @IsString()
  @MinLength(3)
  name: string;

  /** Key xác thực THAY user này — quyền của key = quyền thật của user (roles/permissions),
   * y hệt JWT. Muốn key toàn quyền thì trỏ vào user có role admin; muốn hẹp quyền thì
   * trỏ vào một user dịch vụ được gán role hẹp qua màn quản lý vai trò hiện có. */
  @IsString()
  acting_user_id: string;

  @IsOptional()
  @IsDateString()
  expires_at?: string;
}
