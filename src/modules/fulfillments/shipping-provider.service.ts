import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, ShippingProviderType } from '@prisma/client';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { BusinessException } from '../../common/exceptions/business.exception';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CarrierAdapter,
  CarrierServiceConfig,
  GHN_PROVIDER_CODE,
} from './carriers/carrier-adapter';
import { GhnAdapter } from './carriers/ghn.adapter';
import { GhnClient, parseGhnCredentials } from './carriers/ghn.client';
import { ManualAdapter } from './carriers/manual.adapter';
import {
  ConnectProviderDto,
  CreateShippingPartnerDto,
  UpdateShippingProviderDto,
} from './fulfillment.dto';
import { serializeShippingProvider } from './fulfillment.serializer';

const DEFAULT_WEIGHT_GRAMS = 500;

@Injectable()
export class ShippingProviderService {
  private readonly manual = new ManualAdapter();
  private readonly ghn = new GhnAdapter();

  constructor(private prisma: PrismaService) {}

  /** Adapter theo mã hãng — GHN có status map riêng; còn lại Manual. */
  adapterFor(providerCode: string): CarrierAdapter {
    return providerCode === GHN_PROVIDER_CODE ? this.ghn : this.manual;
  }

  get ghnAdapter(): GhnAdapter {
    return this.ghn;
  }

  /** @deprecated dùng adapterFor(code) — giữ để e2e/webhook cũ không vỡ ngay */
  get carrierAdapter(): CarrierAdapter {
    return this.manual;
  }

  ghnClientFor(connectionConfig: Prisma.JsonValue | null): GhnClient {
    const creds = parseGhnCredentials(connectionConfig);
    if (!creds) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        'GHN chưa cấu hình Token/ShopId. Vào Cấu hình → kết nối lại.',
        422,
      );
    }
    return new GhnClient(creds);
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
      data: providers.map((p) => ({
        provider_id: p.id.toString(),
        provider_code: p.code,
        provider_name: p.name,
        is_connected: p.isConnected,
        services: p.isConnected
          ? this.adapterFor(p.code).quote(
              (p.servicesConfig ?? []) as CarrierServiceConfig[],
              weight,
            )
          : [],
      })),
    };
  }

  /** Tính phí server-side cho một dịch vụ cụ thể của hãng tích hợp. */
  quoteService(
    servicesConfig: Prisma.JsonValue,
    serviceCode: string,
    weightGrams: number,
    providerCode = '',
  ) {
    const services = (servicesConfig ?? []) as CarrierServiceConfig[];
    const quoted = this.adapterFor(providerCode)
      .quote(services, weightGrams)
      .find((q) => q.code === serviceCode);
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

    const token = dto.token?.trim();
    const shopId = dto.shop_id?.trim();
    if (!token || !shopId) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        'Cần Token API và ShopId của GHN',
        422,
      );
    }

    const connectionConfig = { token, shop_id: shopId };

    // GHN: xác thực token trước khi lưu
    if (provider.code === GHN_PROVIDER_CODE) {
      const client = this.ghnClientFor(connectionConfig);
      try {
        await client.ping();
      } catch (err) {
        if (err instanceof BusinessException) throw err;
        throw new BusinessException(
          'GHN_ERROR',
          'Token/ShopId GHN không hợp lệ',
          422,
        );
      }
    }

    const updated = await this.prisma.shippingProvider.update({
      where: { id },
      data: {
        isConnected: true,
        connectionConfig,
      },
    });
    return serializeShippingProvider(updated);
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
