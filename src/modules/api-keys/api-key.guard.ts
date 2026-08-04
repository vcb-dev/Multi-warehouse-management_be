import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { API_SCOPE_KEY } from '../../common/decorators/api-scope.decorator';
import { ApiKeyService } from './api-key.service';

/**
 * Xác thực server-to-server bằng header `x-api-key`, thay cho JWT — dùng cho route đối tác
 * bên thứ 3 gọi thẳng, không qua đăng nhập. Route dùng guard này phải tự đánh dấu `@Public()`
 * để bỏ qua `JwtAuthGuard` toàn cục, và KHÔNG gắn `@RequirePermission` (PermissionGuard cho
 * qua vô điều kiện khi route không khai permission — xem auth.guards.ts).
 *
 * Sau khi key hợp lệ, guard dựng một `AuthUser` "giả" gán vào `request.user` để tầng service
 * (vd `ReportService.productMonthlyOps`) dùng lại nguyên xi logic scope-theo-kho hiện có,
 * không cần nhánh code riêng cho API key.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private apiKeys: ApiKeyService,
    private prisma: PrismaService,
    private reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
      user?: AuthUser;
    }>();

    const header = req.headers['x-api-key'];
    const rawKey = Array.isArray(header) ? header[0] : header;
    if (!rawKey) throw new UnauthorizedException('Thiếu header x-api-key');

    const apiKey = await this.apiKeys.validate(rawKey);
    if (!apiKey) {
      throw new UnauthorizedException('API key không hợp lệ hoặc đã hết hạn');
    }

    const requiredScopes = this.reflector.getAllAndOverride<string[]>(
      API_SCOPE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (
      requiredScopes?.length &&
      !requiredScopes.some((s) => apiKey.scopes.includes(s))
    ) {
      throw new ForbiddenException('API key không có quyền gọi endpoint này');
    }

    const locationIds = apiKey.locationIds.length
      ? apiKey.locationIds
      : (await this.prisma.location.findMany({ select: { id: true } })).map(
          (l) => l.id,
        );

    req.user = {
      userId: 0n,
      email: `apikey:${apiKey.name}`,
      roles: [],
      locationIds,
    };
    return true;
  }
}
