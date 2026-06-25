import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../decorators/current-user.decorator';

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private prisma: PrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<{
      method: string;
      route?: { path?: string };
      user?: AuthUser;
      body?: Record<string, unknown>;
    }>();
    const method = req.method;
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
      return next.handle();
    }

    const user = req.user;
    const path = req.route?.path ?? 'unknown';

    return next.handle().pipe(
      tap(() => {
        void this.prisma.activityLog
          .create({
            data: {
              userId: user?.userId,
              action: `${method} ${path}`,
              entityType: 'http_request',
              metadata: { path, method },
            },
          })
          .catch(() => undefined);
      }),
    );
  }
}
