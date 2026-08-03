import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, ShippingProviderType } from '@prisma/client';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { BusinessException } from '../../common/exceptions/business.exception';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CarrierAdapter,
  CarrierConnectionConfig,
  CarrierServiceConfig,
} from './carriers/carrier-adapter';
import { GhnLocationResolver } from './carriers/ghn-location-resolver';
import { GhnAdapter } from './carriers/ghn.adapter';
import { GhnClient } from './carriers/ghn.client';
import { ManualAdapter } from './carriers/manual.adapter';
import {
  ConnectProviderDto,
  CreateShippingPartnerDto,
  UpdateShippingProviderDto,
} from './fulfillment.dto';
import { serializeShippingProvider } from './fulfillment.serializer';

const DEFAULT_WEIGHT_GRAMS = 500;

/** `shipping_providers.code` của hãng đã tích hợp API thật. */
export const GHN_PROVIDER_CODE = 'ghn';

@Injectable()
export class ShippingProviderService {
  private readonly manualAdapter = new ManualAdapter();
  private readonly ghnClient = new GhnClient();
  private readonly adapters: Record<string, CarrierAdapter>;

  constructor(private prisma: PrismaService) {
    this.adapters = {
      [GHN_PROVIDER_CODE]: new GhnAdapter(
        this.ghnClient,
        new GhnLocationResolver(this.ghnClient),
      ),
    };
  }

  /** Adapter của hãng theo `code`; hãng chưa tích hợp API dùng ManualAdapter. */
  adapterFor(code: string): CarrierAdapter {
    return this.adapters[code] ?? this.manualAdapter;
  }

  get ghn() {
    return this.ghnClient;
  }

  async list(type?: ShippingProviderType) {
    const data = await this.prisma.shippingProvider.findMany({
      where: { isActive: true, ...(type ? { type } : {}) },
      orderBy: [{ type: 'asc' }, { name: 'asc' }],
    });
    return { data: data.map(serializeShippingProvider) };
  }

  /** Báo giá dịch vụ của các hãng tích hợp theo khối lượng. */
  async quotes(weightGrams?: number) {
    const weight = weightGrams ?? DEFAULT_WEIGHT_GRAMS;
    const providers = await this.prisma.shippingProvider.findMany({
      where: { isActive: true, type: ShippingProviderType.tich_hop },
      orderBy: { name: 'asc' },
    });
    return {
      data: await Promise.all(
        providers.map(async (p) => ({
          provider_id: p.id.toString(),
          provider_code: p.code,
          provider_name: p.name,
          is_connected: p.isConnected,
          services: p.isConnected
            ? await this.adapterFor(p.code).quote(
                (p.servicesConfig ?? []) as CarrierServiceConfig[],
                weight,
              )
            : [],
        })),
      ),
    };
  }

  /**
   * Phí ước tính server-side cho một dịch vụ. Với hãng tích hợp API thật, đây chỉ là con số
   * hiển thị trước khi submit — phí THẬT do hãng trả về lúc tạo vận đơn sẽ ghi đè.
   */
  async quoteService(
    providerCode: string,
    servicesConfig: Prisma.JsonValue,
    serviceCode: string,
    weightGrams: number,
  ) {
    const services = (servicesConfig ?? []) as CarrierServiceConfig[];
    const quotes = await this.adapterFor(providerCode).quote(
      services,
      weightGrams,
    );
    const quoted = quotes.find((q) => q.code === serviceCode);
    if (!quoted) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        'Dịch vụ vận chuyển không hợp lệ',
        422,
      );
    }
    return quoted;
  }

  async createPartner(dto: CreateShippingPartnerDto, _user: AuthUser) {
    const created = await this.prisma.$transaction(async (tx) => {
      const count = await tx.shippingProvider.count({
        where: { type: ShippingProviderType.tu_lien_he },
      });
      return tx.shippingProvider.create({
        data: {
          code: `PARTNER${String(count + 1).padStart(4, '0')}`,
          name: dto.name.trim(),
          type: ShippingProviderType.tu_lien_he,
          phone: dto.phone,
          note: dto.note,
        },
      });
    });
    return serializeShippingProvider(created);
  }

  async update(id: bigint, dto: UpdateShippingProviderDto) {
    const provider = await this.prisma.shippingProvider.findUnique({
      where: { id },
    });
    if (!provider)
      throw new NotFoundException('Không tìm thấy đối tác vận chuyển');
    const updated = await this.prisma.shippingProvider.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
        ...(dto.email !== undefined ? { email: dto.email } : {}),
        ...(dto.note !== undefined ? { note: dto.note } : {}),
        ...(dto.is_active !== undefined ? { isActive: dto.is_active } : {}),
      },
    });
    return serializeShippingProvider(updated);
  }

  async connect(id: bigint, dto: ConnectProviderDto) {
    const provider = await this.prisma.shippingProvider.findUnique({
      where: { id },
    });
    if (!provider)
      throw new NotFoundException('Không tìm thấy đối tác vận chuyển');
    if (provider.type !== ShippingProviderType.tich_hop) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        'Chỉ kết nối được hãng vận chuyển tích hợp',
        422,
      );
    }
    const config: CarrierConnectionConfig = {
      token: dto.token ?? null,
      shop_id: dto.shop_id ?? null,
    };

    if (provider.code === GHN_PROVIDER_CODE) {
      Object.assign(config, await this.verifyGhn(dto.token, dto.shop_id));
    }

    const updated = await this.prisma.shippingProvider.update({
      where: { id },
      data: { isConnected: true, connectionConfig: config },
    });
    return serializeShippingProvider(updated);
  }

  /**
   * Xác thực Token/ShopID với GHN và lấy luôn địa chỉ lấy hàng đã đăng ký bên đó
   * (`from_district_id`/`from_ward_code` bắt buộc khi gọi available-services), nên UI chỉ cần
   * nhập token + shop_id như trước. `client_id` lấy về để đăng ký webhook với GHN.
   */
  private async verifyGhn(
    token?: string,
    shopId?: string,
  ): Promise<Partial<CarrierConnectionConfig>> {
    if (!token || !shopId) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        'Kết nối GHN cần cả Token và ShopID',
        422,
      );
    }
    const shops = await this.ghnClient.getShops({ token });
    const shop = shops.find((s) => String(s._id) === String(shopId));
    if (!shop) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        `ShopID ${shopId} không thuộc tài khoản GHN của Token này`,
        422,
      );
    }
    return {
      client_id: shop.client_id != null ? String(shop.client_id) : null,
      from_name: shop.name ?? null,
      from_phone: shop.phone ?? null,
      from_address: shop.address ?? null,
      from_district_id: shop.district_id ?? null,
      from_ward_code: shop.ward_code ?? null,
    };
  }

  async disconnect(id: bigint) {
    const provider = await this.prisma.shippingProvider.findUnique({
      where: { id },
    });
    if (!provider)
      throw new NotFoundException('Không tìm thấy đối tác vận chuyển');
    const updated = await this.prisma.shippingProvider.update({
      where: { id },
      data: { isConnected: false, connectionConfig: Prisma.DbNull },
    });
    return serializeShippingProvider(updated);
  }
}
