import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Điều kiện của nhóm khách hàng tự động — giữ đúng dạng rule của Sapo:
 * `{column, relation, condition}` + cờ `disjunctive` (true = OR, false = AND).
 * Mỗi cột khai báo sẵn tập `relation` hợp lệ và cách dịch sang Prisma `where`,
 * nên thêm điều kiện mới chỉ cần thêm một entry vào `RULE_COLUMNS`.
 */

export type CustomerGroupRule = {
  column: string;
  relation: string;
  condition?: string | null;
};

export type RuleRelation =
  | 'equals'
  | 'not_equals'
  | 'greater_than'
  | 'greater_than_or_equal'
  | 'less_than'
  | 'less_than_or_equal'
  | 'contains'
  | 'not_contains'
  | 'is_set'
  | 'is_not_set';

/** Kiểu ô nhập giá trị mà builder bên frontend cần dựng */
type RuleInput = 'text' | 'number' | 'date' | 'select';

type BuildCtx = {
  relation: RuleRelation;
  condition: string;
  prisma: PrismaService;
};

type ColumnSpec = {
  label: string;
  input: RuleInput;
  relations: RuleRelation[];
  choices?: { value: string; label: string }[];
  /** Gợi ý hiển thị dưới ô giá trị */
  hint?: string;
  build: (
    ctx: BuildCtx,
  ) => Prisma.CustomerWhereInput | Promise<Prisma.CustomerWhereInput>;
};

/** Hai relation này không cần ô giá trị */
const VALUELESS: ReadonlySet<string> = new Set(['is_set', 'is_not_set']);

// --- Bộ dựng `where` dùng chung theo kiểu dữ liệu ---------------------------

type TextField = 'email' | 'phone' | 'company';

function textColumn(label: string, field: TextField): ColumnSpec {
  const on = (filter: Prisma.StringNullableFilter | null): Prisma.CustomerWhereInput =>
    ({ [field]: filter }) as Prisma.CustomerWhereInput;

  return {
    label,
    input: 'text',
    relations: ['contains', 'not_contains', 'equals', 'is_set', 'is_not_set'],
    build: ({ relation, condition }) => {
      switch (relation) {
        case 'equals':
          return on({ equals: condition, mode: 'insensitive' });
        case 'contains':
          return on({ contains: condition, mode: 'insensitive' });
        case 'not_contains':
          // Khách bỏ trống ô này cũng là "không chứa" — nếu chỉ bọc NOT thì
          // SQL trả NULL cho họ và loại họ ra khỏi nhóm.
          return {
            OR: [on(null), { NOT: on({ contains: condition, mode: 'insensitive' }) }],
          };
        case 'is_set':
          return { AND: [on({ not: null }), { NOT: on({ equals: '' }) }] };
        default: // is_not_set
          return { OR: [on(null), on({ equals: '' })] };
      }
    },
  };
}

type NumberField = 'totalSpent' | 'ordersCount';

function numberColumn(label: string, field: NumberField, hint?: string): ColumnSpec {
  return {
    label,
    input: 'number',
    // `*_or_equal` là dạng Sapo dùng trong rule của nhóm tự động.
    relations: [
      'greater_than',
      'greater_than_or_equal',
      'less_than',
      'less_than_or_equal',
      'equals',
    ],
    hint,
    build: ({ relation, condition }) => {
      const n = Number(condition);
      if (!Number.isFinite(n)) {
        throw new BadRequestException(`Giá trị của "${label}" phải là số`);
      }
      const filter =
        relation === 'greater_than'
          ? { gt: n }
          : relation === 'greater_than_or_equal'
            ? { gte: n }
            : relation === 'less_than'
              ? { lt: n }
              : relation === 'less_than_or_equal'
                ? { lte: n }
                : { equals: n };
      return { [field]: filter } as Prisma.CustomerWhereInput;
    },
  };
}

function selectColumn(
  label: string,
  field: 'state' | 'gender',
  choices: { value: string; label: string }[],
  nullable: boolean,
): ColumnSpec {
  return {
    label,
    input: 'select',
    relations: ['equals', 'not_equals'],
    choices,
    build: ({ relation, condition }) => {
      const eq = { [field]: condition } as Prisma.CustomerWhereInput;
      if (relation === 'equals') return eq;
      // "Khác X" phải gộp cả khách chưa điền (NULL), nếu không SQL sẽ loại họ ra.
      return nullable
        ? { OR: [{ [field]: null } as Prisma.CustomerWhereInput, { NOT: eq }] }
        : { NOT: eq };
    },
  };
}

type AddressField = 'province' | 'district' | 'ward';

/**
 * Lọc theo địa chỉ: khớp nếu **bất kỳ** địa chỉ nào của khách thoả — dễ dùng hơn
 * so với chỉ xét địa chỉ mặc định, vì khách hay có nhiều địa chỉ giao hàng.
 */
function addressColumn(label: string, field: AddressField): ColumnSpec {
  const some = (filter: Prisma.StringNullableFilter): Prisma.CustomerWhereInput => ({
    addresses: { some: { [field]: filter } as Prisma.CustomerAddressWhereInput },
  });

  return {
    label,
    input: 'text',
    relations: ['equals', 'contains', 'not_equals'],
    build: ({ relation, condition }) => {
      if (relation === 'contains') {
        return some({ contains: condition, mode: 'insensitive' });
      }
      const eq = some({ equals: condition, mode: 'insensitive' });
      return relation === 'not_equals' ? { NOT: eq } : eq;
    },
  };
}

// --- Danh mục cột ----------------------------------------------------------

const RULE_COLUMNS: Record<string, ColumnSpec> = {
  total_spent: numberColumn('Tổng chi tiêu', 'totalSpent', 'Đơn vị: đồng'),
  orders_count: numberColumn('Số đơn hàng', 'ordersCount'),

  state: selectColumn(
    'Trạng thái',
    'state',
    [
      { value: 'enabled', label: 'Đang hoạt động' },
      { value: 'disabled', label: 'Ngưng hoạt động' },
      { value: 'invited', label: 'Đã mời' },
    ],
    false,
  ),
  gender: selectColumn(
    'Giới tính',
    'gender',
    [
      { value: 'male', label: 'Nam' },
      { value: 'female', label: 'Nữ' },
      { value: 'other', label: 'Khác' },
    ],
    true,
  ),

  accepts_marketing: {
    label: 'Đồng ý nhận quảng cáo',
    input: 'select',
    relations: ['equals'],
    choices: [
      { value: 'true', label: 'Có' },
      { value: 'false', label: 'Không' },
    ],
    build: ({ condition }) => ({ acceptsMarketing: condition === 'true' }),
  },

  tags: {
    label: 'Nhãn',
    input: 'text',
    relations: ['contains', 'not_contains', 'is_set', 'is_not_set'],
    hint: 'Khớp trọn một nhãn, không khớp một phần',
    build: ({ relation, condition }) => {
      switch (relation) {
        case 'contains':
          return { tags: { has: condition } };
        case 'not_contains':
          return { NOT: { tags: { has: condition } } };
        case 'is_set':
          return { tags: { isEmpty: false } };
        default: // is_not_set
          return { tags: { isEmpty: true } };
      }
    },
  },

  email: textColumn('Email', 'email'),
  phone: textColumn('Số điện thoại', 'phone'),
  company: textColumn('Công ty', 'company'),

  province: addressColumn('Tỉnh/Thành phố', 'province'),
  district: addressColumn('Quận/Huyện', 'district'),
  ward: addressColumn('Phường/Xã', 'ward'),

  /**
   * Cột `address` của Sapo: điều kiện là chuỗi JSON chứa **mã** vùng, không phải
   * tên — VD `{"province":"1"}` nghĩa là province_code = "1" (Hà Nội).
   * Giữ đúng dạng này để rule đồng bộ từ Sapo chạy được và ghi ngược lại y nguyên.
   * Muốn lọc theo tên thì dùng các cột Tỉnh/Quận/Phường ở trên.
   */
  address: {
    label: 'Địa chỉ (mã vùng Sapo)',
    input: 'text',
    relations: ['equals'],
    hint: 'JSON mã vùng, VD {"province":"1"}',
    build: ({ condition }) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(condition);
      } catch {
        throw new BadRequestException(
          'Điều kiện "Địa chỉ" phải là JSON, VD {"province":"1"}',
        );
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new BadRequestException('Điều kiện "Địa chỉ" phải là một object JSON');
      }

      const byKey: Record<string, 'provinceCode' | 'districtCode' | 'wardCode'> = {
        province: 'provinceCode',
        district: 'districtCode',
        ward: 'wardCode',
      };
      const some: Prisma.CustomerAddressWhereInput = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        const field = byKey[key];
        if (!field) {
          throw new BadRequestException(
            `Điều kiện "Địa chỉ" không hỗ trợ khoá "${key}"`,
          );
        }
        (some as Record<string, unknown>)[field] = String(value);
      }
      if (!Object.keys(some).length) {
        throw new BadRequestException('Điều kiện "Địa chỉ" chưa có mã vùng nào');
      }
      // Cùng một địa chỉ phải thoả mọi mã đưa vào (tỉnh + quận + phường).
      return { addresses: { some } };
    },
  },

  created_on: {
    label: 'Ngày tạo',
    input: 'date',
    relations: [
      'greater_than',
      'greater_than_or_equal',
      'less_than',
      'less_than_or_equal',
    ],
    build: ({ relation, condition }) => {
      const d = new Date(condition);
      if (Number.isNaN(d.getTime())) {
        throw new BadRequestException('Ngày tạo không hợp lệ');
      }
      const filter =
        relation === 'less_than'
          ? { lt: d }
          : relation === 'less_than_or_equal'
            ? { lte: d }
            : relation === 'greater_than_or_equal'
              ? { gte: d }
              : { gt: d };
      return { createdOn: filter };
    },
  },

  birthday_month: {
    label: 'Tháng sinh nhật',
    input: 'number',
    relations: ['equals'],
    hint: 'Nhập 1–12',
    // Prisma không lọc được theo tháng của một cột ngày, nên rút danh sách id
    // bằng raw SQL rồi ghép lại như các chỗ tìm kiếm khác trong dự án.
    build: async ({ condition, prisma }) => {
      const m = Number(condition);
      if (!Number.isInteger(m) || m < 1 || m > 12) {
        throw new BadRequestException('Tháng sinh nhật phải là số từ 1 đến 12');
      }
      const rows = await prisma.$queryRaw<{ id: bigint }[]>`
        SELECT id FROM customers
        WHERE dob IS NOT NULL AND EXTRACT(MONTH FROM dob) = ${m}
      `;
      return { id: { in: rows.map((r) => r.id) } };
    },
  },
};

// --- Nhãn relation (đổi theo kiểu cột cho đúng tiếng Việt) -----------------

function relationLabel(relation: RuleRelation, input: RuleInput): string {
  if (input === 'date') {
    if (relation === 'greater_than') return 'Sau ngày';
    if (relation === 'greater_than_or_equal') return 'Từ ngày';
    if (relation === 'less_than') return 'Trước ngày';
    if (relation === 'less_than_or_equal') return 'Đến ngày';
  }
  switch (relation) {
    case 'equals':
      return 'Bằng';
    case 'not_equals':
      return 'Khác';
    case 'greater_than':
      return 'Lớn hơn';
    case 'greater_than_or_equal':
      return 'Lớn hơn hoặc bằng';
    case 'less_than':
      return 'Nhỏ hơn';
    case 'less_than_or_equal':
      return 'Nhỏ hơn hoặc bằng';
    case 'contains':
      return 'Chứa';
    case 'not_contains':
      return 'Không chứa';
    case 'is_set':
      return 'Đã có';
    case 'is_not_set':
      return 'Chưa có';
  }
}

/** Danh mục điều kiện cho builder ở frontend dựng dropdown */
export function ruleCatalog() {
  return Object.entries(RULE_COLUMNS).map(([value, spec]) => ({
    value,
    label: spec.label,
    input: spec.input,
    hint: spec.hint ?? null,
    choices: spec.choices ?? null,
    relations: spec.relations.map((r) => ({
      value: r,
      label: relationLabel(r, spec.input),
      /** false = relation này không cần ô giá trị */
      needs_value: !VALUELESS.has(r),
    })),
  }));
}

/** Đọc cột `rules` (Json) từ DB về mảng rule, bỏ qua dòng hỏng */
export function parseRules(raw: unknown): CustomerGroupRule[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (r): r is CustomerGroupRule =>
      !!r &&
      typeof r === 'object' &&
      typeof (r as CustomerGroupRule).column === 'string' &&
      typeof (r as CustomerGroupRule).relation === 'string',
  );
}

async function buildOne(
  prisma: PrismaService,
  rule: CustomerGroupRule,
): Promise<Prisma.CustomerWhereInput> {
  const spec = RULE_COLUMNS[rule.column];
  if (!spec) {
    throw new BadRequestException(`Không hỗ trợ điều kiện "${rule.column}"`);
  }
  if (!spec.relations.includes(rule.relation as RuleRelation)) {
    throw new BadRequestException(
      `Điều kiện "${spec.label}" không dùng được phép so sánh "${rule.relation}"`,
    );
  }
  const condition = rule.condition?.trim() ?? '';
  if (!VALUELESS.has(rule.relation) && !condition) {
    throw new BadRequestException(`Điều kiện "${spec.label}" chưa nhập giá trị`);
  }
  return spec.build({
    relation: rule.relation as RuleRelation,
    condition,
    prisma,
  });
}

/**
 * Dịch bộ rule thành một `where` của Prisma.
 * Ném lỗi khi không có rule nào — nhóm tự động rỗng sẽ khớp toàn bộ khách hàng.
 */
export async function buildCustomerGroupWhere(
  prisma: PrismaService,
  rules: CustomerGroupRule[],
  disjunctive: boolean,
): Promise<Prisma.CustomerWhereInput> {
  if (!rules.length) {
    throw new BadRequestException('Nhóm tự động phải có ít nhất một điều kiện');
  }
  const parts = await Promise.all(rules.map((r) => buildOne(prisma, r)));
  return disjunctive ? { OR: parts } : { AND: parts };
}
