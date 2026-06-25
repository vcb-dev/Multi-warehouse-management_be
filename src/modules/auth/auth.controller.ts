import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsEmail, IsString, MinLength } from 'class-validator';
import { Public } from '../../common/decorators/roles.decorator';
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
