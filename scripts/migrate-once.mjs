import EmbeddedPostgres from 'embedded-postgres';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(__dirname, '..');
const databaseDir = path.join(backendRoot, '.embedded-postgres');
const DATABASE_URL =
  'postgresql://postgres:postgres@127.0.0.1:5432/vien_chi_bao?schema=public';

const pg = new EmbeddedPostgres({
  databaseDir,
  user: 'postgres',
  password: 'postgres',
  port: 5432,
  persistent: true,
});

// Ghi đè cả DIRECT_URL — `prisma migrate` đọc `directUrl` trước `url`, bỏ sót
// nó thì migration chạy lên DB trong .env (production) thay vì DB nhúng.
const env = { ...process.env, DATABASE_URL, DIRECT_URL: DATABASE_URL };

async function ensureDatabase() {
  try {
    await pg.createDatabase('vien_chi_bao');
  } catch {
    /* already exists */
  }
}

async function main() {
  if (!fs.existsSync(path.join(databaseDir, 'PG_VERSION'))) {
    await pg.initialise();
  }
  await pg.start();
  await ensureDatabase();

  execSync('npx prisma migrate deploy', {
    cwd: backendRoot,
    stdio: 'inherit',
    env,
  });

  await pg.stop();
  console.log('Migration complete.');
}

main().catch(async (err) => {
  console.error(err);
  try {
    await pg.stop();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
