import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsEmail, IsString, MinLength } from 'class-validator';
import { Public } from '../../common/decorators/roles.decorator';
import {
  CurrentUser,
  AuthUser,
} from '../../common/decorators/current-user.decorator';
import { AuthService } from './auth.service';
import { InvitationService } from '../rbac/invitation.service';
import { AcceptInviteDto } from '../rbac/rbac.dto';

class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(6)
  password!: string;
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private auth: AuthService,
    private invitations: InvitationService,
  ) {}

  @Public()
  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto.email, dto.password);
  }

  /**
   * Quyền hiện tại của người đang đăng nhập — FE gọi định kỳ để đồng bộ lại
   * session mà không cần đăng nhập lại (đổi role/khoá tài khoản có hiệu lực
   * trong phiên đang mở, không phải chờ hết hạn JWT).
   */
  @ApiBearerAuth()
  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user.userId);
  }

  /**
   * Đăng xuất khỏi MỌI thiết bị. Nút đăng xuất thường chỉ xoá cookie tại máy đang
   * dùng — token vẫn hiệu lực tới khi hết hạn (7 ngày); đây là đường duy nhất thu
   * hồi thật, dùng khi nghi lộ token hoặc mất máy.
   */
  @ApiBearerAuth()
  @Post('logout-all')
  @HttpCode(200)
  logoutAll(@CurrentUser() user: AuthUser) {
    return this.auth.revokeAllSessions(user.userId);
  }

  @Public()
  @Get('invitations/:token')
  checkInvite(@Param('token') token: string) {
    return this.invitations.checkToken(token);
  }

  @Public()
  @Post('invitations/:token/accept')
  acceptInvite(@Param('token') token: string, @Body() dto: AcceptInviteDto) {
    return this.invitations.accept(token, dto.password);
  }
}
