/**
 * Danh sách origin được phép — dùng chung cho `enableCors` (quyết định trình duyệt có
 * cho đọc phản hồi không) và `CsrfGuard` (quyết định có cho request chạy không).
 *
 * Phải là MỘT nguồn: hai danh sách lệch nhau thì một origin lọt được CSRF guard nhưng
 * trượt CORS, và triệu chứng là "request có tác dụng nhưng UI báo lỗi mạng" — dữ liệu đã
 * đổi rồi mà người dùng tưởng chưa.
 */

/**
 * Không có mặc định ở BẤT KỲ môi trường nào, kể cả dev.
 *
 * Một danh sách localhost viết cứng trong file này nghe vô hại, nhưng nó là thứ nuốt mất
 * lỗi cấu hình: quên khai `CORS_ORIGIN` thì app vẫn khởi động ngon lành, chỉ có điều mọi
 * request từ domain thật bị trình duyệt bỏ cookie lại. Triệu chứng là "đăng nhập xong
 * request nào cũng 401" — một lỗi cấu hình đội lốt lỗi xác thực, tốn hàng giờ để lần ra.
 * Chết lúc khởi động thì chỉ tốn một dòng log.
 *
 * Bắt buộc cả ở dev vì cùng lý do đã áp cho `JWT_SECRET`: giá trị nào ảnh hưởng tới việc
 * cookie có tới nơi hay không thì phải đọc được trong `.env`, không nằm rải trong code.
 * Đổi cổng FE lúc đó là sửa một dòng env, không phải sửa rồi build lại backend.
 */
export function allowedOrigins(): string[] {
  const configured = process.env.CORS_ORIGIN?.split(',')
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter(Boolean);

  if (!configured?.length) {
    throw new Error(
      'Thiếu biến môi trường bắt buộc: CORS_ORIGIN — khai origin của FE, nhiều giá trị ' +
        'ngăn cách bằng dấu phẩy. Dev: CORS_ORIGIN="http://localhost:4002" — ' +
        'production: CORS_ORIGIN="https://app.vienchibao.vn"',
    );
  }

  configured.forEach(assertValidOrigin);
  return configured;
}

/**
 * Nay không còn mặc định đúng để rơi về, một giá trị gõ sai trong `.env` sẽ không còn ai
 * đỡ — mà origin sai thì KHÔNG bao giờ ném lỗi, nó chỉ lặng lẽ không khớp. Bắt ba lỗi
 * gõ hay gặp nhất ngay tại lúc khởi động:
 *
 *   - thiếu scheme (`localhost:4002`) — `Origin` trình duyệt gửi luôn có scheme;
 *   - dính đường dẫn khi copy từ thanh địa chỉ (`https://app.test/dashboard`);
 *   - `*` — vô hiệu với `credentials: true`, trình duyệt bỏ cookie lại mà không báo gì.
 */
function assertValidOrigin(origin: string): void {
  const hint = `CORS_ORIGIN chứa giá trị không hợp lệ: "${origin}".`;

  if (origin === '*') {
    throw new Error(
      `${hint} Dấu * không dùng được cùng cookie phiên (credentials: true) — ` +
        'trình duyệt bỏ cookie lại. Khai tường minh từng origin.',
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error(
      `${hint} Phải là origin đầy đủ, ví dụ "http://localhost:4002".`,
    );
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${hint} Chỉ chấp nhận scheme http hoặc https.`);
  }
  // `new URL('https://a.test/x').origin` cắt sạch phần thừa, nên so lại với chuỗi gốc là
  // cách gọn nhất để phát hiện đường dẫn/query dính kèm.
  if (parsed.origin !== origin) {
    throw new Error(
      `${hint} Chỉ khai scheme + host + cổng, bỏ mọi đường dẫn — ý bạn là "${parsed.origin}".`,
    );
  }
}

export function isAllowedOrigin(origin: string): boolean {
  return allowedOrigins().includes(origin.trim().replace(/\/$/, ''));
}
