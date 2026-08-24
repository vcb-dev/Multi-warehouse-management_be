/**
 * Danh sách origin được phép — dùng chung cho `enableCors` (quyết định trình duyệt có
 * cho đọc phản hồi không) và `CsrfGuard` (quyết định có cho request chạy không).
 *
 * Phải là MỘT nguồn: hai danh sách lệch nhau thì một origin lọt được CSRF guard nhưng
 * trượt CORS, và triệu chứng là "request có tác dụng nhưng UI báo lỗi mạng" — dữ liệu đã
 * đổi rồi mà người dùng tưởng chưa.
 */

/** Dev mặc định: FE Next chạy 4002, cổng 4000 để dành cho bản build thử. */
const DEV_ORIGINS = ['http://localhost:4000', 'http://localhost:4002'];

/**
 * Không có mặc định cho production. Rơi về localhost trên môi trường thật nghĩa là mọi
 * request từ domain thật bị trình duyệt bỏ cookie lại, và triệu chứng là "đăng nhập xong
 * request nào cũng 401" — một lỗi cấu hình đội lốt lỗi xác thực, tốn hàng giờ để lần ra.
 * Chết lúc khởi động thì chỉ tốn một dòng log.
 */
export function allowedOrigins(): string[] {
  const configured = process.env.CORS_ORIGIN?.split(',')
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter(Boolean);

  if (configured?.length) return configured;

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Thiếu biến môi trường bắt buộc: CORS_ORIGIN. Khai origin của FE, ' +
        'ví dụ: CORS_ORIGIN="https://app.vienchibao.vn"',
    );
  }
  return DEV_ORIGINS;
}

export function isAllowedOrigin(origin: string): boolean {
  return allowedOrigins().includes(origin.trim().replace(/\/$/, ''));
}
