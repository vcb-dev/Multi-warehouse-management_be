/**
 * Kiểm tra kết nối Supabase/Postgres từ .env (không in password).
 * Chạy: node scripts/test-db-connection.mjs
 */
import 'dotenv/config';
import pg from 'pg';

const { Client } = pg;

async function tryConnect(label, connectionString, clientOptions = {}) {
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 15000,
    ...clientOptions,
  });
  try {
    await client.connect();
    const { rows } = await client.query(
      'select current_user as user, current_database() as db',
    );
    console.log(`✓ ${label}: OK (${rows[0].user}@${rows[0].db})`);
    await client.end();
    return true;
  } catch (err) {
    const code = err.code ?? 'UNKNOWN';
    const hint =
      code === '28P01'
        ? ' → Sai mật khẩu. Reset tại Supabase → Settings → Database.'
        : code === 'ENOTFOUND'
          ? ' → Không resolve hostname (IPv6/direct URL trên mạng IPv4-only).'
          : String(err.message).includes('SELF_SIGNED')
            ? ' → Lỗi SSL cert. Thử bỏ sslmode khỏi URL hoặc cập nhật Node.js.'
            : '';
    console.log(`✗ ${label}: ${code}${hint}`);
    try {
      await client.end();
    } catch {
      /* ignore */
    }
    return false;
  }
}

const direct = process.env.DIRECT_URL;
const pooled = process.env.DATABASE_URL;

if (!direct) {
  console.error('Thiếu DIRECT_URL trong .env');
  process.exit(1);
}

console.log('Đang kiểm tra kết nối...\n');

const base = direct.split('?')[0];
const sslRelaxed = { ssl: { rejectUnauthorized: false } };

await tryConnect('DIRECT_URL (từ .env)', direct);
await tryConnect('DIRECT_URL (SSL relaxed)', base, sslRelaxed);
if (pooled) {
  const pooledBase = pooled.split('?')[0];
  await tryConnect('DATABASE_URL pooler (SSL relaxed)', pooledBase, sslRelaxed);
}
