import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { hasPermission } from '../../common/auth/access';

@Injectable()
export class ConfigService {
  constructor(private prisma: PrismaService) {}

  /**
   * Danh sách kho/chi nhánh. Sapo gộp hai khái niệm này làm một `Location`
   * ("điểm bán, kho, chi nhánh, trụ sở") nên chỉ còn một endpoint duy nhất.
   */
  async listLocations(user: AuthUser) {
    const canSeeAll = hasPermission(user, 'staff:manage');

    const data = await this.prisma.location.findMany({
      where: {
        status: 'active',
        ...(canSeeAll ? {} : { id: { in: user.locationIds } }),
      },
      orderBy: [{ defaultLocation: 'desc' }, { name: 'asc' }],
    });

    return {
      data: data.map((l) => ({
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
      })),
    };
  }
}
