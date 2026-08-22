#!/usr/bin/env node
/**
 * Client SQL trên terminal, dùng DATABASE_URL trong backend/.env
 *
 *   node scripts/db.mjs                    -> chế độ tương tác (REPL)
 *   node scripts/db.mjs "SELECT 1"         -> chạy 1 câu rồi thoát
 *   node scripts/db.mjs -f file.sql        -> chạy file .sql
 *
 * Trong REPL: \dt bảng, \d <bảng> cột, \q thoát
 */
import { readFileSync } from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadEnv() {
  const raw = readFileSync(path.join(root, '.env'), 'utf8');
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
}
loadEnv();

const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
if (!url) { console.error('Không tìm thấy DATABASE_URL trong backend/.env'); process.exit(1); }

// pg >= 8.16 hiểu sslmode=require là verify-full -> gỡ tham số ra, tự bật SSL
const clean = url.replace(/[?&]sslmode=[^&]*/g, (m) => (m[0] === '?' ? '?' : '')).replace(/\?$/, '');
const client = new pg.Client({ connectionString: clean, ssl: { rejectUnauthorized: false } });

const SHORTCUTS = {
  '\\dt': `SELECT table_name, (SELECT reltuples::bigint FROM pg_class WHERE oid = ('public.'||quote_ident(table_name))::regclass) AS rows_est
           FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`,
  '\\l': `SELECT datname FROM pg_database WHERE datistemplate = false`,
};

function expand(sql) {
  const t = sql.trim();
  if (SHORTCUTS[t]) return SHORTCUTS[t];
  const d = t.match(/^\\d\s+(\S+)$/);
  if (d) return `SELECT column_name, data_type, is_nullable, column_default
                 FROM information_schema.columns WHERE table_schema='public' AND table_name='${d[1]}'
                 ORDER BY ordinal_position`;
  return sql;
}

async function run(sql) {
  try {
    const res = await client.query(expand(sql));
    const sets = Array.isArray(res) ? res : [res];
    for (const r of sets) {
      if (r.rows?.length) { console.table(r.rows); console.log(`(${r.rowCount} dòng)`); }
      else console.log(`${r.command ?? 'OK'} — ${r.rowCount ?? 0} dòng`);
    }
  } catch (e) {
    console.error('LỖI:', e.message);
  }
}

await client.connect();

const args = process.argv.slice(2);
if (args[0] === '-f') {
  await run(readFileSync(args[1], 'utf8'));
  await client.end();
} else if (args.length) {
  await run(args.join(' '));
  await client.end();
} else {
  const host = new URL(url).host;
  console.log(`Đã kết nối ${host}. Gõ \\dt để xem bảng, \\q để thoát.`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'db> ' });
  let buf = '';
  rl.prompt();
  rl.on('line', async (line) => {
    const t = line.trim();
    if (t === '\\q' || t === 'exit') return rl.close();
    buf += line + '\n';
    // Lệnh tắt chạy ngay, SQL thường phải kết thúc bằng ;
    if (t.startsWith('\\') || t.endsWith(';')) {
      await run(buf.replace(/;\s*$/, ''));
      buf = '';
    }
    rl.setPrompt(buf ? '  -> ' : 'db> ');
    rl.prompt();
  });
  rl.on('close', async () => { await client.end(); process.exit(0); });
}
