import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { IsEmail, IsString, MinLength } from 'class-validator';
import { Public } from '../../common/decorators/roles.decorator';
import {
  CurrentUser,
  AuthUser,
} from '../../common/decorators/current-user.decorator';
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  clearAuthCookies,
  setAuthCookies,
} from '../../common/auth/cookies';
import { AuthService, type AuthResult } from './auth.service';
import type { SessionContext } from './token.service';
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
  cookies?: Record<string, string | undefined>;
  ip?: string;
};

/** Thông tin nhận diện thiết bị, chỉ để tra lại khi điều tra sự cố. */
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
    private invitations: InvitationService,
  ) {}

  /**
   * Đăng nhập. Token KHÔNG nằm trong body trả về — cả hai đều là cookie `httpOnly` do
   * chính backend đặt, nên JavaScript của trang không đọc được. Body chỉ có phần hồ sơ
   * và quyền để FE dựng UI.
   */
  @Public()
  @Post('login')
  async login(
    @Body() dto: LoginDto,
    @Req() req: RequestWithClient,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.login(
      dto.email,
      dto.password,
      sessionContext(req),
    );
    return this.respondWithCookies(res, result);
  }

  /**
   * Gia hạn. `@Public()` vì đúng lúc cần gọi thì access token đã hết hạn — bắt guard duyệt
   * ở đây là khoá luôn con đường duy nhất để thoát khỏi trạng thái đó. Xác thực nằm ở
   * chính refresh cookie: sai chữ ký, đã tiêu, hay đã thu hồi đều ra 401.
   */
  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Req() req: RequestWithClient,
    @Res({ passthrough: true }) res: Response,
  ) {
    try {
      const result = await this.auth.refresh(
        req.cookies?.[REFRESH_COOKIE],
        sessionContext(req),
      );
      return this.respondWithCookies(res, result);
    } catch (err) {
      // Gia hạn hỏng = phiên chấm dứt. Để cookie chết nằm lại thì mọi request sau đó vẫn
      // mang nó đi và vẫn 401, người dùng kẹt ở màn hình trắng cho tới khi tự xoá cookie.
      clearAuthCookies(res);
      throw err;
    }
  }

  /**
   * Quyền hiện tại của người đang đăng nhập — FE gọi lúc mở app (khôi phục phiên từ
   * cookie) và định kỳ sau đó, để đổi role/khoá tài khoản có hiệu lực ngay trong phiên
   * đang mở mà không cần đăng nhập lại.
   */
  @ApiBearerAuth()
  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user.userId);
  }

  /**
   * Đăng xuất. `@Public()` để vẫn xoá được cookie khi access token đã hết hạn — bấm đăng
   * xuất mà nhận 401 rồi cookie vẫn nằm đó là kịch bản tệ nhất.
   *
   * Thu hồi cả họ refresh token chứ không chỉ xoá cookie: xoá cookie chỉ làm trình duyệt
   * NÀY quên token, bản token vẫn sống tới lúc hết hạn.
   *
   * Đưa CẢ HAI cookie xuống service. Refresh đứng trước vì nó là đường chính, nhưng nó
   * chỉ được gửi cho `/api/auth` nên có lúc vắng mặt trong khi access cookie vẫn còn —
   * và cả hai đều chở cùng `familyId`, nên cái nào còn đọc được cũng thu hồi được cả họ.
   */
  @Public()
  @Post('logout')
  @HttpCode(200)
  async logout(
    @Req() req: RequestWithClient,
    @Res({ passthrough: true }) res: Response,
  ) {
    const loggedOut = await this.auth.logout(
      req.cookies?.[REFRESH_COOKIE],
      req.cookies?.[ACCESS_COOKIE],
    );
    clearAuthCookies(res);
    return { data: { logged_out: loggedOut } };
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

  private respondWithCookies(res: Response, result: AuthResult) {
    setAuthCookies(res, result.tokens);
    return result.body;
  }
}
