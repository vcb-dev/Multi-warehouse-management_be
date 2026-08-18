import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsEmail, IsString, MinLength } from 'class-validator';
import { Public } from '../../common/decorators/roles.decorator';
import {
  CurrentUser,
  AuthUser,
} from '../../common/decorators/current-user.decorator';
import { AuthService } from './auth.service';
import { SessionService, type SessionContext } from './session.service';
import { InvitationService } from '../rbac/invitation.service';
import { AcceptInviteDto } from '../rbac/rbac.dto';

class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(6)
  password!: string;
}

type RequestWithClient = {
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
};

/** Thông tin nhận diện thiết bị, chỉ để hiển thị trong màn quản lý phiên. */
function sessionContext(req: RequestWithClient): SessionContext {
  const ua = req.headers['user-agent'];
  return {
    userAgent: Array.isArray(ua) ? ua[0] : ua,
    ipAddress: req.ip,
  };
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private auth: AuthService,
    private sessions: SessionService,
    private invitations: InvitationService,
  ) {}

  @Public()
  @Post('login')
  login(@Body() dto: LoginDto, @Req() req: RequestWithClient) {
    return this.auth.login(dto.email, dto.password, sessionContext(req));
  }

  /**
   * Quyền hiện tại của người đang đăng nhập — FE gọi định kỳ để đồng bộ lại
   * session mà không cần đăng nhập lại (đổi role/khoá tài khoản có hiệu lực
   * trong phiên đang mở).
   */
  @ApiBearerAuth()
  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user.userId);
  }

  /**
   * Đăng xuất thiết bị hiện tại. Khác hẳn bản trước: token chết ngay tại đây chứ không
   * chỉ mất cookie ở máy người dùng — ai đã copy được token cũng không dùng tiếp được.
   */
  @ApiBearerAuth()
  @Post('logout')
  @HttpCode(200)
  async logout(@CurrentUser() user: AuthUser) {
    if (user.sessionId) {
      await this.sessions.revoke(user.sessionId, user.userId);
    }
    return { data: { logged_out: true } };
  }

  /**
   * Đăng xuất khỏi MỌI thiết bị — dùng khi nghi lộ token hoặc mất máy. Giữ lại phiên
   * đang thao tác để người dùng không tự đá mình ra giữa chừng; muốn thoát hẳn thì gọi
   * tiếp `/auth/logout`.
   */
  @ApiBearerAuth()
  @Post('logout-all')
  @HttpCode(200)
  async logoutAll(@CurrentUser() user: AuthUser) {
    const revoked = await this.sessions.revokeAll(user.userId, user.sessionId);
    return { data: { revoked } };
  }

  /** Thiết bị đang đăng nhập của chính mình. */
  @ApiBearerAuth()
  @Get('sessions')
  listSessions(@CurrentUser() user: AuthUser) {
    return this.sessions.list(user.userId, user.sessionId);
  }

  /**
   * Đăng xuất một thiết bị cụ thể. Chỉ đụng được phiên của CHÍNH MÌNH — `revoke` lọc
   * theo `userId` nên truyền id phiên của người khác chỉ nhận 404.
   */
  @ApiBearerAuth()
  @Delete('sessions/:id')
  @HttpCode(200)
  async revokeSession(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    const revoked = await this.sessions.revoke(BigInt(id), user.userId);
    return { data: { revoked } };
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
