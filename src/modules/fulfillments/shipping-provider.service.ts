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
import { GhnLocationResolver } from './carriers/ghn-location-resolver';
import { assertGhnPickupReady, GhnAdapter } from './carriers/ghn.adapter';
import { GhnClient, isGhnSandbox } from './carriers/ghn.client';
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
export const GHN_PROVIDER_CODE = 'ghn';
export const VTP_PROVIDER_CODE = 'viettel_post';

/** Danh mục hãng mặc định — migration chỉ tạo bảng, không INSERT. */
const DEFAULT_CARRIERS: {
  code: string;
  name: string;
  servicesConfig: CarrierServiceConfig[];
}[] = [
  {
    code: 'ghn',
    name: 'GHN Express',
    servicesConfig: [
      {
        code: 'standard',
        name: 'Chuẩn',
        eta: '2-3 ngày',
        base_fee: 44080,
        extra_fee_per_500g: 5500,
      },
      {
        code: 'fast',
        name: 'Nhanh',
        eta: '1-2 ngày',
        base_fee: 60500,
        extra_fee_per_500g: 7000,
      },
    ],
  },
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
  private readonly ghnClient = new GhnClient();
  private readonly vtpClient = new VtpClient();
  private readonly adapters: Record<string, CarrierAdapter>;

  constructor(private prisma: PrismaService) {
    this.adapters = {
      [GHN_PROVIDER_CODE]: new GhnAdapter(
        this.ghnClient,
        new GhnLocationResolver(this.ghnClient),
      ),
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

  get ghn() {
    return this.ghnClient;
  }

  get ghnAdapter(): GhnAdapter {
    return this.adapters[GHN_PROVIDER_CODE] as GhnAdapter;
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
      ghn_env: isGhnSandbox() ? ('sandbox' as const) : ('production' as const),
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
   * Kết nối provider với GHN
   * provider có thể là GHN, SPX, GHTK, Viettel Post, J&T
   * @param id id của provider
   * @param dto { token: string; shop_id: string }
   * @returns provider đã kết nối
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
    const config: CarrierConnectionConfig = {
      token: dto.token ?? null,
      shop_id: dto.shop_id ?? null,
    };
    // nếu provider là GHN thì verify GHN
    if (provider.code === GHN_PROVIDER_CODE) {
      Object.assign(config, await this.verifyGhn(dto.token, dto.shop_id));
    } else if (provider.code === VTP_PROVIDER_CODE) {
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
    // lấy danh sách các shop của GHN
    const shops = await this.ghnClient.getShops({ token });
    // lấy danh sách các tỉnh/thành của shop
    const provinces = await this.ghnClient.getProvinces({ token });
    // nếu không có tỉnh/thành thì báo lỗi
    if (!provinces.length) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        `Token GHN không lấy được danh sách Tỉnh/Thành. Kiểm tra Token và GHN_ENV backend (${isGhnSandbox() ? 'sandbox → 5sao.ghn.dev' : 'production → khachhang.ghn.vn'}).`,
        422,
      );
    }
    const sampleProvince =
      provinces.find((p) => p.ProvinceID === 201) ?? provinces[0];
    // lấy danh sách các quận/huyện của tỉnh/thành
    const sampleDistricts = await this.ghnClient.getDistricts(
      sampleProvince.ProvinceID,
      { token },
    );
    // nếu không có quận/huyện thì báo lỗi
    if (!sampleDistricts.length) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        `Token GHN không lấy được Quận/Huyện (thử ${sampleProvince.ProvinceName}). ` +
          `Token và GHN_ENV backend có thể không khớp — sandbox cần GHN_ENV=sandbox và Token từ 5sao.ghn.dev.`,
        422,
      );
    }
    // tìm shop theo shopId
    const shop = shops.find((s) => String(s._id) === String(shopId));
    // nếu không tìm thấy shop thì báo lỗi
    if (!shop) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        `ShopID ${shopId} không thuộc tài khoản GHN của Token này`,
        422,
      );
    }
    // lấy district_id và ward_code của shop
    const fromDistrictId =
      shop.district_id && shop.district_id > 0 ? shop.district_id : null;
    const fromWardCode = shop.ward_code?.trim() || null;
    // tạo config cho provider
    const pickup: Partial<CarrierConnectionConfig> = {
      client_id: shop.client_id != null ? String(shop.client_id) : null,
      from_name: shop.name ?? null,
      from_phone: shop.phone ?? null,
      from_address: shop.address ?? null,
      from_district_id: fromDistrictId,
      from_ward_code: fromWardCode,
    };
    // kiểm tra config có hợp lệ không, phải có shop_id, token, và from_district_id, from_ward_code
    assertGhnPickupReady({ shop_id: shopId, token, ...pickup });
    // trả về config
    return pickup;
  }

  /**
   * Xác thực Token ViettelPost — không cần Shop ID (khác GHN). Hỗ trợ 2 dạng: "tham số bí mật"
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
