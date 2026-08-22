import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import * as compression from 'compression';
import * as cookieParser from 'cookie-parser';
import { AppModule } from './app.module';

async function bootstrap() {
  // `rawBody` cần cho webhook TikTok Shop: chữ ký ký trên đúng chuỗi JSON gốc, nên
  // `JSON.stringify(req.body)` không dùng thay được (khác thứ tự key/khoảng trắng).
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });

  // Sau load balancer (Railway), `req.ip` mặc định là IP nội bộ của LB — mọi request
  // trông như đến từ cùng một nguồn, làm hỏng cả giới hạn tần suất theo IP lẫn IP ghi
  // trong audit log. Tin đúng MỘT lớp proxy: đọc IP thật từ nhánh cuối của
  // `X-Forwarded-For`, không tin cả chuỗi (client tự bịa được các nhánh phía trước).
  app.set('trust proxy', 1);

  app.use(compression());
  // Access/refresh token đi bằng cookie `httpOnly` do chính API này đặt, nên guard cần
  // `req.cookies`. Không ký cookie ở tầng này: nội dung đã là JWT có chữ ký riêng, ký
  // thêm một lớp nữa chỉ tốn cấu hình mà không thêm bảo đảm nào.
  app.use(cookieParser());

  const uploadDir = process.env.UPLOAD_DIR ?? join(process.cwd(), 'uploads');
  app.useStaticAssets(uploadDir, { prefix: '/uploads' });

  app.setGlobalPrefix('api');
  // `credentials: true` + danh sách origin tường minh là bắt buộc để trình duyệt gửi
  // cookie phiên đi: với `Access-Control-Allow-Origin: *` thì cookie bị bỏ lại, và triệu
  // chứng là "đăng nhập xong mọi request vẫn 401" chứ không phải lỗi CORS dễ thấy.
  app.enableCors({
    origin: process.env.CORS_ORIGIN?.split(',').map((o) => o.trim()) ?? [
      'http://localhost:3000',
      'http://localhost:3001',
      'http://localhost:3002',
    ],
    credentials: true,
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
