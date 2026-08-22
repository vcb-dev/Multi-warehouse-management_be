import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { TokenService } from './token.service';
import { JWT_ISSUER, jwtSecret } from './jwt.config';
import { RbacModule } from '../rbac/rbac.module';

/**
 * `registerAsync` chứ không phải `register`: factory chạy lúc Nest dựng module, tức là
 * SAU khi `ConfigModule.forRoot()` nạp `.env`. Gọi `jwtSecret()` ngay trong `register()`
 * thì nó chạy lúc file này được import — trước cả khi env kịp có mặt.
 */
@Module({
  imports: [
    PrismaModule,
    RbacModule,
    JwtModule.registerAsync({
      useFactory: () => ({
        secret: jwtSecret(),
        signOptions: { issuer: JWT_ISSUER },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, TokenService],
  exports: [AuthService, TokenService],
})
export class AuthModule {}
