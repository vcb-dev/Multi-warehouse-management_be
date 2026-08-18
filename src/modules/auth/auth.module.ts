import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SessionService } from './session.service';
import { RbacModule } from '../rbac/rbac.module';

/**
 * Không còn JwtModule/PassportModule: token phát cho client là chuỗi ngẫu nhiên đối
 * chiếu với bảng `user_sessions`, không phải JWT tự chứng minh. Vì vậy hệ thống cũng
 * không còn khoá ký nào (JWT_SECRET) để bảo vệ hay để bị dò ngược.
 */
@Module({
  imports: [PrismaModule, RbacModule],
  controllers: [AuthController],
  providers: [AuthService, SessionService],
  exports: [AuthService, SessionService],
})
export class AuthModule {}
