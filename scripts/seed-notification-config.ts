#!/usr/bin/env ts-node
/**
 * Nạp cấu hình thông báo vào DB đã có dữ liệu thật (idempotent, chạy lại vô hại).
 *
 * Chạy: npx ts-node --compiler-options '{"module":"CommonJS"}' scripts/seed-notification-config.ts
 *
 * Vì sao KHÔNG dùng `prisma db seed`: `seedRbac()` trong prisma/seed.ts có
 * `rolePermission.deleteMany()` rồi tạo lại theo DEFAULT_ROLE_PERMISSIONS — chạy trên DB
 * thật sẽ xoá sạch mọi tuỳ chỉnh phân quyền admin đã làm qua màn quản lý vai trò.
 * Script này chỉ THÊM, không xoá gì.
 *
 * Làm 2 việc:
 * 1. Upsert permission `notification:manage` và gán cho các role đang có toàn quyền
 *    (theo DEFAULT_ROLE_PERMISSIONS: role nào khai '*') + store_manager.
 * 2. Upsert 8 dòng `notification_settings` mặc định.
 */
import 'dotenv/config';
import { NotificationTopic, PrismaClient } from '@prisma/client';
import {
  DEFAULT_ROLE_PERMISSIONS,
  PERMISSION_CATALOG,
} from '../src/modules/rbac/permission-catalog';

const prisma = new PrismaClient();

const SETTINGS: { topic: NotificationTopic; recipientPermissions: string[] }[] =
  [
    { topic: 'orders_create', recipientPermissions: ['order:view'] },
    { topic: 'orders_paid', recipientPermissions: ['order:view'] },
    { topic: 'orders_cancelled', recipientPermissions: ['order:view'] },
    { topic: 'orders_fulfilled', recipientPermissions: ['order:view'] },
    { topic: 'fulfillments_create', recipientPermissions: ['order:pack'] },
    { topic: 'fulfillments_update', recipientPermissions: ['order:pack'] },
    { topic: 'refunds_create', recipientPermissions: ['order:view'] },
    { topic: 'customers_create', recipientPermissions: ['customer:view'] },
    // Cảnh báo tồn kho — hai việc thuộc hai bộ phận khác nhau nên người nhận khác nhau:
    // "cần nhập hàng" là việc của mua hàng, "âm kho" là việc của nhân viên kho.
    { topic: 'inventory_low_stock', recipientPermissions: ['purchasing:manage'] },
    { topic: 'inventory_negative', recipientPermissions: ['inventory:view'] },
  ];

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

  for (const s of SETTINGS) {
    await prisma.notificationSetting.upsert({
      where: { topic: s.topic },
      update: {}, // không ghi đè lựa chọn admin đã chỉnh trên UI
      create: s,
    });
  }
  console.log(`✓ ${SETTINGS.length} notification_settings`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
