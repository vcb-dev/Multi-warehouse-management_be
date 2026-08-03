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

// PHẢI ghi đè cả DIRECT_URL: schema khai `directUrl = env("DIRECT_URL")` và
// `prisma migrate` dùng directUrl thay cho url. Chỉ tiêm DATABASE_URL thì
// migration chạy lên DB trong .env (Supabase production) chứ không phải DB nhúng.
const env = { ...process.env, DATABASE_URL, DIRECT_URL: DATABASE_URL };

async function ensureDatabase() {
  try {
    await pg.createDatabase('vien_chi_bao');
  } catch {
    // database may already exist on reruns
  }
}

async function main() {
  console.log('Starting embedded PostgreSQL on port 5432...');
  if (!fs.existsSync(path.join(databaseDir, 'PG_VERSION'))) {
    await pg.initialise();
  }
  await pg.start();
  await ensureDatabase();

  console.log('Applying migrations...');
  execSync('npx prisma migrate deploy', {
    cwd: backendRoot,
    stdio: 'inherit',
    env,
  });

  console.log('Seeding database...');
  execSync('npm run db:seed', {
    cwd: backendRoot,
    stdio: 'inherit',
    env,
  });

  console.log('\nDone. PostgreSQL is still running (embedded, port 5432).');
  console.log('DATABASE_URL=', DATABASE_URL);
  console.log('Press Ctrl+C to stop the database server.');
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

process.on('SIGINT', async () => {
  console.log('\nStopping embedded PostgreSQL...');
  await pg.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await pg.stop();
  process.exit(0);
});
