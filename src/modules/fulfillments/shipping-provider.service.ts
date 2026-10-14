import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma, ShippingProviderType } from '@prisma/client';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { BusinessException } from '../../common/exceptions/business.exception';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CarrierAdapter,
  CarrierConnectionConfig,
  CarrierServiceConfig,
} from './carriers/carrier-adapter';
import { ManualAdapter } from './carriers/manual.adapter';
import { VtpAdapter } from './carriers/vtp.adapter';
import {
  VtpClient,
  isVtpSandbox,
  isVtpSessionToken,
} from './carriers/vtp.client';
import {
  ConnectProviderDto,
  CreateShippingPartnerDto,
  UpdateShippingProviderDto,
} from './fulfillment.dto';
import { serializeShippingProvider } from './fulfillment.serializer';

const DEFAULT_WEIGHT_GRAMS = 500;

/** `shipping_providers.code` của hãng đã tích hợp API thật. */
export const VTP_PROVIDER_CODE = 'viettel_post';

/** Danh mục hãng mặc định — migration chỉ tạo bảng, không INSERT. */
const DEFAULT_CARRIERS: {
  code: string;
  name: string;
  servicesConfig: CarrierServiceConfig[];
}[] = [
  {
    code: 'spx',
    name: 'SPX Express',
    servicesConfig: [
      {
        code: 'standard',
        name: 'Chuẩn',
        eta: '2-3 ngày',
        base_fee: 39000,
        extra_fee_per_500g: 5000,
      },
    ],
  },
  {
    code: 'ghtk',
    name: 'GHTK',
    servicesConfig: [
      {
        code: 'standard',
        name: 'Chuẩn',
        eta: '2-4 ngày',
        base_fee: 38000,
        extra_fee_per_500g: 4500,
      },
    ],
  },
  {
    code: 'viettel_post',
    name: 'Viettel Post',
    servicesConfig: [
      {
        code: 'standard',
        name: 'Chuẩn',
        eta: '2-4 ngày',
        base_fee: 42000,
        extra_fee_per_500g: 5000,
      },
      {
        code: 'express_48h',
        name: 'Chuyển phát hỏa tốc (48 giờ)',
        eta: '48 giờ',
        base_fee: 180925,
        extra_fee_per_500g: 12000,
      },
    ],
  },
  {
    code: 'jt',
    name: 'J&T Express',
    servicesConfig: [
      {
        code: 'standard',
        name: 'Chuẩn',
        eta: '2-4 ngày',
        base_fee: 58432,
        extra_fee_per_500g: 6000,
      },
    ],
  },
];

@Injectable()
export class ShippingProviderService implements OnModuleInit {
  private readonly logger = new Logger(ShippingProviderService.name);
  private readonly manualAdapter = new ManualAdapter();
  private readonly vtpClient = new VtpClient();
  private readonly adapters: Record<string, CarrierAdapter>;

  constructor(private prisma: PrismaService) {
    this.adapters = {
      [VTP_PROVIDER_CODE]: new VtpAdapter(this.vtpClient),
    };
  }

  /** Bảng rỗng sau migrate → tự nạp danh mục để UI giao hàng loạt có hãng chọn. */
  async onModuleInit() {
    if (await this.prisma.shippingProvider.count()) return;
    this.logger.log('shipping_providers trống — nạp danh mục hãng mặc định');
    for (const c of DEFAULT_CARRIERS) {
      await this.prisma.shippingProvider.create({
        data: {
          code: c.code,
          name: c.name,
          type: ShippingProviderType.tich_hop,
          isConnected: false,
          servicesConfig: c.servicesConfig,
        },
      });
    }
    await this.prisma.shippingProvider.create({
      data: {
        code: 'PARTNER0001',
        name: 'Đối tác giao hàng nội thành',
        type: ShippingProviderType.tu_lien_he,
        phone: '0901234567',
      },
    });
  }

  /** Adapter của hãng theo `code`; hãng chưa tích hợp API dùng ManualAdapter. */
  adapterFor(code: string): CarrierAdapter {
    return this.adapters[code] ?? this.manualAdapter;
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

  /**
   * Lưu token kết nối của hãng tích hợp. ViettelPost được gọi thử để xác thực ngay; hãng
   * chưa có adapter thật (SPX, GHTK, J&T) chỉ lưu token.
   */
  async connect(id: bigint, dto: ConnectProviderDto) {
    // tìm provider theo id
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
    // tạo config cho provider
    const config: CarrierConnectionConfig = { token: dto.token ?? null };
    if (provider.code === VTP_PROVIDER_CODE) {
      await this.verifyVtp(dto.token);
    }

    // cập nhật provider đã kết nối
    const updated = await this.prisma.shippingProvider.update({
      where: { id },
      data: { isConnected: true, connectionConfig: config },
    });
    return serializeShippingProvider(updated);
  }

  /**
   * Xác thực Token ViettelPost. Hỗ trợ 2 dạng: "tham số bí mật"
   * (đổi thử sang token phiên qua LoginVTP) hoặc session JWT có sẵn (tài khoản đối tác có thể
   * được cấp thẳng JWT hạn dùng dài — xác nhận thực tế: tài khoản 8501446 tới 2029; JWT không
   * đổi lại được qua LoginVTP nên xác thực bằng gọi thử API khác cần Token).
   */
  private async verifyVtp(token?: string): Promise<void> {
    if (!token) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        'Kết nối ViettelPost cần Token',
        422,
      );
    }
    const envHint = isVtpSandbox()
      ? 'sandbox → partnerdev.viettelpost.vn'
      : 'production → partner.viettelpost.vn';
    if (isVtpSessionToken(token)) {
      const provinces = await this.vtpClient.listProvincesNew({ token });
      if (!provinces.length) {
        throw new BusinessException(
          'VALIDATION_ERROR',
          `Token ViettelPost không xác thực được. Kiểm tra Token và VTP_ENV backend (${envHint}).`,
          422,
        );
      }
      return;
    }
    const login = await this.vtpClient.loginVtp(token);
    if (!login?.token) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        `Token ViettelPost không xác thực được. Kiểm tra Token và VTP_ENV backend (${envHint}).`,
        422,
      );
    }
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
