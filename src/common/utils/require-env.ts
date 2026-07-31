import type { ConfigService } from '@nestjs/config';

/**
 * Secret không được có giá trị mặc định. Thiếu env ở production mà app vẫn khởi
 * động nghĩa là token được ký bằng chuỗi nằm sẵn trong repo — ai cũng giả mạo
 * được. Throw ở đây làm app chết ngay lúc bootstrap thay vì im lặng tới lần
 * đăng nhập đầu tiên.
 */
export function requireEnv(config: ConfigService, key: string): string {
  const value = config.get<string>(key)?.trim();
  if (!value) {
    throw new Error(
      `Thiếu biến môi trường bắt buộc: ${key}. Đặt ${key} trước khi khởi động ứng dụng.`,
    );
  }
  return value;
}
