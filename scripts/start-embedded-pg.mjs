import EmbeddedPostgres from 'embedded-postgres';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const databaseDir = path.resolve(__dirname, '../.embedded-postgres');

const pg = new EmbeddedPostgres({
  databaseDir,
  user: 'postgres',
  password: 'postgres',
  port: 5432,
  persistent: true,
});

async function main() {
  if (!fs.existsSync(path.join(databaseDir, 'PG_VERSION'))) {
    console.error('Chưa migrate. Chạy: node scripts/run-migrate-with-embedded-pg.mjs');
    process.exit(1);
  }
  await pg.start();
  console.log('PostgreSQL: postgresql://postgres:postgres@127.0.0.1:5432/vien_chi_bao?schema=public');
  console.log('Nhấn Ctrl+C để dừng.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

process.on('SIGINT', async () => {
  await pg.stop();
  process.exit(0);
});
