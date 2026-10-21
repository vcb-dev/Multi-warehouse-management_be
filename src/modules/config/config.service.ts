import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { hasPermission } from '../../common/auth/access';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { BusinessException } from '../../common/exceptions/business.exception';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateLocationDto,
  ListLocationsQueryDto,
  UpdateLocationDto,
} from './dto/location.dto';

@Injectable()
export class ConfigService {
  constructor(private prisma: PrismaService) {}

  async listLocations(user: AuthUser, query: ListLocationsQueryDto = {}) {
    const canSeeAll = hasPermission(user, 'staff:manage');
    const includeInactive = !!query.include_inactive && canSeeAll;

    const data = await this.prisma.location.findMany({
      where: {
        ...(includeInactive ? {} : { status: 'active' }),
        ...(canSeeAll ? {} : { id: { in: user.locationIds } }),
      },
      orderBy: [{ defaultLocation: 'desc' }, { name: 'asc' }],
    });

    return { data: data.map(this.toResponse) };
  }

  async createLocation(dto: CreateLocationDto) {
    await this.assertCodeFree(dto.code);
    const created = await this.prisma.$transaction(async (tx) => {
      if (dto.default_location) await this.clearDefault(tx);
      return tx.location.create({
        data: {
          name: dto.name.trim(),
          code: dto.code ?? null,
          phone: dto.phone ?? null,
          email: dto.email ?? null,
          address1: dto.address1?.trim() || null,
          province: dto.province?.trim() || null,
          district: dto.district?.trim() || null,
          ward: dto.ward?.trim() || null,
          defaultLocation: dto.default_location ?? false,
          inventoryManagement: dto.inventory_management ?? true,
          status: 'active',
        },
      });
    });
    return this.toResponse(created);
  }

  async updateLocation(id: bigint, dto: UpdateLocationDto) {
    const existing = await this.prisma.location.findUnique({ where: { id } });
    if (!existing) {
      throw new BusinessException('NOT_FOUND', 'Không tìm thấy kho', 404);
    }
    await this.assertCodeFree(dto.code, id);

    const updated = await this.prisma.$transaction(async (tx) => {
      if (dto.default_location) await this.clearDefault(tx, id);
      return tx.location.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
          ...(dto.code !== undefined ? { code: dto.code ?? null } : {}),
          ...(dto.phone !== undefined ? { phone: dto.phone ?? null } : {}),
          ...(dto.email !== undefined ? { email: dto.email ?? null } : {}),
          ...(dto.address1 !== undefined
            ? { address1: dto.address1.trim() || null }
            : {}),
          ...(dto.province !== undefined
            ? { province: dto.province.trim() || null }
            : {}),
          ...(dto.district !== undefined
            ? { district: dto.district.trim() || null }
            : {}),
          ...(dto.ward !== undefined ? { ward: dto.ward.trim() || null } : {}),
          ...(dto.default_location !== undefined
            ? { defaultLocation: dto.default_location }
            : {}),
          ...(dto.inventory_management !== undefined
            ? { inventoryManagement: dto.inventory_management }
            : {}),
          ...(dto.status !== undefined ? { status: dto.status } : {}),
        },
      });
    });
    return this.toResponse(updated);
  }

  /** Soft-delete. Không xóa hàng — FK đơn/tồn sẽ chặn. */
  async deactivateLocation(id: bigint) {
    return this.updateLocation(id, {
      status: 'inactive',
      default_location: false,
    });
  }

  private async assertCodeFree(code?: string | null, exceptId?: bigint) {
    if (!code) return;
    const clash = await this.prisma.location.findFirst({
      where: { code, ...(exceptId ? { id: { not: exceptId } } : {}) },
    });
    if (clash) {
      throw new BusinessException('CODE_EXISTS', 'Mã kho đã tồn tại', 409, {
        code: ['Mã kho đã tồn tại'],
      });
    }
  }
  /* Xóa default location khác nếu có */
  private async clearDefault(tx: Prisma.TransactionClient, exceptId?: bigint) {
    await tx.location.updateMany({
      where: {
        defaultLocation: true,
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
      data: { defaultLocation: false },
    });
  }

  private toResponse(l: {
    id: bigint;
    sapoId: bigint | null;
    code: string | null;
    name: string;
    status: string;
    defaultLocation: boolean;
    phone: string | null;
    email: string | null;
    address1: string | null;
    address2: string | null;
    city: string | null;
    province: string | null;
    provinceCode: string | null;
    district: string | null;
    districtCode: string | null;
    ward: string | null;
    wardCode: string | null;
    country: string | null;
    countryCode: string | null;
    zip: string | null;
    inventoryManagement: boolean;
  }) {
    return {
      id: l.id.toString(),
      sapo_id: l.sapoId?.toString() ?? null,
      code: l.code,
      name: l.name,
      status: l.status,
      default_location: l.defaultLocation,
      phone: l.phone,
      email: l.email,
      address1: l.address1,
      address2: l.address2,
      city: l.city,
      province: l.province,
      province_code: l.provinceCode,
      district: l.district,
      district_code: l.districtCode,
      ward: l.ward,
      ward_code: l.wardCode,
      country: l.country,
      country_code: l.countryCode,
      zip: l.zip,
      inventory_management: l.inventoryManagement,
    };
  }
}
