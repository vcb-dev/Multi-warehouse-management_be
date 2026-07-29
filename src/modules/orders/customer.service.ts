import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { findCustomerIdsByQuery } from '../../common/search/unaccent-search';
import {
  CreateCustomerDto,
  CustomerAddressDto,
  ListCustomersQueryDto,
  UpdateCustomerDto,
} from './customer.dto';

type CustomerWithRelations = Prisma.CustomerGetPayload<{
  include: { addresses: true; groups: { include: { group: true } } };
}>;

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
  constructor(private prisma: PrismaService) {}

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

  async list(query: ListCustomersQueryDto) {
    const page = Math.max(query.page ?? 1, 1);
    const limit = Math.min(query.limit ?? 20, 100);
    const where: Prisma.CustomerWhereInput = {};

    if (query.q?.trim()) {
      where.id = { in: await findCustomerIdsByQuery(this.prisma, query.q.trim()) };
    }
    if (query.state) where.state = query.state;
    if (query.gender) where.gender = query.gender;
    if (query.customer_group_id) {
      where.groups = { some: { customerGroupId: BigInt(query.customer_group_id) } };
    }
    if (query.order_filter === 'has_order') where.ordersCount = { gt: 0 };
    if (query.order_filter === 'no_order') where.ordersCount = 0;

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

  private async assertPhoneFree(phone: string | undefined, excludeId?: bigint) {
    if (!phone?.trim()) return;
    const dup = await this.prisma.customer.findFirst({
      where: { phone: phone.trim(), ...(excludeId ? { id: { not: excludeId } } : {}) },
      select: { id: true },
    });
    if (dup) throw new ConflictException('PHONE_EXISTS');
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
        groups: dto.customer_group_ids?.length
          ? {
              create: dto.customer_group_ids.map((gid) => ({
                customerGroupId: BigInt(gid),
              })),
            }
          : undefined,
      },
    });
    return this.findOne(created.id);
  }

  async update(id: bigint, dto: UpdateCustomerDto) {
    const existing = await this.prisma.customer.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Không tìm thấy khách hàng');
    await this.assertPhoneFree(dto.phone, id);

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
          dob: dto.dob !== undefined ? (dto.dob ? new Date(dto.dob) : null) : undefined,
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
        await tx.customerGroupMember.deleteMany({ where: { customerId: id } });
        if (dto.customer_group_ids.length) {
          await tx.customerGroupMember.createMany({
            data: dto.customer_group_ids.map((gid) => ({
              customerId: id,
              customerGroupId: BigInt(gid),
            })),
            skipDuplicates: true,
          });
        }
      }
    });

    return this.findOne(id);
  }

  /** Không xoá cứng khi khách đã có đơn — chỉ chuyển sang `disabled` như Sapo. */
  async remove(id: bigint) {
    const c = await this.prisma.customer.findUnique({
      where: { id },
      select: { id: true, ordersCount: true, _count: { select: { orders: true } } },
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
