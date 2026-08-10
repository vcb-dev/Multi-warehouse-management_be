/**
 * Seed một phần: shipping providers + địa chỉ chi nhánh + sync catalog quyền.
 * Không đụng tới dữ liệu sản phẩm/tồn kho (DB có dữ liệu thật).
 */
import { PrismaClient } from '@prisma/client';
import {
  PERMISSION_CATALOG,
  DEFAULT_ROLE_PERMISSIONS,
} from '../src/modules/rbac/permission-catalog';

const prisma = new PrismaClient();

async function main() {
  // 1. Shipping providers
  const carriers = [
    {
      code: 'ghn',
      name: 'GHN Express',
      isConnected: false,
      servicesConfig: [
        { code: 'standard', name: 'Chuẩn', eta: '2-3 ngày', base_fee: 44080, extra_fee_per_500g: 5500 },
        { code: 'fast', name: 'Nhanh', eta: '1-2 ngày', base_fee: 60500, extra_fee_per_500g: 7000 },
      ],
    },
    {
      code: 'spx',
      name: 'SPX Express',
      isConnected: false,
      servicesConfig: [
        { code: 'standard', name: 'Chuẩn', eta: '2-3 ngày', base_fee: 39000, extra_fee_per_500g: 5000 },
      ],
    },
    {
      code: 'ghtk',
      name: 'GHTK',
      isConnected: false,
      servicesConfig: [
        { code: 'standard', name: 'Chuẩn', eta: '2-4 ngày', base_fee: 38000, extra_fee_per_500g: 4500 },
      ],
    },
    {
      code: 'viettel_post',
      name: 'Viettel Post',
      isConnected: false,
      servicesConfig: [
        { code: 'standard', name: 'Chuẩn', eta: '2-4 ngày', base_fee: 42000, extra_fee_per_500g: 5000 },
        { code: 'express_48h', name: 'Chuyển phát hỏa tốc (48 giờ)', eta: '48 giờ', base_fee: 180925, extra_fee_per_500g: 12000 },
      ],
    },
    {
      code: 'jt',
      name: 'J&T Express',
      isConnected: false,
      servicesConfig: [
        { code: 'standard', name: 'Chuẩn', eta: '2-4 ngày', base_fee: 58432, extra_fee_per_500g: 6000 },
      ],
    },
  ];
  for (const c of carriers) {
    await prisma.shippingProvider.upsert({
      where: { code: c.code },
      update: { name: c.name, servicesConfig: c.servicesConfig },
      create: {
        code: c.code,
        name: c.name,
        type: 'tich_hop',
        isConnected: c.isConnected,
        servicesConfig: c.servicesConfig,
      },
    });
  }
  await prisma.shippingProvider.upsert({
    where: { code: 'PARTNER0001' },
    update: {},
    create: {
      code: 'PARTNER0001',
      name: 'Đối tác giao hàng nội thành',
      type: 'tu_lien_he',
      phone: '0901234567',
    },
  });
  console.log('✓ shipping providers');

  // 2. Địa chỉ chi nhánh (chỉ điền khi đang trống)
  const branches = await prisma.location.findMany();
  for (const b of branches) {
    if (!b.address1) {
      await prisma.location.update({
        where: { id: b.id },
        data: {
          phone: b.phone ?? '0243 123 4567',
          province: 'Hà Nội',
          district: 'Quận Cầu Giấy',
          ward: 'Phường Dịch Vọng',
          address1: 'Số 1 Trần Thái Tông',
        },
      });
    }
  }
  console.log('✓ branch addresses:', branches.map((b) => b.code).join(', '));

  // 3. Sync permission catalog + role permissions (giống seedRbac)
  for (const p of PERMISSION_CATALOG) {
    await prisma.permission.upsert({
      where: { key: p.key },
      update: { group: p.group, label: p.label, scope: p.scope },
      create: p,
    });
  }
  const allPerms = await prisma.permission.findMany();
  const permByKey = new Map(allPerms.map((p) => [p.key, p.id]));
  for (const [code, def] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
    const role = await prisma.role.findUnique({ where: { code } });
    if (!role) continue;
    const keys =
      def.permissions === '*' ? allPerms.map((p) => p.key) : def.permissions;
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    await prisma.rolePermission.createMany({
      data: keys
        .map((k) => permByKey.get(k))
        .filter((id): id is bigint => id !== undefined)
        .map((permissionId) => ({ roleId: role.id, permissionId })),
      skipDuplicates: true,
    });
  }
  console.log('✓ permissions synced');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
