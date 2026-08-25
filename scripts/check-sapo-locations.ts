#!/usr/bin/env tsx
/**
 * Đối chiếu danh sách kho giữa Sapo và DB — CHỈ ĐỌC, không ghi gì.
 *
 * Chạy: npx tsx scripts/check-sapo-locations.ts
 *   (cần SAPO_STORE / SAPO_API_KEY / SAPO_API_SECRET + DATABASE_URL trong môi trường)
 *
 * Vì sao có script này bên cạnh `SapoLocationSyncService`: service kia GHI (thêm/sửa kho),
 * còn đây chỉ soi lệch để quyết định có nên đồng bộ hay không. Chạy được cả trên máy chỉ có
 * quyền đọc, và không cần dựng cả Nest lên.
 *
 * Ba nhóm lệch được liệt kê riêng, vì cách xử lý khác nhau:
 *   - CHỈ CÓ TRÊN SAPO  → thiếu kho trong DB. Đơn của kho này đang bị gán tạm vào kho mặc
 *     định (xem `SapoOrderSyncService`) và tồn của nó không bao giờ được kéo về.
 *   - CHỈ CÓ TRONG DB   → Sapo không trả về. Không xoá được (đơn/tồn đang trỏ vào), chỉ để
 *     biết mà ngừng dùng.
 *   - LỆCH THUỘC TÍNH   → cùng `sapo_id` nhưng khác tên/trạng thái/code.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';

/**
 * Nạp `.env` bằng tay thay vì `import 'dotenv/config'`: `dotenv` KHÔNG phải dependency của
 * dự án (kiểm 25/08/2026 — không có trong package.json lẫn node_modules), nên mọi script cũ
 * mở đầu bằng `require('dotenv')` đều chết ngay dòng đầu ở môi trường cài bằng pnpm.
 * Biến đã có sẵn trong môi trường thì được giữ nguyên, không bị `.env` ghi đè.
 */
function loadEnv() {
  try {
    const raw = readFileSync(join(__dirname, '..', '.env'), 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (!m || process.env[m[1]]) continue;
      process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  } catch {
    // Không có .env cũng không sao — trên server biến nằm sẵn trong môi trường.
  }
}
loadEnv();

const prisma = new PrismaClient();

const STORE = process.env.SAPO_STORE;
const KEY = process.env.SAPO_API_KEY;
const SECRET = process.env.SAPO_API_SECRET;

type SapoLocation = {
  id: number;
  code: string | null;
  name: string | null;
  status: string | null;
};

async function fetchSapoLocations(): Promise<SapoLocation[]> {
  const auth = Buffer.from(`${KEY}:${SECRET}`).toString('base64');
  const out: SapoLocation[] = [];
  for (let page = 1; ; page++) {
    const res = await fetch(
      `https://${STORE}.mysapo.net/admin/locations.json?limit=250&page=${page}`,
      { headers: { Authorization: `Basic ${auth}` } },
    );
    if (!res.ok) throw new Error(`Sapo HTTP ${res.status}`);
    const json = (await res.json()) as { locations?: SapoLocation[] };
    const rows = json.locations ?? [];
    out.push(...rows);
    if (rows.length < 250) break;
  }
  return out;
}

async function main() {
  if (!STORE || !KEY || !SECRET) {
    console.error(
      'Thiếu SAPO_STORE / SAPO_API_KEY / SAPO_API_SECRET trong môi trường.',
    );
    process.exit(1);
  }

  const [remote, local] = await Promise.all([
    fetchSapoLocations(),
    prisma.location.findMany({
      select: { id: true, sapoId: true, code: true, name: true, status: true },
      orderBy: { id: 'asc' },
    }),
  ]);

  const localBySapo = new Map(
    local.filter((l) => l.sapoId).map((l) => [String(l.sapoId), l]),
  );
  const remoteById = new Map(remote.map((r) => [String(r.id), r]));

  const onlySapo = remote.filter((r) => !localBySapo.has(String(r.id)));
  const onlyLocal = local.filter(
    (l) => !l.sapoId || !remoteById.has(String(l.sapoId)),
  );
  type Pair = { r: SapoLocation; l: (typeof local)[number] };
  const drifted = remote
    .map((r) => ({ r, l: localBySapo.get(String(r.id)) }))
    .filter((p): p is Pair => {
      const { r, l } = p;
      if (!l) return false;
      const name = (r.name ?? '').trim();
      const status = (r.status ?? 'active').trim();
      const code = (r.code ?? '').trim() || null;
      return name !== l.name || status !== l.status || code !== l.code;
    });

  console.log(`Sapo: ${remote.length} kho | DB: ${local.length} kho\n`);

  console.log(`=== CHỈ CÓ TRÊN SAPO (thiếu trong DB): ${onlySapo.length} ===`);
  for (const r of onlySapo) {
    console.log(`  + ${String(r.id).padEnd(9)} ${r.status ?? '?'}  ${r.name}`);
  }

  console.log(
    `\n=== CHỈ CÓ TRONG DB (Sapo không trả): ${onlyLocal.length} ===`,
  );
  for (const l of onlyLocal) {
    console.log(
      `  - ${String(l.sapoId ?? 'không có sapo_id').padEnd(9)} ${l.status}  ${l.name}`,
    );
  }

  console.log(`\n=== LỆCH THUỘC TÍNH: ${drifted.length} ===`);
  for (const { r, l } of drifted) {
    const diffs: string[] = [];
    if ((r.name ?? '').trim() !== l.name) {
      diffs.push(`tên: "${l.name}" → "${r.name}"`);
    }
    if ((r.status ?? 'active').trim() !== l.status) {
      diffs.push(`trạng thái: ${l.status} → ${r.status}`);
    }
    const code = (r.code ?? '').trim() || null;
    if (code !== l.code) diffs.push(`code: ${l.code ?? '∅'} → ${code ?? '∅'}`);
    console.log(`  ~ ${String(r.id).padEnd(9)} ${diffs.join(' | ')}`);
  }

  const total = onlySapo.length + onlyLocal.length + drifted.length;
  console.log(
    total === 0
      ? '\n✅ Không lệch — DB khớp Sapo.'
      : `\n⚠️  Tổng ${total} điểm lệch. Đồng bộ bằng: POST /channels/sapo/location-sync`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
