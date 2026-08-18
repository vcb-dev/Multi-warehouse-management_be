import { Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { resolveChannelSyncActorId } from '../channel-sync-actor';
import { TiktokOrderSyncService } from './tiktok-order-sync.service';

/**
 * Nhận thông báo đẩy từ TikTok Shop khi đơn thay đổi.
 *
 * Nguyên tắc thiết kế quan trọng nhất ở đây: **webhook chỉ là tiếng chuông, không phải
 * nguồn dữ liệu.** Payload của TikTok chỉ có `order_id` + `order_status`, không có tiền
 * cũng không có dòng hàng, nên dù có tin cũng chẳng ghi được đơn từ nó. Vì vậy handler
 * chỉ lấy đúng `order_id` rồi tự gọi lại TikTok bằng access token của mình để lấy đơn
 * thật. Hệ quả: kể cả khi ai đó giả mạo được request, thiệt hại tối đa là hệ thống gọi
 * thừa một lời gọi API — không thể ghi dữ liệu sai vào `orders`.
 *
 * Webhook KHÔNG thay thế cron. Sự kiện đẩy có thể rơi khi server đang deploy hoặc mạng
 * lỗi, và TikTok không bù lại; cron quét theo `update_time` mới là lưới an toàn. Webhook
 * chỉ để rút độ trễ từ "tối đa một chu kỳ cron" xuống còn vài giây.
 */
@Injectable()
export class TiktokWebhookService {
  private readonly logger = new Logger(TiktokWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sync: TiktokOrderSyncService,
  ) {}

  /**
   * Chữ ký webhook TikTok: HMAC-SHA256 khoá `app_secret` trên chuỗi `app_key + body thô`,
   * hex thường, gửi ở header `Authorization`. Lưu ý đây là công thức KHÁC với chữ ký của
   * Open API (chỗ đó có bọc `app_secret` hai đầu và ghép path + query đã sắp xếp).
   *
   * Vì chưa đối chiếu được với một sự kiện thật nào, chế độ mặc định là `log`: ghi cảnh
   * báo khi lệch nhưng vẫn xử lý. Sau khi thấy log xác nhận chữ ký khớp trên dữ liệu
   * thật, đặt `TIKTOK_WEBHOOK_VERIFY=strict` để bắt đầu từ chối request sai chữ ký.
   * Để mặc định `strict` ngay từ đầu sẽ âm thầm nuốt toàn bộ sự kiện nếu công thức lệch.
   */
  verifySignature(rawBody: string, authorization?: string): boolean {
    const appKey = process.env.TIKTOK_APP_KEY?.trim();
    const appSecret = process.env.TIKTOK_APP_SECRET?.trim();
    if (!appKey || !appSecret || !authorization) return false;

    const expected = createHmac('sha256', appSecret)
      .update(`${appKey}${rawBody}`)
      .digest('hex');

    const a = Buffer.from(expected);
    const b = Buffer.from(authorization.trim());
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** `strict` = từ chối khi chữ ký sai. Mặc định `log` — xem ghi chú ở `verifySignature`. */
  isStrict(): boolean {
    return process.env.TIKTOK_WEBHOOK_VERIFY === 'strict';
  }

  /**
   * Trả về nhanh cho TikTok rồi mới xử lý: TikTok coi phản hồi chậm là thất bại và sẽ gửi
   * lại, gây xử lý chồng chéo. Việc ghi đơn chạy nền, lỗi thì cron vá sau.
   */
  async handleNotification(
    payload: TiktokWebhookPayload,
    signatureValid: boolean,
  ) {
    // Dòng log này là căn cứ để quyết định có bật `strict` được chưa — thấy "khớp" trên
    // vài sự kiện thật thì công thức chữ ký đã đúng.
    this.logger.log(
      `Webhook TikTok type=${payload?.type} chữ ký ${signatureValid ? 'khớp' : 'KHÔNG khớp'}${
        this.isStrict() ? '' : ' (đang ở chế độ log, chưa chặn)'
      }`,
    );

    const orderId = payload?.data?.order_id;
    if (!orderId) {
      this.logger.warn(
        `Webhook TikTok không có order_id (type=${payload?.type}), bỏ qua`,
      );
      return { accepted: false };
    }

    const actorId = await resolveChannelSyncActorId(this.prisma);
    if (!actorId) {
      this.logger.error(
        'Webhook TikTok: không tìm được user đồng bộ để gán làm người tạo đơn',
      );
      return { accepted: false };
    }

    // Không await: phản hồi HTTP phải về trước khi TikTok hết kiên nhẫn
    void this.sync
      .syncOrderIds([orderId], actorId)
      .then((r) =>
        this.logger.log(
          `Webhook TikTok đơn ${orderId}: +${r.created} mới, ${r.updated} cập nhật`,
        ),
      )
      .catch((e) =>
        this.logger.error(
          `Webhook TikTok đơn ${orderId} lỗi: ${e?.message ?? e} — cron sẽ vá lại`,
        ),
      );

    return { accepted: true };
  }
}

/**
 * Hình dạng thông báo TikTok Shop. Cố tình khai lỏng: đây là dữ liệu từ bên ngoài và
 * handler chỉ đọc đúng `data.order_id`, mọi trường khác không được tin dùng.
 */
export type TiktokWebhookPayload = {
  type?: number;
  shop_id?: string;
  timestamp?: number;
  data?: {
    order_id?: string;
    order_status?: string;
    update_time?: number;
  };
};
