#!/usr/bin/env node
/**
 * prisma migrate deploy với URL đã ép default_transaction_read_only=off.
 * Dùng cho CI/CD / container start khi Supabase để DB read-only.
 *
 * Nếu DB còn migration failed (P3009), resolve rồi deploy lại.
 * Trường hợp đã biết: 20260806130000_add_inventory_levels_pk (thêm PK khi PK đã tồn tại).
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/** Migration từng fail trên production; SQL đã idempotent — resolve rồi chạy lại an toàn. */
const KNOWN_FAILED_MIGRATIONS = ['20260806130000_add_inventory_levels_pk'];

function ensureWritableDbUrl(url) {
  if (!url) return url;
  try {
    const normalized = url.replace(/^postgresql:/i, 'http:');
    const u = new URL(normalized);
    const existing = u.searchParams.get('options') ?? '';
    if (!/default_transaction_read_only/i.test(existing)) {
      const add = '-c default_transaction_read_only=off';
      u.searchParams.set('options', existing ? `${existing} ${add}` : add);
    }
    return u.toString().replace(/^http:/i, 'postgresql:');
  } catch {
    return url;
  }
}

try {
  fs.readFileSync(path.join(process.cwd(), '.env'), 'utf8')
    .split('\n')
    .forEach((line) => {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!m) return;
      if (process.env[m[1]] != null && process.env[m[1]] !== '') return;
      process.env[m[1]] = m[2].replace(/^"|"$/g, '');
    });
} catch {
  // no .env
}

process.env.DATABASE_URL = ensureWritableDbUrl(process.env.DATABASE_URL);
process.env.DIRECT_URL = ensureWritableDbUrl(
  process.env.DIRECT_URL || process.env.DATABASE_URL,
);

const prismaBin = path.join(process.cwd(), 'node_modules', '.bin', 'prisma');

function runPrisma(args) {
  return spawnSync(prismaBin, args, {
    encoding: 'utf8',
    env: process.env,
  });
}

function printResult(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

function isP3009(result) {
  const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  return text.includes('P3009') || /failed migrations/i.test(text);
}

function resolveKnownFailedMigrations() {
  for (const name of KNOWN_FAILED_MIGRATIONS) {
    console.log(
      `[migrate-deploy] Resolving failed migration as rolled-back: ${name}`,
    );
    const resolved = runPrisma([
      'migrate',
      'resolve',
      '--rolled-back',
      name,
    ]);
    printResult(resolved);
    if (resolved.status !== 0) {
      console.log(
        `[migrate-deploy] resolve ${name} skipped/failed (may already be applied)`,
      );
    }
  }
}

let result = runPrisma(['migrate', 'deploy']);
printResult(result);

if (result.status !== 0 && isP3009(result)) {
  console.log(
    '[migrate-deploy] Detected P3009 — clearing known failed migration(s) and retrying deploy',
  );
  resolveKnownFailedMigrations();
  result = runPrisma(['migrate', 'deploy']);
  printResult(result);
}

process.exit(result.status ?? 1);
