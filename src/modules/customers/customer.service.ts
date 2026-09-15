import { Injectable, NotFoundException } from '@nestjs/common';
import { NotificationTopic, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { userDisplayName } from '../../common/utils/user-display-name';
import { NotificationService } from '../notifications/notification.service';
import { findCustomerIdsByQuery } from '../../common/search/unaccent-search';
import { findRepeatCustomerIds } from '../../common/search/repeat-customer-search';
import { BusinessException } from '../../common/exceptions/business.exception';
import { CustomerGroupService } from './customer-group.service';
import {
  canMatchAddress,
  canMatchName,
  compareDuplicates,
  isSameAddress,
  nameKey,
  phoneKey,
  placeKey,
  type DuplicateReason,
} from './customer-duplicates';
import {
  CreateCustomerDto,
  CustomerAddressDto,
  CustomerDuplicateQueryDto,
  ListCustomersQueryDto,
  UpdateCustomerDto,
} from './customer.dto';

type CustomerWithRelations = Prisma.CustomerGetPayload<{
  include: { addresses: true; groups: { include: { group: true } } };
}>;

type MatchedAddressRow = {
  id: bigint;
  customer_id: bigint;
  address1: string | null;
  ward: string | null;
  district: string | null;
  province: string | null;
};

/** Giao các mảng id — dùng khi nhiều filter (q, repeat_only) cùng thu hẹp theo id */
function intersectBigintArrays(lists: bigint[][]): bigint[] {
  if (!lists.length) return [];
  return lists.reduce((acc, cur) => {
    const set = new Set(cur);
    return acc.filter((id) => set.has(id));
  });
}

function serializeAddress(a: CustomerWithRelations['addresses'][number]) {
  return {
    id: a.id.toString(),
    first_name: a.firstName,
    last_name: a.lastName,
    phone: a.phone,
    company: a.company,
    address1: a.address1,
    address2: a.address2,
    ward: a.ward,
    ward_code: a.wardCode,
    district: a.district,
    district_code: a.districtCode,
    province: a.province,
    province_code: a.provinceCode,
    city: a.city,
    country: a.country,
    country_code: a.countryCode,
    zip: a.zip,
    default: a.isDefault,
  };
}

@Injectable()
export class CustomerService {
  constructor(
    private prisma: PrismaService,
    private groups: CustomerGroupService,
    private notifications: NotificationService,
  ) {}

  private addressData(a: CustomerAddressDto) {
    return {
      firstName: a.first_name?.trim() || null,
      lastName: a.last_name?.trim() || null,
      phone: a.phone?.trim() || null,
      company: a.company?.trim() || null,
      address1: a.address1?.trim() || null,
      address2: a.address2?.trim() || null,
      ward: a.ward?.trim() || null,
      wardCode: a.ward_code?.trim() || null,
      district: a.district?.trim() || null,
      districtCode: a.district_code?.trim() || null,
      province: a.province?.trim() || null,
      provinceCode: a.province_code?.trim() || null,
      city: a.city?.trim() || null,
      country: a.country?.trim() || null,
      countryCode: a.country_code?.trim() || null,
      zip: a.zip?.trim() || null,
      isDefault: !!a.default,
    };
  }

  /** Chỉ một địa chỉ được là mặc định; nếu client không chọn thì lấy địa chỉ đầu. */
  private normalizeDefault(list: CustomerAddressDto[]) {
    const rows = list.map((a) => this.addressData(a));
    const firstDefault = rows.findIndex((r) => r.isDefault);
    return rows.map((r, i) => ({
      ...r,
      isDefault: firstDefault >= 0 ? i === firstDefault : i === 0,
    }));
  }

  serialize(c: CustomerWithRelations) {
    return {
      id: c.id.toString(),
      sapo_id: c.sapoId?.toString() ?? null,
      first_name: c.firstName,
      last_name: c.lastName,
      name: [c.firstName, c.lastName].filter(Boolean).join(' ') || null,
      email: c.email,
      phone: c.phone,
      company: c.company,
      state: c.state,
      verified_email: c.verifiedEmail,
      gender: c.gender,
      dob: c.dob?.toISOString() ?? null,
      accepts_marketing: c.acceptsMarketing,
      orders_count: c.ordersCount,
      total_spent: Number(c.totalSpent),
      last_order_id: c.lastOrderId?.toString() ?? null,
      last_order_name: c.lastOrderName,
      note: c.note,
      tags: c.tags,
      created_on: c.createdOn.toISOString(),
      modified_on: c.modifiedOn.toISOString(),
      addresses: c.addresses.map(serializeAddress),
      default_address: (() => {
        const d = c.addresses.find((a) => a.isDefault);
        return d ? serializeAddress(d) : null;
      })(),
      customer_groups: c.groups.map((m) => ({
        id: m.group.id.toString(),
        sapo_id: m.group.sapoId?.toString() ?? null,
        code: m.group.code,
        name: m.group.name,
        type: m.group.type,
      })),
    };
  }

  /**
   * Chỉ ghi đè thành viên của các nhóm **thủ công**: nhóm tự động do điều kiện
   * quyết định, xoá ở đây rồi `syncCustomerAutoGroups` lại thêm vào ngay.
   */
  private async replaceManualGroups(
    tx: Prisma.TransactionClient,
    customerId: bigint,
    groupIds: string[],
  ) {
    const manual = await tx.customerGroup.findMany({
      where: { type: 'manual' },
      select: { id: true },
    });
    const manualIds = new Set(manual.map((g) => g.id));

    await tx.customerGroupMember.deleteMany({
      where: { customerId, customerGroupId: { in: [...manualIds] } },
    });

    const wanted = groupIds
      .map((gid) => BigInt(gid))
      .filter((gid) => manualIds.has(gid));
    if (wanted.length) {
      await tx.customerGroupMember.createMany({
        data: wanted.map((gid) => ({ customerId, customerGroupId: gid })),
        skipDuplicates: true,
      });
    }
    return [...manualIds];
  }

  /** Ghi lại `customers_count` cho các nhóm vừa bị đổi thành viên */
  private async syncGroupCounts(groupIds: bigint[]) {
    for (const gid of groupIds) {
      const total = await this.prisma.customerGroupMember.count({
        where: { customerGroupId: gid },
      });
      await this.prisma.customerGroup.update({
        where: { id: gid },
        data: { customersCount: total },
      });
    }
  }

  async list(query: ListCustomersQueryDto) {
    const page = Math.max(query.page ?? 1, 1);
    const limit = Math.min(query.limit ?? 20, 100);
    const where: Prisma.CustomerWhereInput = {};

    if (
      query.min_spent != null &&
      query.max_spent != null &&
      query.min_spent > query.max_spent
    ) {
      throw new BusinessException(
        'BAD_REQUEST',
        'min_spent không được lớn hơn max_spent',
        400,
      );
    }
    if (
      query.min_age != null &&
      query.max_age != null &&
      query.min_age > query.max_age
    ) {
      throw new BusinessException(
        'BAD_REQUEST',
        'min_age không được lớn hơn max_age',
        400,
      );
    }

    const idFilters: bigint[][] = [];
    if (query.q?.trim()) {
      idFilters.push(await findCustomerIdsByQuery(this.prisma, query.q.trim()));
    }
    if (query.repeat_only) {
      idFilters.push(await findRepeatCustomerIds(this.prisma));
    }
    if (idFilters.length) where.id = { in: intersectBigintArrays(idFilters) };

    if (query.state) where.state = query.state;
    if (query.gender) where.gender = query.gender;
    if (query.customer_group_id) {
      where.groups = {
        some: { customerGroupId: BigInt(query.customer_group_id) },
      };
    }
    if (query.order_filter === 'has_order') where.ordersCount = { gt: 0 };
    if (query.order_filter === 'no_order') where.ordersCount = 0;

    if (query.province?.trim()) {
      where.addresses = {
        some: {
          isDefault: true,
          province: { contains: query.province.trim(), mode: 'insensitive' },
        },
      };
    }
    if (query.min_spent != null || query.max_spent != null) {
      where.totalSpent = {
        ...(query.min_spent != null ? { gte: query.min_spent } : {}),
        ...(query.max_spent != null ? { lte: query.max_spent } : {}),
      };
    }
    if (query.min_age != null || query.max_age != null) {
      const dobFilter: Prisma.DateTimeFilter = {};
      if (query.min_age != null) {
        const cutoff = new Date();
        cutoff.setHours(0, 0, 0, 0);
        cutoff.setFullYear(cutoff.getFullYear() - query.min_age);
        dobFilter.lte = cutoff;
      }
      if (query.max_age != null) {
        const cutoff = new Date();
        cutoff.setHours(0, 0, 0, 0);
        cutoff.setFullYear(cutoff.getFullYear() - query.max_age - 1);
        dobFilter.gt = cutoff;
      }
      where.dob = dobFilter;
    }
    if (query.product_category_id) {
      where.orders = {
        some: {
          items: {
            some: {
              variant: {
                product: {
                  categories: {
                    some: { categoryId: BigInt(query.product_category_id) },
                  },
                },
              },
            },
          },
        },
      };
    }

    const orderBy: Prisma.CustomerOrderByWithRelationInput =
      query.sort === 'total_spent'
        ? { totalSpent: 'desc' }
        : query.sort === 'orders_count'
          ? { ordersCount: 'desc' }
          : { createdOn: 'desc' };

    const [rows, total] = await Promise.all([
      this.prisma.customer.findMany({
        where,
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
        include: { addresses: true, groups: { include: { group: true } } },
      }),
      this.prisma.customer.count({ where }),
    ]);

    return {
      data: rows.map((c) => this.serialize(c)),
      total,
      page,
      limit,
      total_pages: Math.ceil(total / limit),
    };
  }

  async findOne(id: bigint) {
    const c = await this.prisma.customer.findUnique({
      where: { id },
      include: {
        addresses: { orderBy: [{ isDefault: 'desc' }, { id: 'asc' }] },
        groups: { include: { group: true } },
      },
    });
    if (!c) throw new NotFoundException('Không tìm thấy khách hàng');
    return { data: this.serialize(c) };
  }

  /**
   * Khách có SĐT cùng khoá chuẩn hoá. Dữ liệu Sapo lưu `+84…` còn người nhập gõ
   * `0…`, nên so bằng chuỗi thô là lọt trùng. SQL chỉ lọc thô theo 9 số cuối,
   * `phoneKey` quyết định.
   */
  private async customersWithPhone(key: string) {
    const rows = await this.prisma.$queryRaw<{ id: bigint; phone: string }[]>`
      SELECT id, phone
      FROM customers
      WHERE regexp_replace(phone, '\\D', '', 'g') LIKE ${`%${key.slice(-9)}`}
    `;
    return rows.filter((r) => phoneKey(r.phone) === key).map((r) => r.id);
  }

  private async assertPhoneFree(phone: string | undefined, excludeId?: bigint) {
    const key = phoneKey(phone);
    if (!key) return;
    const ids = await this.customersWithPhone(key);
    if (ids.some((id) => id !== excludeId)) {
      throw new BusinessException(
        'PHONE_EXISTS',
        'Số điện thoại này đã thuộc về khách hàng khác',
        409,
      );
    }
  }

  /** Khách có tên trùng sau khi bỏ dấu và danh xưng. */
  private async customersWithName(key: string) {
    // Mẫu regex chỉ gồm [a-z0-9] và khoảng trắng (đã qua foldText) — không cần escape.
    const pattern = `\\m${key.split(' ').join('\\M.*\\m')}\\M`;
    const rows = await this.prisma.$queryRaw<
      { id: bigint; first_name: string | null; last_name: string | null }[]
    >`
      SELECT id, first_name, last_name
      FROM customers
      WHERE unaccent(concat_ws(' ', first_name, last_name)) ~* ${pattern}
      LIMIT 2000
    `;
    return rows
      .filter((r) => nameKey(r.first_name, r.last_name) === key)
      .map((r) => r.id);
  }

  /** Địa chỉ trùng — lọc thô theo tên phường/xã rồi mới so kỹ. */
  private async addressesMatching(input: CustomerDuplicateQueryDto) {
    const pattern = `\\m${placeKey(input.ward).split(' ').join('\\M.*\\m')}\\M`;
    const rows = await this.prisma.$queryRaw<MatchedAddressRow[]>`
      SELECT id, customer_id, address1, ward, district, province
      FROM customer_addresses
      WHERE address1 IS NOT NULL
        AND unaccent(ward) ~* ${pattern}
    `;
    return rows.filter((r) => isSameAddress(input, r));
  }

  /**
   * Khách đã có mà có thể chính là khách sắp tạo. Trùng SĐT là chắc chắn (tạo
   * sẽ bị chặn); trùng tên hoặc địa chỉ chỉ là cảnh báo để người dùng tự quyết.
   */
  async findDuplicates(query: CustomerDuplicateQueryDto) {
    const phone = phoneKey(query.phone);
    const name = nameKey(query.name);

    const [phoneIds, nameIds, addresses] = await Promise.all([
      phone.length >= 9 ? this.customersWithPhone(phone) : ([] as bigint[]),
      canMatchName(name) ? this.customersWithName(name) : ([] as bigint[]),
      canMatchAddress(query)
        ? this.addressesMatching(query)
        : ([] as MatchedAddressRow[]),
    ]);

    const reasons = new Map<bigint, Set<DuplicateReason>>();
    const mark = (id: bigint, reason: DuplicateReason) => {
      const set = reasons.get(id) ?? new Set<DuplicateReason>();
      set.add(reason);
      reasons.set(id, set);
    };
    phoneIds.forEach((id) => mark(id, 'phone'));
    nameIds.forEach((id) => mark(id, 'name'));
    addresses.forEach((a) => mark(a.customer_id, 'address'));
    if (!reasons.size) return { data: [] };

    const matchedAddressId = new Map(
      addresses.map((a) => [a.customer_id, a.id]),
    );
    const customers = await this.prisma.customer.findMany({
      where: { id: { in: [...reasons.keys()] } },
      include: {
        addresses: { orderBy: [{ isDefault: 'desc' }, { id: 'asc' }] },
      },
    });

    const data = customers.map((c) => {
      // Trùng địa chỉ thì hiện đúng địa chỉ trùng, không thì địa chỉ mặc định.
      const addr =
        c.addresses.find((a) => a.id === matchedAddressId.get(c.id)) ??
        c.addresses[0];
      return {
        id: c.id.toString(),
        name: [c.firstName, c.lastName].filter(Boolean).join(' ') || null,
        phone: c.phone,
        email: c.email,
        state: c.state,
        orders_count: c.ordersCount,
        total_spent: Number(c.totalSpent),
        address: addr
          ? [addr.address1, addr.ward, addr.district, addr.province]
              .filter(Boolean)
              .join(', ') || null
          : null,
        matched: [...(reasons.get(c.id) ?? [])],
      };
    });

    return { data: data.sort(compareDuplicates).slice(0, 10) };
  }

  async create(dto: CreateCustomerDto) {
    await this.assertPhoneFree(dto.phone);
    const created = await this.prisma.customer.create({
      data: {
        firstName: dto.first_name?.trim() || null,
        lastName: dto.last_name?.trim() || null,
        email: dto.email?.trim() || null,
        phone: dto.phone?.trim() || null,
        company: dto.company?.trim() || null,
        state: dto.state || 'enabled',
        gender: dto.gender || null,
        dob: dto.dob ? new Date(dto.dob) : null,
        acceptsMarketing: dto.accepts_marketing ?? false,
        verifiedEmail: dto.verified_email ?? false,
        note: dto.note?.trim() || null,
        tags: dto.tags ?? [],
        addresses: dto.addresses?.length
          ? { create: this.normalizeDefault(dto.addresses) }
          : undefined,
      },
    });

    if (dto.customer_group_ids?.length) {
      await this.replaceManualGroups(
        this.prisma,
        created.id,
        dto.customer_group_ids,
      );
    }
    await this.groups.syncCustomerAutoGroups(created.id);
    await this.syncGroupCounts(
      (dto.customer_group_ids ?? []).map((gid) => BigInt(gid)),
    );

    // Khách hàng không thuộc kho nào ⇒ locationId null: gửi cho mọi người có
    // `customer:view` ở bất kỳ kho nào.
    const name = userDisplayName(created) ?? created.phone ?? 'không tên';
    void this.notifications.emit(NotificationTopic.customers_create, {
      subjectType: 'customer',
      subjectId: created.id,
      locationId: null,
      title: `Khách hàng mới: ${name}`,
      payload: { name, phone: created.phone },
    });

    return this.findOne(created.id);
  }

  async update(id: bigint, dto: UpdateCustomerDto) {
    const existing = await this.prisma.customer.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Không tìm thấy khách hàng');
    // Chỉ kiểm khi SĐT thực sự đổi: dữ liệu sync cũ có sẵn cặp khách trùng số,
    // kiểm lại mỗi lần lưu thì không sửa được hồ sơ của họ nữa.
    if (
      dto.phone !== undefined &&
      phoneKey(dto.phone) !== phoneKey(existing.phone)
    ) {
      await this.assertPhoneFree(dto.phone, id);
    }

    let touchedGroups: bigint[] = [];

    await this.prisma.$transaction(async (tx) => {
      await tx.customer.update({
        where: { id },
        data: {
          firstName: dto.first_name?.trim() ?? undefined,
          lastName: dto.last_name?.trim() ?? undefined,
          email: dto.email?.trim() ?? undefined,
          phone: dto.phone?.trim() ?? undefined,
          company: dto.company?.trim() ?? undefined,
          state: dto.state ?? undefined,
          gender: dto.gender ?? undefined,
          dob:
            dto.dob !== undefined
              ? dto.dob
                ? new Date(dto.dob)
                : null
              : undefined,
          acceptsMarketing: dto.accepts_marketing ?? undefined,
          verifiedEmail: dto.verified_email ?? undefined,
          note: dto.note?.trim() ?? undefined,
          tags: dto.tags ?? undefined,
        },
      });

      // Địa chỉ và nhóm gửi lên là bộ đầy đủ — thay thế toàn bộ cho đơn giản,
      // tránh phải đồng bộ từng dòng thêm/sửa/xoá ở client.
      if (dto.addresses) {
        await tx.customerAddress.deleteMany({ where: { customerId: id } });
        if (dto.addresses.length) {
          await tx.customerAddress.createMany({
            data: this.normalizeDefault(dto.addresses).map((a) => ({
              ...a,
              customerId: id,
            })),
          });
        }
      }
      if (dto.customer_group_ids) {
        touchedGroups = await this.replaceManualGroups(
          tx,
          id,
          dto.customer_group_ids,
        );
      }
    });

    // Địa chỉ hoặc thông tin vừa đổi có thể làm khách rơi vào/ra nhóm tự động.
    await this.groups.syncCustomerAutoGroups(id);
    await this.syncGroupCounts(touchedGroups);

    return this.findOne(id);
  }

  /** Không xoá cứng khi khách đã có đơn — chỉ chuyển sang `disabled` như Sapo. */
  async remove(id: bigint) {
    const c = await this.prisma.customer.findUnique({
      where: { id },
      select: {
        id: true,
        ordersCount: true,
        _count: { select: { orders: true } },
      },
    });
    if (!c) throw new NotFoundException('Không tìm thấy khách hàng');

    if (c._count.orders > 0) {
      await this.prisma.customer.update({
        where: { id },
        data: { state: 'disabled' },
      });
      return { id: id.toString(), deleted: false, state: 'disabled' };
    }
    await this.prisma.customer.delete({ where: { id } });
    return { id: id.toString(), deleted: true };
  }
}
