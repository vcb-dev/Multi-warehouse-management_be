#!/usr/bin/env ts-node
/**
 * Nạp cấu hình thông báo vào DB đã có dữ liệu thật (idempotent, chạy lại vô hại).
 *
 * Chạy: npx ts-node --compiler-options '{"module":"CommonJS"}' scripts/seed-notification-config.ts
 *
 * Thêm `--force-routing` để ÁP LẠI người nhận mặc định cho cả những dòng đã có. Mặc định
 * KHÔNG làm điều đó (chỉ thêm dòng thiếu) vì sẽ xoá lựa chọn admin đã chỉnh trên UI — chỉ
 * dùng cờ này khi biết chắc chưa ai đụng vào màn Cấu hình > Thông báo.
 *
 * Vì sao KHÔNG dùng `prisma db seed`: `seedRbac()` trong prisma/seed.ts có
 * `rolePermission.deleteMany()` rồi tạo lại theo DEFAULT_ROLE_PERMISSIONS — chạy trên DB
 * thật sẽ xoá sạch mọi tuỳ chỉnh phân quyền admin đã làm qua màn quản lý vai trò.
 * Script này chỉ THÊM, không xoá gì.
 *
 * Làm 2 việc:
 * 1. Upsert permission `notification:manage` và gán cho các role đang có toàn quyền
 *    (theo DEFAULT_ROLE_PERMISSIONS: role nào khai '*') + store_manager.
 * 2. Upsert các dòng `notification_settings` mặc định (danh sách ở
 *    src/modules/notifications/notification.defaults.ts).
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { NOTIFICATION_SETTING_DEFAULTS } from '../src/modules/notifications/notification.defaults';
import {
  DEFAULT_ROLE_PERMISSIONS,
  PERMISSION_CATALOG,
} from '../src/modules/rbac/permission-catalog';

const prisma = new PrismaClient();

async function main() {
  const def = PERMISSION_CATALOG.find((p) => p.key === 'notification:manage');
  if (!def) throw new Error('Thiếu notification:manage trong PERMISSION_CATALOG');

  const perm = await prisma.permission.upsert({
    where: { key: def.key },
    update: { group: def.group, label: def.label, scope: def.scope },
    create: def,
  });
  console.log(`✓ permission ${def.key} (id=${perm.id})`);

  // Role nào theo catalog đáng lẽ có quyền này thì gán bổ sung.
  const roleCodes = Object.entries(DEFAULT_ROLE_PERMISSIONS)
    .filter(
      ([, d]) =>
        d.permissions === '*' || d.permissions.includes('notification:manage'),
    )
    .map(([code]) => code);

  for (const code of roleCodes) {
    const role = await prisma.role.findUnique({ where: { code } });
    if (!role) {
      console.log(`  – role "${code}" chưa tồn tại, bỏ qua`);
      continue;
    }
    await prisma.rolePermission.upsert({
      where: {
        roleId_permissionId: { roleId: role.id, permissionId: perm.id },
      },
      update: {},
      create: { roleId: role.id, permissionId: perm.id },
    });
    console.log(`  ✓ gán cho role "${code}"`);
  }

  const forceRouting = process.argv.includes('--force-routing');
  for (const s of NOTIFICATION_SETTING_DEFAULTS) {
    await prisma.notificationSetting.upsert({
      where: { topic: s.topic },
      // Mặc định không ghi đè lựa chọn admin đã chỉnh trên UI.
      update: forceRouting
        ? { recipientPermissions: s.recipientPermissions }
        : {},
      create: s,
    });
  }
  console.log(
    `✓ ${NOTIFICATION_SETTING_DEFAULTS.length} notification_settings` +
      (forceRouting ? ' (đã áp lại người nhận mặc định)' : ''),
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
