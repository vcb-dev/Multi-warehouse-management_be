/**
 * Cấu hình khoá ký và thời gian sống của hai token.
 *
 * Đọc env ở thời điểm GỌI chứ không phải lúc import: `ConfigModule.forRoot()` chỉ nạp
 * `.env` khi Nest dựng module, mà các câu `import` ở đầu `app.module.ts` chạy trước đó.
 * Gọi sớm là `process.env.JWT_SECRET` còn rỗng và app chết oan ngay cả khi đã khai đủ.
 */

/** Giá trị mẫu hay bị copy nguyên từ `.env.example` rồi đem chạy thật. */
const PLACEHOLDER_SECRETS = new Set([
  'change-me-in-production',
  'changeme',
  'change-me',
  'secret',
  'dev',
  'test',
]);

/** `openssl rand -base64 32` cho 44 ký tự; 32 là ngưỡng loại được cụm từ tự nghĩ. */
const MIN_SECRET_LENGTH = 32;

/** Ghi vào claim `iss`, kiểm lại lúc verify — chặn token của hệ khác cùng khoá lọt vào. */
export const JWT_ISSUER = 'vcb-api';

/**
 * Không có giá trị mặc định: thiếu env mà app vẫn chạy nghĩa là token được ký bằng chuỗi
 * nằm sẵn trong repo, ai cũng tự phát access token cho mình được. Thà chết lúc khởi động.
 *
 * Đây chính là thứ mô hình phiên đục trước đây không có. Đổi lại quyền tự chứng minh của
 * JWT (không tra DB mỗi request) là phải canh khoá này như canh mật khẩu database.
 */
export function jwtSecret(): string {
  const value = process.env.JWT_SECRET?.trim();
  if (!value) {
    throw new Error(
      'Thiếu biến môi trường bắt buộc: JWT_SECRET. Sinh bằng: openssl rand -base64 32',
    );
  }
  if (PLACEHOLDER_SECRETS.has(value.toLowerCase())) {
    throw new Error(
      'JWT_SECRET vẫn đang là giá trị mẫu. Sinh giá trị thật bằng: openssl rand -base64 32',
    );
  }
  if (value.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `JWT_SECRET quá ngắn (${value.length} ký tự, cần tối thiểu ${MIN_SECRET_LENGTH}). ` +
        'Sinh bằng: openssl rand -base64 32',
    );
  }
  return value;
}

function positiveNumber(key: string, fallback: number): number {
  const raw = process.env[key]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${key} phải là số dương, đang là "${raw}".`);
  }
  return parsed;
}

/**
 * Access token KHÔNG tra database, nên trong khoảng thời gian này nó vẫn được chấp nhận
 * kể cả khi tài khoản vừa bị khoá — TTL chính là độ trễ thu hồi tối đa mà ta chấp nhận.
 * 15 phút đủ ngắn để thiệt hại có giới hạn, đủ dài để không phải xoay token liên tục.
 *
 * (Thực tế thu hồi nhanh hơn nhiều: xem `TokenService.resolveAuthUser` — mỗi lượt cache
 * miss có kiểm họ refresh còn sống không, nên đăng xuất có hiệu lực trong ~30 giây.)
 */
export function accessTtlMs(): number {
  return positiveNumber('JWT_ACCESS_TTL_MINUTES', 15) * 60 * 1000;
}

/** Hết hạn refresh token = phải đăng nhập lại. Khớp cảm giác "một tuần không phải gõ lại". */
export function refreshTtlMs(): number {
  return positiveNumber('JWT_REFRESH_TTL_DAYS', 7) * 24 * 60 * 60 * 1000;
}
