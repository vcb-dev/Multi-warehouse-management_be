import type { ConfigService } from '@nestjs/config';

/** Giá trị mẫu hay bị copy nguyên từ file `.env.example` rồi đem chạy thật. */
const PLACEHOLDER_SECRETS = new Set([
  'change-me-in-production',
  'changeme',
  'change-me',
  'secret',
  'dev',
  'test',
]);

/**
 * Độ dài tối thiểu cho secret. `openssl rand -base64 32` cho 44 ký tự; ngưỡng 32
 * đủ chỗ cho các cách sinh khác mà vẫn loại được cụm từ người tự nghĩ ra.
 */
const MIN_SECRET_LENGTH = 32;

/**
 * Secret không được có giá trị mặc định. Thiếu env ở production mà app vẫn khởi
 * động nghĩa là token được ký bằng chuỗi nằm sẵn trong repo — ai cũng giả mạo
 * được. Throw ở đây làm app chết ngay lúc bootstrap thay vì im lặng tới lần
 * đăng nhập đầu tiên.
 *
 * Với biến tên `*_SECRET`, kiểm thêm độ dài và giá trị mẫu: một secret ngắn kiểu
 * cụm từ dễ nhớ bị dò ngược offline từ đúng MỘT token bắt được (HS256, hashcat
 * -m 16500), mà dò ra là ký được token cho bất kỳ user id nào. "Có đặt biến" và
 * "đặt biến an toàn" là hai chuyện khác nhau, nên phải chặn cả hai.
 */
export function requireEnv(config: ConfigService, key: string): string {
  const value = config.get<string>(key)?.trim();
  if (!value) {
    throw new Error(
      `Thiếu biến môi trường bắt buộc: ${key}. Đặt ${key} trước khi khởi động ứng dụng.`,
    );
  }

  if (key.endsWith('_SECRET')) {
    if (PLACEHOLDER_SECRETS.has(value.toLowerCase())) {
      throw new Error(
        `${key} vẫn đang là giá trị mẫu. Sinh giá trị thật bằng: openssl rand -base64 32`,
      );
    }
    if (value.length < MIN_SECRET_LENGTH) {
      throw new Error(
        `${key} quá ngắn (${value.length} ký tự, cần tối thiểu ${MIN_SECRET_LENGTH}). ` +
          `Sinh bằng: openssl rand -base64 32`,
      );
    }
  }

  return value;
}
