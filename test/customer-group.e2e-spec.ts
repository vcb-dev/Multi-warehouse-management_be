/**
 * Nhóm khách hàng — integration thật trên Postgres.
 * Chạy: RUN_INTEGRATION_TESTS=1 npx jest test/customer-group.e2e-spec.ts
 *
 * Test tự tạo lấy khách + nhóm của mình rồi xoá sạch ở `afterAll`; không đụng
 * tới dữ liệu có sẵn. Mọi rule của nhóm tự động đều kẹp thêm nhãn đánh dấu
 * riêng của lần chạy, nếu không `recalculate` sẽ hút toàn bộ khách thật vào nhóm.
 */
import { ConflictException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { OrdersModule } from '../src/modules/orders/orders.module';
import { VouchersModule } from '../src/modules/vouchers/vouchers.module';
import { CustomerService } from '../src/modules/orders/customer.service';
import { CustomerGroupService } from '../src/modules/orders/customer-group.service';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';

// Mỗi thao tác là một round-trip tới Supabase (~0,3–2,5s), nên mặc định 5s của
// jest không đủ cho những test gọi nhiều lần.
jest.setTimeout(120000);

const describeIfDb =
  process.env.DATABASE_URL && process.env.RUN_INTEGRATION_TESTS === '1'
    ? describe
    : describe.skip;

describeIfDb('nhóm khách hàng (integration)', () => {
  let customers: CustomerService;
  let groups: CustomerGroupService;
  let prisma: PrismaService;

  /** Mọi thứ test tạo ra đều mang dấu này để dọn cho chính xác */
  const runId = `e2e${Date.now()}`;
  const MARKER = `marker-${runId}`;
  const VIP = `vip-${runId}`;

  const customerIds: bigint[] = [];
  const groupIds: bigint[] = [];

  let alice: bigint;
  let bao: bigint;
  let chi: bigint;
  let autoGroupId: bigint;
  let manualGroupId: bigint;

  async function newCustomer(name: string, tags: string[], phoneSuffix: string) {
    const res = await customers.create({
      first_name: name,
      phone: `0999${runId.slice(-6)}${phoneSuffix}`,
      tags: [MARKER, ...tags],
    });
    const id = BigInt(res.data.id);
    customerIds.push(id);
    return id;
  }

  async function memberIds(groupId: bigint) {
    const rows = await prisma.customerGroupMember.findMany({
      where: { customerGroupId: groupId },
      select: { customerId: true },
    });
    return rows.map((r) => r.customerId).sort();
  }

  const sorted = (ids: bigint[]) => [...ids].sort();

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [PrismaModule, VouchersModule, OrdersModule],
    }).compile();

    customers = module.get(CustomerService);
    groups = module.get(CustomerGroupService);
    prisma = module.get(PrismaService);

    alice = await newCustomer('Alice', [VIP], '01');
    bao = await newCustomer('Bảo', [VIP], '02');
    chi = await newCustomer('Chi', [], '03');
  });

  afterAll(async () => {
    // Nếu beforeAll chết trước khi có prisma thì chưa ghi gì — đừng ném lỗi
    // dọn dẹp che mất nguyên nhân thật.
    if (!prisma) return;
    // Xoá theo id đã ghi lại, kèm lưới an toàn theo nhãn/mã của lần chạy này.
    await prisma.customerGroupMember.deleteMany({
      where: {
        OR: [
          { customerId: { in: customerIds } },
          { customerGroupId: { in: groupIds } },
        ],
      },
    });
    await prisma.customerAddress.deleteMany({
      where: { customerId: { in: customerIds } },
    });
    await prisma.customer.deleteMany({
      where: { OR: [{ id: { in: customerIds } }, { tags: { has: MARKER } }] },
    });
    await prisma.customerGroup.deleteMany({
      where: { OR: [{ id: { in: groupIds } }, { code: { startsWith: runId } }] },
    });
    await prisma.$disconnect();
  });

  it('dọn sạch: không còn dấu vết của lần chạy sau afterAll', async () => {
    // Chốt chặn để nếu cleanup hỏng thì lộ ra ngay ở lần chạy sau.
    expect(
      await prisma.customer.count({ where: { tags: { has: MARKER } } }),
    ).toBe(customerIds.length);
  });

  it('nhóm tự động gom đúng khách khớp điều kiện ngay khi tạo', async () => {
    const res = await groups.create({
      name: `Nhóm VIP ${runId}`,
      code: `${runId}-auto`,
      type: 'auto',
      disjunctive: false,
      rules: [
        { column: 'tags', relation: 'contains', condition: MARKER },
        { column: 'tags', relation: 'contains', condition: VIP },
      ],
    });
    autoGroupId = BigInt(res.data.id);
    groupIds.push(autoGroupId);

    expect(res.data.type).toBe('auto');
    expect(await memberIds(autoGroupId)).toEqual(sorted([alice, bao]));
    // Chi không có nhãn VIP nên phải nằm ngoài
    expect(await memberIds(autoGroupId)).not.toContain(chi);
    expect(res.data.customers_count).toBe(2);
  });

  it('recalculate không đổi gì khi dữ liệu chưa đổi (idempotent)', async () => {
    const again = await groups.recalculate(autoGroupId);
    expect(again).toEqual({ total: 2, added: 0, removed: 0 });
  });

  it('recalculate giữ nguyên ngày vào nhóm của thành viên còn khớp', async () => {
    const before = await prisma.customerGroupMember.findUniqueOrThrow({
      where: {
        customerId_customerGroupId: {
          customerId: alice,
          customerGroupId: autoGroupId,
        },
      },
    });
    await groups.recalculate(autoGroupId);
    const after = await prisma.customerGroupMember.findUniqueOrThrow({
      where: {
        customerId_customerGroupId: {
          customerId: alice,
          customerGroupId: autoGroupId,
        },
      },
    });
    expect(after.createdOn.getTime()).toBe(before.createdOn.getTime());
  });

  it('sửa khách làm khách tự vào / tự rời nhóm tự động', async () => {
    // Chi được gắn nhãn VIP -> phải tự vào nhóm mà không cần bấm Tính lại
    await customers.update(chi, { tags: [MARKER, VIP] });
    expect(await memberIds(autoGroupId)).toEqual(sorted([alice, bao, chi]));

    // Gỡ nhãn VIP của Bảo -> phải tự rời nhóm
    await customers.update(bao, { tags: [MARKER] });
    expect(await memberIds(autoGroupId)).toEqual(sorted([alice, chi]));

    // Trả lại trạng thái ban đầu cho các test sau
    await customers.update(bao, { tags: [MARKER, VIP] });
    await customers.update(chi, { tags: [MARKER] });
    expect(await memberIds(autoGroupId)).toEqual(sorted([alice, bao]));
  });

  it('customers_count luôn khớp số thành viên thật', async () => {
    const g = await prisma.customerGroup.findUniqueOrThrow({
      where: { id: autoGroupId },
    });
    expect(g.customersCount).toBe((await memberIds(autoGroupId)).length);
  });

  it('chặn thêm / gỡ tay trên nhóm tự động', async () => {
    // So với chính danh sách trước đó, không chốt cứng thành viên — test này
    // chỉ khẳng định "hai lời gọi bị chặn thì không đổi gì".
    const before = await memberIds(autoGroupId);

    await expect(
      groups.addMembers(autoGroupId, [chi.toString()]),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(groups.removeMember(autoGroupId, alice)).rejects.toBeInstanceOf(
      ConflictException,
    );

    expect(await memberIds(autoGroupId)).toEqual(before);
  });

  it('nhóm thủ công: thêm, bỏ qua trùng, gỡ — và đồng bộ số đếm', async () => {
    const res = await groups.create({
      name: `Nhóm tay ${runId}`,
      code: `${runId}-manual`,
      type: 'manual',
    });
    manualGroupId = BigInt(res.data.id);
    groupIds.push(manualGroupId);

    const added = await groups.addMembers(manualGroupId, [
      alice.toString(),
      chi.toString(),
    ]);
    expect(added).toEqual({ added: 2, skipped: 0, total: 2 });

    // Thêm lại Alice: phải bỏ qua, không nhân đôi
    const dup = await groups.addMembers(manualGroupId, [
      alice.toString(),
      bao.toString(),
    ]);
    expect(dup).toEqual({ added: 1, skipped: 1, total: 3 });

    const removed = await groups.removeMember(manualGroupId, chi);
    expect(removed.total).toBe(2);

    const stored = await prisma.customerGroup.findUniqueOrThrow({
      where: { id: manualGroupId },
    });
    expect(stored.customersCount).toBe(2);
  });

  it('sửa khách KHÔNG xoá tư cách thành viên nhóm tự động', async () => {
    // Đây là lỗi của bản cũ: update ghi đè sạch mọi nhóm của khách, nên nhóm
    // tự động mất thành viên mỗi lần ai đó bấm Lưu ở màn khách hàng.
    expect(await memberIds(autoGroupId)).toContain(alice);

    await customers.update(alice, {
      customer_group_ids: [manualGroupId.toString()],
    });

    const after = await customers.findOne(alice);
    const ids = after.data.customer_groups.map((g) => g.id);
    expect(ids).toContain(autoGroupId.toString());
    expect(ids).toContain(manualGroupId.toString());
  });

  it('không gán tay được vào nhóm tự động qua form khách hàng', async () => {
    await customers.update(chi, {
      customer_group_ids: [autoGroupId.toString(), manualGroupId.toString()],
    });
    const after = await customers.findOne(chi);
    const ids = after.data.customer_groups.map((g) => g.id);
    // Chi không khớp điều kiện nên vẫn ngoài nhóm tự động, dù gửi id lên
    expect(ids).not.toContain(autoGroupId.toString());
    expect(ids).toContain(manualGroupId.toString());
  });

  it('preview đếm đúng mà không ghi gì vào DB', async () => {
    const membersBefore = await prisma.customerGroupMember.count();
    const res = await groups.preview({
      disjunctive: false,
      rules: [
        { column: 'tags', relation: 'contains', condition: MARKER },
        { column: 'tags', relation: 'contains', condition: VIP },
      ],
    });
    expect(res.total).toBe(2);
    expect(await prisma.customerGroupMember.count()).toBe(membersBefore);
  });

  it('preview với OR rộng hơn AND', async () => {
    const or = await groups.preview({
      disjunctive: true,
      rules: [
        { column: 'tags', relation: 'contains', condition: VIP },
        { column: 'tags', relation: 'contains', condition: MARKER },
      ],
    });
    expect(or.total).toBe(3);
  });

  it('nhóm tự động không có điều kiện bị từ chối', async () => {
    await expect(
      groups.create({ name: `Rỗng ${runId}`, code: `${runId}-empty`, type: 'auto', rules: [] }),
    ).rejects.toThrow();
    // Không được để lại nhóm hỏng trong DB
    expect(
      await prisma.customerGroup.count({ where: { code: `${runId}-empty` } }),
    ).toBe(0);
  });

  it('chuyển auto -> thủ công: giữ thành viên VÀ giữ điều kiện để bật lại', async () => {
    const before = await memberIds(autoGroupId);
    const rulesBefore = (await groups.findOne(autoGroupId)).data.rules;
    expect(rulesBefore.length).toBe(2);

    const res = await groups.update(autoGroupId, { type: 'manual' });

    expect(res.data.type).toBe('manual');
    // Chuyển thủ công là tạm ngưng áp dụng, không phải xoá điều kiện — nhóm
    // đồng bộ từ Sapo phải giữ được rule gốc trong lúc bị khoá.
    expect(res.data.rules).toEqual(rulesBefore);
    expect(await memberIds(autoGroupId)).toEqual(before);

    // Giờ là nhóm thủ công nên sửa tay được
    await expect(groups.removeMember(autoGroupId, alice)).resolves.toMatchObject({
      removed: true,
    });
  });
});
