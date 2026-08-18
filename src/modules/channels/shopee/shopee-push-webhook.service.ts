import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { resolveChannelSyncActorId } from '../channel-sync-actor';
import { verifyShopeePushSignature } from './shopee.client';
import { ShopeeSyncService } from './shopee-sync.service';

/** Push code 3 = order_status_push */
const ORDER_STATUS_PUSH_CODE = 3;

/**
 * Nhận push từ Shopee Open Platform khi đơn đổi trạng thái.
 * Payload chỉ dùng để lấy `ordersn` + `shop_id`; nội dung đơn luôn kéo lại qua API.
 * Cron `syncRecent` là lưới an toàn khi push rơi (deploy, mạng, timeout 3s).
 */
@Injectable()
export class ShopeePushWebhookService {
  private readonly logger = new Logger(ShopeePushWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sync: ShopeeSyncService,
  ) {}

  verifySignature(
    callbackUrl: string,
    rawBody: string,
    authorization?: string,
  ): boolean {
    const partnerKey = process.env.SHOPEE_PARTNER_KEY?.trim();
    if (!partnerKey || !authorization) return false;
    return verifyShopeePushSignature(
      callbackUrl,
      rawBody,
      partnerKey,
      authorization,
    );
  }

  /** `strict` = từ chối khi chữ ký sai. Mặc định `log` hoặc skip khi dev. */
  isStrict(): boolean {
    if (process.env.SHOPEE_PUSH_SKIP_VERIFY === 'true') return false;
    return process.env.SHOPEE_PUSH_VERIFY === 'strict';
  }

  resolveCallbackUrl(): string {
    return (
      process.env.SHOPEE_PUSH_CALLBACK_URL?.trim() ||
      `${process.env.APP_PUBLIC_URL?.replace(/\/$/, '') || 'http://localhost:3001'}/api/channels/shopee/push`
    );
  }

  async handleNotification(
    payload: ShopeePushPayload,
    signatureValid: boolean,
  ) {
    this.logger.log(
      `Webhook Shopee code=${payload?.code} chữ ký ${signatureValid ? 'khớp' : 'KHÔNG khớp'}${
        this.isStrict() ? '' : ' (chưa chặn)'
      }`,
    );

    if (payload?.code !== ORDER_STATUS_PUSH_CODE) {
      return { accepted: true };
    }

    const orderSn = payload.data?.ordersn?.trim();
    const shopId = payload.shop_id != null ? String(payload.shop_id) : '';
    if (!orderSn || !shopId) {
      this.logger.warn('Webhook Shopee thiếu ordersn hoặc shop_id, bỏ qua');
      return { accepted: false };
    }

    const actorId = await resolveChannelSyncActorId(this.prisma);
    if (!actorId) {
      this.logger.error(
        'Webhook Shopee: không tìm được user đồng bộ để gán làm người tạo đơn',
      );
      return { accepted: false };
    }

    void this.sync
      .syncOrderSns([orderSn], shopId, actorId)
      .then((r) =>
        this.logger.log(
          `Webhook Shopee đơn ${orderSn} shop ${shopId}: ${r.created} mới, ${r.updated} cập nhật`,
        ),
      )
      .catch((e) =>
        this.logger.error(
          `Webhook Shopee đơn ${orderSn} lỗi: ${e?.message ?? e} — cron sẽ vá lại`,
        ),
      );

    return { accepted: true };
  }
}

export type ShopeePushPayload = {
  code?: number;
  shop_id?: number;
  timestamp?: number;
  data?: {
    ordersn?: string;
    status?: string;
    update_time?: number;
  };
};
