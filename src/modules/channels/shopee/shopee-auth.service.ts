import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { BusinessException } from '../../../common/exceptions/business.exception';
import { ShopeeClient, ShopeeTokenResult } from './shopee.client';

const DEFAULT_REFRESH_TTL_SEC = 30 * 24 * 60 * 60;

/**
 * Đổi `code` + `shop_id` (redirect sau seller ủy quyền) lấy access/refresh token
 * và lưu vào `channel_connections`.
 */
@Injectable()
export class ShopeeAuthService {
  private readonly logger = new Logger(ShopeeAuthService.name);
  private readonly client: ShopeeClient | null;

  constructor(private prisma: PrismaService) {
    const partnerId = process.env.SHOPEE_PARTNER_ID?.trim();
    const partnerKey = process.env.SHOPEE_PARTNER_KEY?.trim();
    const redirectUrl = process.env.SHOPEE_REDIRECT_URL?.trim();
    this.client =
      partnerId && partnerKey && redirectUrl
        ? new ShopeeClient(partnerId, partnerKey, redirectUrl)
        : null;
  }

  /**
   * Lấy URL để đăng nhập Shopee
   * https://open.shopee.com/documents/v2/auth.html#section/Authentication/Get-authorization-code
   * @returns string - URL để đăng nhập Shopee
   */
  getAuthorizeUrl(): string {
    return this.assertConfigured().buildAuthorizeUrl();
  }
  /**
   * Xử lý callback đăng nhập Shopee
   * https://open.shopee.com/documents/v2/auth.html#section/Authentication/Get-authorization-code
   * @param code - Mã code từ Shopee
   * @param shopId - ID của shop Shopee
   * @returns Promise<ChannelConnection> - Kết quả xử lý callback đăng nhập Shopee
   */
  async handleAuthorizationCallback(code: string, shopId: string) {
    const client = this.assertConfigured();
    const token = await client.exchangeToken(code, shopId);
    this.logger.log(`Shopee kết nối thành công: shop_id=${shopId}`);

    let shopName: string | null = null;
    try {
      shopName = await client.getShopName(token.access_token, shopId);
    } catch {
      // ponytail: tên shop không bắt buộc để lưu token
    }

    return this.persistToken(shopId, token, shopName);
  }
  /**
   * Làm mới kết nối Shopee
   * https://open.shopee.com/documents/v2/auth.html#section/Authentication/Get-authorization-code
   * @param connectionId - ID của kết nối Shopee
   * @returns Promise<ChannelConnection> - Kết quả làm mới kết nối Shopee
   */
  async refreshConnection(connectionId: bigint) {
    const client = this.assertConfigured();
    const conn = await this.prisma.channelConnection.findUniqueOrThrow({
      where: { id: connectionId },
    });
    const token = await client.refreshAccessToken(
      conn.refreshToken,
      conn.shopId,
    );
    return this.persistToken(conn.shopId, token, conn.shopName);
  }

  private assertConfigured(): ShopeeClient {
    if (!this.client) {
      throw new BusinessException(
        'CHANNEL_NOT_CONFIGURED',
        'Thiếu SHOPEE_PARTNER_ID/SHOPEE_PARTNER_KEY/SHOPEE_REDIRECT_URL trong cấu hình server',
        500,
      );
    }
    return this.client;
  }

  /**
   * Lưu token Shopee
   * https://open.shopee.com/documents/v2/auth.html#section/Authentication/Get-authorization-code
   * @param shopId - ID của shop Shopee
   * @param token - Token Shopee
   * @param shopName - Tên shop Shopee
   * @returns Promise<ChannelConnection> - Kết quả lưu token Shopee
   */
  private persistToken(
    shopId: string,
    token: ShopeeTokenResult,
    shopName: string | null,
  ) {
    const refreshTtl = token.refresh_token_expire_in ?? DEFAULT_REFRESH_TTL_SEC;
    const tokenFields = {
      accessToken: token.access_token,
      accessTokenExpiresAt: new Date(Date.now() + token.expire_in * 1000),
      refreshToken: token.refresh_token,
      refreshTokenExpiresAt: new Date(Date.now() + refreshTtl * 1000),
      grantedScopes: [] as string[],
    };
    return this.prisma.channelConnection.upsert({
      where: { channel_shopId: { channel: 'shopee', shopId } },
      create: { channel: 'shopee', shopId, shopName, ...tokenFields },
      update: {
        ...tokenFields,
        ...(shopName ? { shopName } : {}),
      },
    });
  }
}
