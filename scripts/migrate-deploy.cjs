#!/usr/bin/env node
/**
 * prisma migrate deploy với URL đã ép default_transaction_read_only=off.
 * Dùng cho CI/CD / container start khi Supabase để DB read-only.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

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
const result = spawnSync(prismaBin, ['migrate', 'deploy'], {
  stdio: 'inherit',
  env: process.env,
});

process.exit(result.status ?? 1);
