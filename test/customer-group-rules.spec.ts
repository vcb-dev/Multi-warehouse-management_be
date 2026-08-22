import { BadRequestException } from '@nestjs/common';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  buildCustomerGroupWhere,
  parseRules,
  ruleCatalog,
} from '../src/modules/customers/customer-group-rules';

/** Chỉ `birthday_month` mới chạm tới prisma (raw SQL), còn lại thuần logic. */
const noPrisma = null as unknown as PrismaService;

const build = (
  rules: { column: string; relation: string; condition?: string }[],
  disjunctive = false,
  prisma: PrismaService = noPrisma,
) => buildCustomerGroupWhere(prisma, rules, disjunctive);

describe('customer-group-rules — dịch điều kiện sang Prisma where', () => {
  it('ghép nhiều điều kiện bằng AND khi disjunctive = false', async () => {
    const where = await build([
      { column: 'orders_count', relation: 'greater_than', condition: '2' },
      { column: 'state', relation: 'equals', condition: 'enabled' },
    ]);
    expect(where).toEqual({
      AND: [{ ordersCount: { gt: 2 } }, { state: 'enabled' }],
    });
  });

  it('ghép bằng OR khi disjunctive = true', async () => {
    const where = await build(
      [
        { column: 'orders_count', relation: 'greater_than', condition: '2' },
        {
          column: 'total_spent',
          relation: 'greater_than',
          condition: '1000000',
        },
      ],
      true,
    );
    expect(where).toEqual({
      OR: [{ ordersCount: { gt: 2 } }, { totalSpent: { gt: 1000000 } }],
    });
  });

  it('so sánh số: greater_than / less_than / equals', async () => {
    await expect(
      build([
        { column: 'total_spent', relation: 'less_than', condition: '500' },
      ]),
    ).resolves.toEqual({ AND: [{ totalSpent: { lt: 500 } }] });

    await expect(
      build([{ column: 'orders_count', relation: 'equals', condition: '0' }]),
    ).resolves.toEqual({ AND: [{ ordersCount: { equals: 0 } }] });
  });

  it('hỗ trợ *_or_equal — dạng Sapo dùng trong rule nhóm tự động', async () => {
    await expect(
      build([
        {
          column: 'orders_count',
          relation: 'greater_than_or_equal',
          condition: '2',
        },
      ]),
    ).resolves.toEqual({ AND: [{ ordersCount: { gte: 2 } }] });

    await expect(
      build([
        {
          column: 'total_spent',
          relation: 'less_than_or_equal',
          condition: '2000000',
        },
      ]),
    ).resolves.toEqual({ AND: [{ totalSpent: { lte: 2000000 } }] });
  });

  it('cột `address` của Sapo nhận JSON mã vùng', async () => {
    // Sapo mã hoá tỉnh bằng số: {"province":"1"} = Hà Nội, khớp province_code
    await expect(
      build([
        {
          column: 'address',
          relation: 'equals',
          condition: '{"province":"1"}',
        },
      ]),
    ).resolves.toEqual({
      AND: [{ addresses: { some: { provinceCode: '1' } } }],
    });

    // Nhiều mã trong một điều kiện phải cùng thoả trên một địa chỉ
    await expect(
      build([
        {
          column: 'address',
          relation: 'equals',
          condition: '{"province":"1","district":"12"}',
        },
      ]),
    ).resolves.toEqual({
      AND: [{ addresses: { some: { provinceCode: '1', districtCode: '12' } } }],
    });
  });

  it('cột `address` từ chối JSON hỏng hoặc khoá lạ', async () => {
    await expect(
      build([{ column: 'address', relation: 'equals', condition: 'Hà Nội' }]),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      build([
        {
          column: 'address',
          relation: 'equals',
          condition: '{"country":"VN"}',
        },
      ]),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('dựng được đúng bộ rule thật đang có trên Sapo của cửa hàng', async () => {
    // Sao chép nguyên văn từ GET /admin/customer_groups.json
    const real = [
      [{ column: 'accepts_marketing', relation: 'equals', condition: 'true' }],
      [
        {
          column: 'address',
          relation: 'equals',
          condition: '{"province":"1"}',
        },
      ],
      [{ column: 'total_spent', relation: 'less_than', condition: '2000000' }],
      [
        {
          column: 'orders_count',
          relation: 'greater_than_or_equal',
          condition: '2000000',
        },
        { column: 'orders_count', relation: 'less_than', condition: '5000000' },
      ],
      [
        {
          column: 'orders_count',
          relation: 'greater_than_or_equal',
          condition: '2',
        },
      ],
    ];
    for (const rules of real) {
      await expect(build(rules)).resolves.toBeDefined();
    }
  });

  it('text: contains không phân biệt hoa thường, not_contains bọc NOT', async () => {
    await expect(
      build([{ column: 'email', relation: 'contains', condition: 'gmail' }]),
    ).resolves.toEqual({
      AND: [{ email: { contains: 'gmail', mode: 'insensitive' } }],
    });

    // Khách chưa có email cũng phải tính là "không chứa gmail"
    await expect(
      build([
        { column: 'email', relation: 'not_contains', condition: 'gmail' },
      ]),
    ).resolves.toEqual({
      AND: [
        {
          OR: [
            { email: null },
            { NOT: { email: { contains: 'gmail', mode: 'insensitive' } } },
          ],
        },
      ],
    });
  });

  it('text: is_set loại cả NULL lẫn chuỗi rỗng', async () => {
    await expect(
      build([{ column: 'phone', relation: 'is_set' }]),
    ).resolves.toEqual({
      AND: [
        { AND: [{ phone: { not: null } }, { NOT: { phone: { equals: '' } } }] },
      ],
    });

    await expect(
      build([{ column: 'phone', relation: 'is_not_set' }]),
    ).resolves.toEqual({
      AND: [{ OR: [{ phone: null }, { phone: { equals: '' } }] }],
    });
  });

  it('tags dùng `has` / `isEmpty` của mảng Postgres', async () => {
    await expect(
      build([{ column: 'tags', relation: 'contains', condition: 'vip' }]),
    ).resolves.toEqual({ AND: [{ tags: { has: 'vip' } }] });

    await expect(
      build([{ column: 'tags', relation: 'is_not_set' }]),
    ).resolves.toEqual({ AND: [{ tags: { isEmpty: true } }] });
  });

  it('địa chỉ lọc qua quan hệ addresses.some', async () => {
    await expect(
      build([{ column: 'province', relation: 'equals', condition: 'Hà Nội' }]),
    ).resolves.toEqual({
      AND: [
        {
          addresses: {
            some: { province: { equals: 'Hà Nội', mode: 'insensitive' } },
          },
        },
      ],
    });
  });

  it('"khác" trên cột cho phép NULL phải gộp cả khách chưa điền', async () => {
    // gender nullable — "khác Nam" phải lấy cả khách chưa chọn giới tính
    await expect(
      build([{ column: 'gender', relation: 'not_equals', condition: 'male' }]),
    ).resolves.toEqual({
      AND: [{ OR: [{ gender: null }, { NOT: { gender: 'male' } }] }],
    });

    // state không nullable — không cần nhánh NULL
    await expect(
      build([
        { column: 'state', relation: 'not_equals', condition: 'enabled' },
      ]),
    ).resolves.toEqual({ AND: [{ NOT: { state: 'enabled' } }] });
  });

  it('accepts_marketing nhận chuỗi "true"/"false"', async () => {
    await expect(
      build([
        { column: 'accepts_marketing', relation: 'equals', condition: 'true' },
      ]),
    ).resolves.toEqual({ AND: [{ acceptsMarketing: true }] });

    await expect(
      build([
        { column: 'accepts_marketing', relation: 'equals', condition: 'false' },
      ]),
    ).resolves.toEqual({ AND: [{ acceptsMarketing: false }] });
  });

  it('birthday_month rút id bằng raw SQL rồi lọc theo id', async () => {
    const $queryRaw = jest.fn().mockResolvedValue([{ id: 7n }, { id: 9n }]);
    const where = await build(
      [{ column: 'birthday_month', relation: 'equals', condition: '3' }],
      false,
      { $queryRaw } as unknown as PrismaService,
    );
    expect($queryRaw).toHaveBeenCalledTimes(1);
    expect(where).toEqual({ AND: [{ id: { in: [7n, 9n] } }] });
  });
});

describe('customer-group-rules — chặn điều kiện sai', () => {
  it('không có điều kiện nào', async () => {
    // Nhóm tự động rỗng sẽ khớp toàn bộ khách hàng, phải chặn.
    await expect(build([])).rejects.toBeInstanceOf(BadRequestException);
  });

  it('cột không tồn tại', async () => {
    await expect(
      build([
        { column: 'khong_co_cot_nay', relation: 'equals', condition: 'x' },
      ]),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('phép so sánh không hợp lệ cho cột đó', async () => {
    // total_spent là số — không có "contains"
    await expect(
      build([{ column: 'total_spent', relation: 'contains', condition: '5' }]),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('thiếu giá trị ở relation cần giá trị', async () => {
    await expect(
      build([{ column: 'email', relation: 'contains', condition: '   ' }]),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('giá trị số không hợp lệ', async () => {
    await expect(
      build([{ column: 'orders_count', relation: 'equals', condition: 'abc' }]),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('tháng sinh nhật ngoài 1–12', async () => {
    await expect(
      build([
        { column: 'birthday_month', relation: 'equals', condition: '13' },
      ]),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('ngày tạo không parse được', async () => {
    await expect(
      build([
        {
          column: 'created_on',
          relation: 'greater_than',
          condition: 'hôm qua',
        },
      ]),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('customer-group-rules — parseRules & catalog', () => {
  it('parseRules bỏ qua dòng hỏng, giữ dòng hợp lệ', () => {
    expect(
      parseRules([
        { column: 'tags', relation: 'contains', condition: 'vip' },
        null,
        'rác',
        { column: 'tags' },
        { relation: 'equals' },
      ]),
    ).toEqual([{ column: 'tags', relation: 'contains', condition: 'vip' }]);
  });

  it('parseRules trả mảng rỗng khi cột rules là NULL', () => {
    expect(parseRules(null)).toEqual([]);
    expect(parseRules(undefined)).toEqual([]);
    expect(parseRules({})).toEqual([]);
  });

  it('catalog khai báo đủ nhãn và cờ needs_value cho builder', () => {
    const catalog = ruleCatalog();
    expect(catalog.length).toBeGreaterThan(0);

    for (const col of catalog) {
      expect(col.label).toBeTruthy();
      expect(col.relations.length).toBeGreaterThan(0);
      for (const rel of col.relations) expect(rel.label).toBeTruthy();
    }

    const phone = catalog.find((c) => c.value === 'phone');
    expect(
      phone?.relations.find((r) => r.value === 'is_set')?.needs_value,
    ).toBe(false);
    expect(
      phone?.relations.find((r) => r.value === 'contains')?.needs_value,
    ).toBe(true);

    // Cột kiểu select phải kèm danh sách lựa chọn để builder dựng dropdown
    const gender = catalog.find((c) => c.value === 'gender');
    expect(gender?.input).toBe('select');
    expect(gender?.choices?.length).toBe(3);
  });

  it('mọi relation khai báo trong catalog đều dựng được where', async () => {
    const sampleValue: Record<string, string> = {
      birthday_month: '3',
      created_on: '2026-01-01',
      accepts_marketing: 'true',
      address: '{"province":"1"}',
    };
    const $queryRaw = jest.fn().mockResolvedValue([]);
    const prisma = { $queryRaw } as unknown as PrismaService;

    for (const col of ruleCatalog()) {
      for (const rel of col.relations) {
        const condition = rel.needs_value
          ? (sampleValue[col.value] ?? col.choices?.[0]?.value ?? '1')
          : undefined;
        await expect(
          build(
            [{ column: col.value, relation: rel.value, condition }],
            false,
            prisma,
          ),
        ).resolves.toBeDefined();
      }
    }
  });
});
