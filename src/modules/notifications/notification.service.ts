import { Injectable, Logger } from '@nestjs/common';
import { NotificationSetting, NotificationTopic, Prisma } from '@prisma/client';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { BusinessException } from '../../common/exceptions/business.exception';
import { PrismaService } from '../../prisma/prisma.service';
import { RbacService } from '../rbac/rbac.service';
import {
  ListNotificationsQueryDto,
  UpdateNotificationSettingDto,
} from './notification.dto';
import {
  serializeNotification,
  serializeNotificationSetting,
  TOPIC_FROM_WIRE,
} from './notification.serializer';

/**
 * Dữ liệu một sự kiện cần báo. `title` render sẵn tiếng Việt ngay lúc emit.
 *
 * `location` dùng cho thông báo TỔNG HỢP theo kho (cảnh báo tồn kho): `subjectId` là id
 * kho chứ không phải một bản ghi đơn lẻ, danh sách SKU nằm trong `payload.variant_ids`.
 */
export type EmitInput = {
  subjectType:
    | 'order'
    | 'fulfillment'
    | 'customer'
    | 'order_refund'
    | 'location';
  subjectId: bigint;
  locationId: bigint | null;
  title: string;
  payload?: Prisma.InputJsonValue;
};

const DEFAULT_LIMIT = 20;
/** Cache cấu hình topic — `emit` nằm trên đường tạo đơn, không nên tốn 1 query mỗi lần. */
const SETTINGS_TTL_MS = 60_000;

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  private settingsCache: Map<NotificationTopic, NotificationSetting> | null =
    null;
  private settingsCachedAt = 0;

  constructor(
    private prisma: PrismaService,
    private rbac: RbacService,
  ) {}

  // --- Ghi ---

  /**
   * Sinh thông báo cho một sự kiện và fan-out tới người nhận.
   *
   * Hai ràng buộc BẮT BUỘC ở mọi nơi gọi hàm này:
   * 1. Gọi NGOÀI `prisma.$transaction`. Trong transaction thì fan-out chậm sẽ giữ lock
   *    hàng đơn hàng, và tx rollback vẫn để lại thông báo ma trỏ tới bản ghi không tồn tại.
   * 2. Không `await` chặn nghiệp vụ. Hàm này tự nuốt mọi lỗi (không bao giờ throw) —
   *    thông báo hỏng tuyệt đối không được làm hỏng việc tạo/huỷ đơn. Cùng cách
   *    AuditInterceptor đang xử lý activity log.
   */
  async emit(topic: NotificationTopic, input: EmitInput): Promise<void> {
    try {
      const setting = await this.getSetting(topic);
      // Chưa seed cấu hình cho topic ⇒ coi như tắt, chứ không mặc định bật:
      // thà thiếu thông báo còn hơn spam sai người vì chưa ai chọn người nhận.
      if (!setting?.appEnabled) return;

      const userIds = await this.rbac.usersWithPermissions(
        setting.recipientPermissions,
        input.locationId,
      );
      if (!userIds.length) return;

      await this.prisma.notification.create({
        data: {
          topic,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          locationId: input.locationId,
          title: input.title,
          payload: input.payload,
          recipients: {
            createMany: {
              data: userIds.map((userId) => ({ userId })),
              skipDuplicates: true,
            },
          },
        },
      });
    } catch (e) {
      // Nuốt lỗi có chủ đích — nhưng vẫn log để còn phát hiện khi thông báo im lặng.
      this.logger.error(
        `emit(${topic}) thất bại cho ${input.subjectType}#${input.subjectId}`,
        e instanceof Error ? e.stack : String(e),
      );
    }
  }

  // --- Đọc ---

  /**
   * Phân trang keyset theo `notification_id` giảm dần thay vì skip/take: bảng này chỉ
   * lớn lên theo thời gian, offset lớn sẽ ngày càng chậm.
   */
  async list(user: AuthUser, query: ListNotificationsQueryDto) {
    // Number() phòng trường hợp query param tới đây còn là chuỗi (ValidationPipe chưa
    // gắn ở một app context nào đó): `"50" + 1` = `"501"` và Prisma ném lỗi 500.
    const limit = Number(query.limit) || DEFAULT_LIMIT;

    // Lớp chặn thứ hai sau `@Matches` ở DTO: `BigInt("abc")` ném SyntaxError không ai
    // bắt ⇒ 500. Ở đây chỉ nhận chuỗi toàn chữ số, còn lại coi như không truyền.
    const beforeId =
      query.before_id && /^\d+$/.test(query.before_id)
        ? BigInt(query.before_id)
        : null;

    const rows = await this.prisma.notificationRecipient.findMany({
      where: {
        userId: user.userId, // chốt chặn duy nhất giữ thông báo riêng tư giữa các user
        ...(query.unread_only ? { readOn: null } : {}),
        ...(beforeId !== null ? { notificationId: { lt: beforeId } } : {}),
        ...(query.topic ? { notification: { topic: query.topic } } : {}),
      },
      include: { notification: true },
      orderBy: { notificationId: 'desc' },
      take: limit + 1, // lấy dư 1 để biết còn trang sau, không cần count()
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    return {
      data: page.map(serializeNotification),
      has_more: hasMore,
      next_before_id: hasMore
        ? page[page.length - 1].notificationId.toString()
        : null,
    };
  }

  async unreadCount(user: AuthUser) {
    const count = await this.prisma.notificationRecipient.count({
      where: { userId: user.userId, readOn: null },
    });
    return { count };
  }

  // --- Đánh dấu đã đọc ---

  async markRead(user: AuthUser, ids: string[]) {
    if (!ids.length) return { updated: 0 };

    let notificationIds: bigint[];
    try {
      notificationIds = ids.map((id) => BigInt(id));
    } catch {
      throw new BusinessException('INVALID_ID', 'Id thông báo không hợp lệ', 400);
    }

    // `userId` trong where vừa là bộ lọc vừa là kiểm quyền: không đánh dấu hộ được
    // thông báo của người khác, kể cả khi đoán đúng id.
    const res = await this.prisma.notificationRecipient.updateMany({
      where: {
        userId: user.userId,
        notificationId: { in: notificationIds },
        readOn: null,
      },
      data: { readOn: new Date() },
    });
    return { updated: res.count };
  }

  async markAllRead(user: AuthUser) {
    const res = await this.prisma.notificationRecipient.updateMany({
      where: { userId: user.userId, readOn: null },
      data: { readOn: new Date() },
    });
    return { updated: res.count };
  }

  // --- Cấu hình ---

  async getSettings() {
    const rows = await this.prisma.notificationSetting.findMany({
      orderBy: { id: 'asc' },
    });
    return { data: rows.map(serializeNotificationSetting) };
  }

  async updateSetting(topicWire: string, dto: UpdateNotificationSettingDto) {
    const topic = TOPIC_FROM_WIRE.get(topicWire);
    if (!topic) {
      throw new BusinessException(
        'NOT_FOUND',
        `Không có topic thông báo "${topicWire}"`,
        404,
      );
    }

    if (dto.recipient_permissions) {
      const known = await this.prisma.permission.findMany({
        where: { key: { in: dto.recipient_permissions } },
        select: { key: true },
      });
      const knownKeys = new Set(known.map((p) => p.key));
      const unknown = dto.recipient_permissions.filter((k) => !knownKeys.has(k));
      // Chặn ở đây vì permission sai chính tả sẽ làm fan-out lặng lẽ ra 0 người —
      // topic vẫn "bật" trên UI nhưng không ai nhận được gì, rất khó lần ra.
      if (unknown.length) {
        throw new BusinessException(
          'INVALID_PERMISSION',
          `Quyền không tồn tại: ${unknown.join(', ')}`,
          400,
        );
      }
    }

    const updated = await this.prisma.notificationSetting.update({
      where: { topic },
      data: {
        ...(dto.app_enabled !== undefined ? { appEnabled: dto.app_enabled } : {}),
        ...(dto.email_enabled !== undefined
          ? { emailEnabled: dto.email_enabled }
          : {}),
        ...(dto.recipient_permissions
          ? { recipientPermissions: dto.recipient_permissions }
          : {}),
      },
    });

    this.invalidateSettingsCache();
    return serializeNotificationSetting(updated);
  }

  /**
   * Topic này có đang bật không. Dành cho nơi phải làm việc NẶNG trước khi gọi `emit`
   * (quét tồn kho mất ~47s cho 14 kho) — hỏi trước để không tốn công khi topic đã tắt.
   */
  async isTopicEnabled(topic: NotificationTopic): Promise<boolean> {
    return (await this.getSetting(topic))?.appEnabled === true;
  }

  /** Public để test gọi được sau khi sửa thẳng cấu hình trong DB. */
  invalidateSettingsCache() {
    this.settingsCache = null;
    this.settingsCachedAt = 0;
  }

  private async getSetting(
    topic: NotificationTopic,
  ): Promise<NotificationSetting | undefined> {
    const now = Date.now();
    if (!this.settingsCache || now - this.settingsCachedAt > SETTINGS_TTL_MS) {
      const rows = await this.prisma.notificationSetting.findMany();
      this.settingsCache = new Map(rows.map((r) => [r.topic, r]));
      this.settingsCachedAt = now;
    }
    return this.settingsCache.get(topic);
  }
}
