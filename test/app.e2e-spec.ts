/**
 * Smoke test khởi động app: prefix `/api` và chốt chặn xác thực.
 *
 * Bản cũ là scaffold mặc định của NestJS (`GET /` → "Hello World!") nên fail từ
 * lúc `main.ts` đặt `setGlobalPrefix('api')`.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';

describe('AppController (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    // Phản chiếu bootstrap thật (main.ts) — prefix set ở đó chứ không ở AppModule.
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/health — không cần token', async () => {
    const res = await request(app.getHttpServer()).get('/api/health').expect(200);
    expect(res.body).toMatchObject({ status: 'ok' });
  });

  it('GET / — không còn route gốc sau khi đặt prefix', () => {
    return request(app.getHttpServer()).get('/').expect(404);
  });

  it('route cần quyền — trả 401 khi thiếu token', () => {
    return request(app.getHttpServer()).get('/api/products').expect(401);
  });
});
