import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import * as compression from 'compression';
import * as cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { assertAuthCookieConfig } from './common/auth/cookies';
import { allowedOrigins } from './common/http/cors-origins';

function trustProxyHops(): number {
  const raw = process.env.TRUST_PROXY_HOPS?.trim();
  if (!raw) return 1;
  const hops = Number(raw);
  if (!Number.isInteger(hops) || hops < 0) {
    throw new Error(
      `TRUST_PROXY_HOPS không hợp lệ: "${raw}" — phải là số nguyên >= 0. ` +
        'Railway đứng sau proxy /api của Vercel: 2. Gọi thẳng Railway: 1.',
    );
  }
  return hops;
}

async function bootstrap() {
  // `rawBody` cần cho webhook TikTok Shop: chữ ký ký trên đúng chuỗi JSON gốc, nên
  // `JSON.stringify(req.body)` không dùng thay được (khác thứ tự key/khoảng trắng).
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });

  // Sau load balancer, `req.ip` mặc định là IP nội bộ của LB — mọi request trông như đến
  // từ cùng một nguồn, làm hỏng cả giới hạn tần suất theo IP lẫn IP ghi trong audit log.
  // Con số này là SỐ LỚP PROXY TIN ĐƯỢC, đếm ngược từ phía app: mỗi lớp bóc thêm một
  // nhánh của `X-Forwarded-For`, phần còn lại là do client tự khai nên không tin được.
  //
  // Đếm sai theo hướng nào cũng hỏng, và hỏng lặng lẽ:
  //   - thiếu 1 → `req.ip` là IP egress của Vercel, DÙNG CHUNG cho mọi người dùng; bộ
  //     đếm `/auth/refresh` (60 lượt/phút theo IP) thành một rổ chung, đủ đông là cả
  //     công ty cùng bị 429.
  //   - thừa 1 → tin luôn nhánh client tự khai, tức ai cũng đổi IP của mình bằng một
  //     header và đi vòng qua mọi giới hạn tần suất.
  //
  // 1 = chỉ Railway (khách gọi thẳng API bằng API key). 2 = trình duyệt đi qua proxy
  // `/api` của FE trên Vercel rồi mới tới Railway — đó là hình dạng của production.
  app.set('trust proxy', trustProxyHops());

  app.use(compression());
  // Access/refresh token đi bằng cookie `httpOnly` do chính API này đặt, nên guard cần
  // `req.cookies`. Không ký cookie ở tầng này: nội dung đã là JWT có chữ ký riêng, ký
  // thêm một lớp nữa chỉ tốn cấu hình mà không thêm bảo đảm nào.
  app.use(cookieParser());

  const uploadDir = process.env.UPLOAD_DIR ?? join(process.cwd(), 'uploads');
  app.useStaticAssets(uploadDir, { prefix: '/uploads' });

  app.setGlobalPrefix('api');
  // Thuộc tính cookie phiên chỉ được đọc lúc CÓ NGƯỜI ĐĂNG NHẬP, nên một cấu hình mâu
  // thuẫn sẽ nằm im tới tận lúc đó rồi mới hiện ra dưới dạng lỗi 500 giữa luồng login.
  // Ép nó lộ ra ngay tại đây, lúc chưa ai dùng.
  assertAuthCookieConfig();
  // Trình duyệt đi qua proxy `/api` của FE nên phần CORS ở đây không còn là thứ chặn nó
  // — same-origin thì không có preflight. Nhưng `CORS_ORIGIN` thì vẫn phải đúng, vì
  // `CsrfGuard` đối chiếu header `Origin` (proxy chuyển tiếp nguyên vẹn) với chính danh
  // sách này: thiếu domain Vercel trong đó là mọi lệnh ghi trả 403 CSRF_ORIGIN_REJECTED.
  //
  // `credentials: true` + origin tường minh giữ lại cho hai đường còn gọi thẳng: Swagger
  // `/api/docs` và đối tác dùng API key. Với `Access-Control-Allow-Origin: *` thì trình
  // duyệt bỏ cookie lại, và triệu chứng là 401 ở mọi nơi chứ không phải lỗi CORS dễ thấy.
  app.enableCors({
    origin: allowedOrigins(),
    credentials: true,
    // FE gắn `X-Warehouse-Id` và `X-Requested-With` vào mọi lời gọi, nên trình duyệt
    // preflight trước mỗi request. Nhớ kết quả 1 tiếng để không phải hỏi lại liên tục.
    maxAge: 3600,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Viễn Chí Bảo API')
    .setDescription('REST API — Module Quản lý kho & hệ thống')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document);

  const port = process.env.PORT ?? 3001;
  await app.listen(port);
}
bootstrap();
