
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
