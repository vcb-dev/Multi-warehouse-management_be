import { NotificationTopic, PrismaClient, UserRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  PERMISSION_CATALOG,
  DEFAULT_ROLE_PERMISSIONS,
} from '../src/modules/rbac/permission-catalog';

const prisma = new PrismaClient();

async function seedShippingProviders() {
  const carriers: {
    code: string;
    name: string;
    isConnected: boolean;
    servicesConfig: {
      code: string;
      name: string;
      eta: string;
      base_fee: number;
      extra_fee_per_500g: number;
    }[];
  }[] = [
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
}

/**
 * Cấu hình mặc định cho 8 topic thông báo. `update` cố tình để trống: chỉ tạo dòng
 * thiếu, KHÔNG ghi đè lựa chọn admin đã chỉnh ở /cau-hinh/thong-bao (seed hay bị chạy
 * lại sau mỗi lần deploy).
 */
async function seedNotificationSettings() {
  const defaults: {
    topic: NotificationTopic;
    recipientPermissions: string[];
  }[] = [
    { topic: 'orders_create', recipientPermissions: ['order:view'] },
    { topic: 'orders_paid', recipientPermissions: ['order:view'] },
    { topic: 'orders_cancelled', recipientPermissions: ['order:view'] },
    { topic: 'orders_fulfilled', recipientPermissions: ['order:view'] },
    { topic: 'fulfillments_create', recipientPermissions: ['order:pack'] },
    { topic: 'fulfillments_update', recipientPermissions: ['order:pack'] },
    { topic: 'refunds_create', recipientPermissions: ['order:view'] },
    { topic: 'customers_create', recipientPermissions: ['customer:view'] },
    // Cảnh báo tồn kho: "cần nhập" là việc mua hàng, "âm kho" là việc kho — khác người nhận.
    { topic: 'inventory_low_stock', recipientPermissions: ['purchasing:manage'] },
    { topic: 'inventory_negative', recipientPermissions: ['inventory:view'] },
  ];

  for (const d of defaults) {
    await prisma.notificationSetting.upsert({
      where: { topic: d.topic },
      update: {},
      create: d,
    });
  }
}

async function seedRbac() {
  for (const p of PERMISSION_CATALOG) {
    await prisma.permission.upsert({
      where: { key: p.key },
      update: { group: p.group, label: p.label, scope: p.scope },
      create: p,
    });
  }
  const allPerms = await prisma.permission.findMany();
  const permByKey = new Map(allPerms.map((p) => [p.key, p.id]));

  const roleByCode = new Map<string, bigint>();
  for (const [code, def] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
    const role = await prisma.role.upsert({
      where: { code },
      update: { name: def.name, isSystem: def.isSystem ?? false },
      create: { code, name: def.name, isSystem: def.isSystem ?? false },
    });
    roleByCode.set(code, role.id);

    const keys = def.permissions === '*' ? allPerms.map((p) => p.key) : def.permissions;
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    await prisma.rolePermission.createMany({
      data: keys
        .map((k) => permByKey.get(k))
        .filter((id): id is bigint => id !== undefined)
        .map((permissionId) => ({ roleId: role.id, permissionId })),
      skipDuplicates: true,
    });
  }
  return roleByCode;
}

async function main() {
  const passwordHash = await bcrypt.hash('password123', 10);

  // Sapo gộp chi nhánh và kho làm một `Location`, nên seed chỉ tạo location.
  // Trên DB thật, 16 location đã được migration seed sẵn từ /admin/locations.json;
  // phần dưới chỉ để DB trống (dev/test) vẫn chạy được.
  const locationSeed = {
    phone: '0243 123 4567',
    province: 'Hà Nội',
    district: 'Quận Cầu Giấy',
    ward: 'Phường Dịch Vọng',
    address1: 'Số 1 Trần Thái Tông',
    country: 'Vietnam',
    countryCode: 'VN',
  };
  const branch = await prisma.location.upsert({
    where: { code: 'CN-HN' },
    update: locationSeed,
    create: {
      code: 'CN-HN',
      name: 'Chi nhánh Hà Nội',
      defaultLocation: true,
      ...locationSeed,
    },
  });

  await seedShippingProviders();

  const warehouses = [branch];
  for (let i = 1; i <= 3; i++) {
    const code = `WH${String(i).padStart(2, '0')}`;
    const wh = await prisma.location.upsert({
      where: { code },
      update: {},
      create: { code, name: `Kho ${i}`, country: 'Vietnam', countryCode: 'VN' },
    });
    warehouses.push(wh);
  }

  const admin = await prisma.user.upsert({
    where: { email: 'admin@local.dev' },
    update: {},
    create: {
      email: 'admin@local.dev',
      passwordHash,
      firstName: 'Admin',
      roles: [UserRole.admin, UserRole.warehouse_staff, UserRole.purchasing, UserRole.store_manager],
    },
  });

  const sales = await prisma.user.upsert({
    where: { email: 'sales@local.dev' },
    update: {},
    create: {
      email: 'sales@local.dev',
      passwordHash,
      firstName: 'Nhân viên bán hàng',
      roles: [UserRole.sales, UserRole.store_manager],
    },
  });

  const staff = await prisma.user.upsert({
    where: { email: 'kho@local.dev' },
    update: {},
    create: {
      email: 'kho@local.dev',
      passwordHash,
      firstName: 'Nhân viên kho',
      roles: [UserRole.warehouse_staff],
    },
  });

  // Gán staff 4 kho đầu
  for (const wh of warehouses.slice(0, 4)) {
    await prisma.userLocation.upsert({
      where: {
        userId_locationId: { userId: staff.id, locationId: wh.id },
      },
      update: {},
      create: { userId: staff.id, locationId: wh.id },
    });
  }

  // RBAC động: seed permissions + roles, gán role theo kho cho user hiện có
  const roleByCode = await seedRbac();

  // Sau seedRbac vì recipientPermissions trỏ tới permission key vừa seed
  await seedNotificationSettings();
  const assignRole = async (userId: bigint, locationId: bigint, code: string) => {
    const roleId = roleByCode.get(code);
    if (!roleId) return;
    await prisma.userLocationRole.upsert({
      where: { userId_locationId: { userId, locationId } },
      update: { roleId },
      create: { userId, locationId, roleId },
    });
  };
  for (const wh of warehouses) {
    await assignRole(admin.id, wh.id, 'admin');
  }
  for (const wh of warehouses.slice(0, 4)) {
    await assignRole(staff.id, wh.id, 'warehouse_staff');
    await assignRole(sales.id, wh.id, 'sales');
  }

  const product = await prisma.product.upsert({
    where: { alias: 'sp-stub-1' },
    update: {},
    create: { name: 'Sản phẩm stub 1', alias: 'sp-stub-1' },
  });

  const variants = [];
  for (let i = 1; i <= 3; i++) {
    const sku = `STUB-SKU-${String(i).padStart(3, '0')}`;
    const v = await prisma.productVariant.upsert({
      where: { sku },
      update: {},
      create: {
        productId: product.id,
        sku,
        price: 100_000 * i,
        cost: 60_000 * i,
      },
    });
    variants.push(v);
  }

  console.log('Seed OK:', {
    location: branch.code,
    locations: warehouses.length,
    users: [admin.email, staff.email, sales.email],
    variants: variants.map((v) => v.sku),
  });

  const supplierSeeds = [
    {
      code: 'NCC0001',
      name: 'Công ty TNHH Thiết bị ABC',
      email: 'contact@abc.vn',
      phone: '0241234567',
      taxCode: '0101234567',
      tags: ['điện tử', 'ưu tiên'],
    },
    {
      code: 'NCC0002',
      name: 'Nhà phân phối XYZ',
      email: 'sales@xyz.vn',
      phone: '0287654321',
      taxCode: '0317654321',
      tags: ['thực phẩm'],
    },
  ];

  for (const s of supplierSeeds) {
    await prisma.supplier.upsert({
      where: { code: s.code },
      update: {},
      create: {
        code: s.code,
        name: s.name,
        email: s.email,
        phone: s.phone,
        taxCode: s.taxCode,
        tags: s.tags,
        country: 'Việt Nam',
        province: 'Hà Nội',
      },
    });
  }

  const customerGroups = [
    { code: 'CG-RETAIL', name: 'Khách lẻ' },
    { code: 'CG-VIP', name: 'Khách VIP' },
  ];
  for (const g of customerGroups) {
    await prisma.customerGroup.upsert({
      where: { code: g.code },
      update: {},
      create: g,
    });
  }

  await prisma.priceList.upsert({
    where: { code: 'CTL-DEFAULT' },
    update: {},
    create: {
      code: 'CTL-DEFAULT',
      name: 'Bảng giá mặc định chi nhánh',
      locationId: branch.id,
    },
  });

  const rootCategory = await prisma.category.upsert({
    where: { alias: 'tat-ca' },
    update: {},
    create: {
      name: 'Tất cả',
      alias: 'tat-ca',
      conditionType: 'manual',
    },
  });

  console.log('Seed OK extras:', {
    customerGroups: customerGroups.length,
    rootCategory: rootCategory.alias,
  });

  let customer = await prisma.customer.findFirst({
    where: { phone: '0901234567' },
  });
  if (!customer) {
    customer = await prisma.customer.create({
      data: {
        firstName: 'Nguyễn',
        lastName: 'An',
        phone: '0901234567',
        email: 'nguyen.an@example.com',
        tags: ['vip'],
      },
    });
  }

  const wh1 = warehouses[0];
  const v1 = variants[0];
  await prisma.inventoryLevel.upsert({
    where: {
      variantId_locationId: { variantId: v1.id, locationId: wh1.id },
    },
    update: { onHand: 10, available: 10 },
    create: {
      variantId: v1.id,
      locationId: wh1.id,
      onHand: 10,
      available: 10,
      price: v1.price,
      cost: v1.cost,
    },
  });

  await prisma.inventoryMovement.create({
    data: {
      variantId: v1.id,
      locationId: wh1.id,
      bucket: 'on_hand',
      change: 10,
      type: 'receipt',
      referenceType: 'seed',
      createdById: admin.id,
    },
  });

  console.log('Seed orders:', {
    customer: customer.phone,
    inventory: `${v1.sku}@${wh1.code}=10`,
  });

  const convSpecs = [
    {
      phone: '0901111222',
      name: 'Nguyễn Văn A',
      channel: 'facebook' as const,
      messages: [
        { senderType: 'customer', body: 'Shop ơi còn áo size M không?' },
        {
          senderType: 'staff',
          body: 'Dạ còn ạ, em gửi link đặt hàng cho anh.',
          createdById: sales.id,
        },
      ],
    },
    {
      phone: '0913333444',
      name: 'Trần Thị B',
      channel: 'zalo' as const,
      messages: [
        { senderType: 'customer', body: 'Cho em xin giá ship về Đà Nẵng' },
      ],
    },
  ];

  for (const spec of convSpecs) {
    const existing = await prisma.conversation.findFirst({
      where: { customerPhone: spec.phone },
    });
    if (existing) continue;

    await prisma.conversation.create({
      data: {
        channel: spec.channel,
        customerName: spec.name,
        customerPhone: spec.phone,
        assignedToId: sales.id,
        messages: {
          create: spec.messages.map((m) => ({
            senderType: m.senderType,
            body: m.body,
            createdById: 'createdById' in m ? m.createdById : undefined,
          })),
        },
      },
    });
  }

  const queueFile = path.join(__dirname, '..', 'data', 'channel-pending-orders.json');
  await fs.mkdir(path.dirname(queueFile), { recursive: true });
  await fs.writeFile(
    queueFile,
    JSON.stringify(
      [
        {
          external_id: 'demo-fb-queue-1',
          source: 'facebook',
          location_id: branch.id.toString(),
          customer_phone: '0909999888',
          customer_name: 'Khách Facebook queue',
          items: [
            {
              variant_id: v1.id.toString(),
              location_id: wh1.id.toString(),
              quantity: 1,
              price: Number(v1.price),
            },
          ],
        },
      ],
      null,
      2,
    ),
  );

  console.log('Seed conversations + channel queue OK');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
