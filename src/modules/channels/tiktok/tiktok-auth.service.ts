import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { BusinessException } from '../../../common/exceptions/business.exception';
import { TiktokClient, TiktokTokenResult } from './tiktok.client';

/**
 * Đổi `auth_code` (nhận ở Redirect URL sau khi seller ủy quyền) lấy access/refresh token
 * và lưu vào `channel_connections`. Theo "Authorization overview" — TikTok Shop Partner Center.
 */
@Injectable()
export class TiktokAuthService {
  private readonly logger = new Logger(TiktokAuthService.name);
  private readonly client: TiktokClient | null;

  constructor(private prisma: PrismaService) {
    const appKey = process.env.TIKTOK_APP_KEY?.trim();
    const appSecret = process.env.TIKTOK_APP_SECRET?.trim();
    this.client =
      appKey && appSecret ? new TiktokClient(appKey, appSecret) : null;
  }

  async handleAuthorizationCode(authCode: string) {
    const client = this.assertConfigured();
    const token = await client.getAccessToken(authCode);
    this.logger.log(`TikTok Shop kết nối thành công: open_id=${token.open_id}`);
    return this.persistToken(token);
  }

  async refreshConnection(connectionId: bigint) {
    const client = this.assertConfigured();
    const conn = await this.prisma.channelConnection.findUniqueOrThrow({
      where: { id: connectionId },
    });
    const token = await client.refreshAccessToken(conn.refreshToken);
    return this.persistToken(token);
  }

  private assertConfigured(): TiktokClient {
    if (!this.client) {
      throw new BusinessException(
        'CHANNEL_NOT_CONFIGURED',
        'Thiếu TIKTOK_APP_KEY/TIKTOK_APP_SECRET trong cấu hình server',
        500,
      );
    }
    return this.client;
  }

  private persistToken(token: TiktokTokenResult) {
    const shared = {
      shopName: token.seller_name ?? null,
      accessToken: token.access_token,
      accessTokenExpiresAt: new Date(token.access_token_expire_in * 1000),
      refreshToken: token.refresh_token,
      refreshTokenExpiresAt: new Date(token.refresh_token_expire_in * 1000),
      grantedScopes: token.granted_scopes ?? [],
    };
    return this.prisma.channelConnection.upsert({
      where: { channel_shopId: { channel: 'tiktok', shopId: token.open_id } },
      create: { channel: 'tiktok', shopId: token.open_id, ...shared },
      update: shared,
    });
  }
}
