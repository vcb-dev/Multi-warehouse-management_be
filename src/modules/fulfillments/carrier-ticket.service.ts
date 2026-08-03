import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  CarrierTicketCategory,
  CarrierTicketStatus,
  Prisma,
} from '@prisma/client';
import {
  assertLocationPermission,
  locationScopeFilter,
} from '../../common/auth/access';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { BusinessException } from '../../common/exceptions/business.exception';
import { PrismaService } from '../../prisma/prisma.service';
import { CarrierConnectionConfig } from './carriers/carrier-adapter';
import { GhnTicket } from './carriers/ghn.client';
import {
  CreateCarrierTicketDto,
  GhnTicketCallbackDto,
  ReplyCarrierTicketDto,
} from './fulfillment.dto';
import {
  GHN_PROVIDER_CODE,
  ShippingProviderService,
} from './shipping-provider.service';

/** Nhóm ticket của app ↔ chuỗi tiếng Việt mà API GHN nhận/trả về. */
const CATEGORY_TO_GHN: Record<CarrierTicketCategory, string> = {
  [CarrierTicketCategory.tu_van]: 'Tư vấn',
  [CarrierTicketCategory.hoi_giao_lay_tra_hang]: 'Hối Giao/Lấy/Trả hàng',
  [CarrierTicketCategory.thay_doi_thong_tin]: 'Thay đổi thông tin',
  [CarrierTicketCategory.khieu_nai]: 'Khiếu nại',
};

const GHN_TO_CATEGORY = new Map<string, CarrierTicketCategory>(
  Object.entries(CATEGORY_TO_GHN).map(([k, v]) => [
    normalize(v),
    k as CarrierTicketCategory,
  ]),
);

/** GHN trả trạng thái dạng "1 - Đang xử lý"; ưu tiên đọc số vì phần chữ hay đổi. */
const STATUS_BY_ID: Record<number, CarrierTicketStatus> = {
  1: CarrierTicketStatus.dang_xu_ly,
  2: CarrierTicketStatus.cho_phan_hoi,
  3: CarrierTicketStatus.hoan_thanh,
};

function normalize(s: string) {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function parseStatus(
  status?: string | null,
  statusId?: number | null,
): CarrierTicketStatus {
  if (statusId && STATUS_BY_ID[statusId]) return STATUS_BY_ID[statusId];
  const leading = Number(status?.trim().match(/^(\d+)/)?.[1]);
  if (leading && STATUS_BY_ID[leading]) return STATUS_BY_ID[leading];
  const text = normalize(status ?? '');
  if (text.includes('hoan thanh')) return CarrierTicketStatus.hoan_thanh;
  if (text.includes('cho kh') || text.includes('phan hoi')) {
    return CarrierTicketStatus.cho_phan_hoi;
  }
  return CarrierTicketStatus.dang_xu_ly;
}

function parseCategory(type?: string | null): CarrierTicketCategory {
  return (
    GHN_TO_CATEGORY.get(normalize(type ?? '')) ?? CarrierTicketCategory.tu_van
  );
}

function parseDate(v?: string | null): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toJson(v: unknown): Prisma.InputJsonValue | undefined {
  if (v == null) return undefined;
  return v as Prisma.InputJsonValue;
}

/**
 * Phiếu hỗ trợ mở với hãng vận chuyển (GHN `ticket/create`, `ticket/reply`, `ticket/index`
 * + callback). Sapo không có khái niệm này nên bảng `carrier_tickets` là của riêng dự án.
 */
@Injectable()
export class CarrierTicketService {
  private readonly logger = new Logger(CarrierTicketService.name);

  constructor(
    private prisma: PrismaService,
    private providers: ShippingProviderService,
  ) {}

  async list(user: AuthUser, fulfillmentId?: string) {
    const tickets = await this.prisma.carrierTicket.findMany({
      where: {
        ...(fulfillmentId ? { fulfillmentId: BigInt(fulfillmentId) } : {}),
        // Chỉ ticket của đơn thuộc kho user được phép xem; ticket callback chưa map được
        // vận đơn (orderId null) thì không thuộc kho nào nên ẩn khỏi danh sách thường
        order: { locationId: locationScopeFilter(user, 'order:pack') },
      },
      include: { messages: { orderBy: { externalCreatedAt: 'asc' } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return { data: tickets.map(serializeTicket) };
  }

  async create(dto: CreateCarrierTicketDto, user: AuthUser) {
    const fulfillment = await this.prisma.fulfillment.findUnique({
      where: { id: BigInt(dto.fulfillment_id) },
      include: { order: true, provider: true },
    });
    if (!fulfillment) throw new NotFoundException('Không tìm thấy vận đơn');
    assertLocationPermission(user, 'order:pack', fulfillment.order.locationId);

    if (!fulfillment.trackingNumber) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        'Vận đơn chưa có mã của hãng nên chưa mở được ticket',
        422,
      );
    }
    const provider = fulfillment.provider;
    if (!provider || provider.code !== GHN_PROVIDER_CODE) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        'Hiện chỉ GHN hỗ trợ mở ticket qua API',
        422,
      );
    }

    const config = (provider.connectionConfig ?? {}) as CarrierConnectionConfig;
    if (!config.token) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        'GHN chưa được kết nối',
        422,
      );
    }

    const category = CarrierTicketCategory[dto.category];
    const created = await this.providers.ghn.createTicket(
      {
        order_code: fulfillment.trackingNumber,
        category: CATEGORY_TO_GHN[category],
        description: dto.description,
        ...(dto.contact_email ? { c_email: dto.contact_email } : {}),
      },
      { token: config.token },
    );

    if (created?.id == null) {
      throw new BusinessException(
        'CARRIER_ERROR',
        'GHN không trả về mã ticket',
        502,
      );
    }

    const ticket = await this.prisma.carrierTicket.create({
      data: {
        providerId: provider.id,
        fulfillmentId: fulfillment.id,
        orderId: fulfillment.orderId,
        externalId: String(created.id),
        orderCode: fulfillment.trackingNumber,
        category,
        status: parseStatus(created.status, created.status_id),
        statusRaw: created.status ?? null,
        description: dto.description,
        contactEmail: dto.contact_email ?? created.c_email ?? null,
        contactName: created.c_name ?? null,
        contactPhone: created.c_phone != null ? String(created.c_phone) : null,
        createdById: user.userId,
        externalCreatedAt: parseDate(created.created_at),
        externalUpdatedAt: parseDate(created.updated_at),
        syncedAt: new Date(),
        attachments: toJson(created.attachments),
      },
    });

    await this.prisma.activityLog.create({
      data: {
        userId: user.userId,
        action: 'carrier_ticket.create',
        entityType: 'order',
        entityId: fulfillment.orderId,
        metadata: {
          fulfillment_code: fulfillment.name,
          order_code: fulfillment.trackingNumber,
          category: CATEGORY_TO_GHN[category],
          external_id: String(created.id),
        },
      },
    });

    return this.byId(ticket.id);
  }

  async reply(id: bigint, dto: ReplyCarrierTicketDto, user: AuthUser) {
    const ticket = await this.prisma.carrierTicket.findUnique({
      where: { id },
      include: { provider: true },
    });
    if (!ticket) throw new NotFoundException('Không tìm thấy ticket');

    const config = (ticket.provider.connectionConfig ??
      {}) as CarrierConnectionConfig;
    if (!config.token) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        'GHN chưa được kết nối',
        422,
      );
    }

    const replied = await this.providers.ghn.replyTicket(
      { ticket_id: ticket.externalId, description: dto.description },
      { token: config.token },
    );

    await this.prisma.carrierTicketMessage.create({
      data: {
        ticketId: ticket.id,
        senderType: 'shop',
        body: dto.description,
        fromEmail: replied?.from_email ?? null,
        externalCreatedAt: parseDate(replied?.created_at) ?? new Date(),
      },
    });

    await this.prisma.activityLog.create({
      data: {
        userId: user.userId,
        action: 'carrier_ticket.reply',
        entityType: 'order',
        entityId: ticket.orderId ?? 0n,
        metadata: {
          external_id: ticket.externalId,
          order_code: ticket.orderCode,
        },
      },
    });

    return this.byId(ticket.id);
  }

  /**
   * Callback ticket của GHN. Cũng như webhook đơn hàng: luôn trả 200 để GHN không retry
   * 10 lần cho những ca vô hại (ticket lạ, chưa map được vận đơn).
   */
  async handleCallback(dto: GhnTicketCallbackDto) {
    if (dto.id == null) return { received: true };

    const provider = await this.prisma.shippingProvider.findUnique({
      where: { code: GHN_PROVIDER_CODE },
    });
    if (!provider) {
      this.logger.warn(
        'Callback ticket GHN: chưa có shipping_provider code=ghn',
      );
      return { received: true };
    }

    const config = (provider.connectionConfig ?? {}) as CarrierConnectionConfig;
    if (
      dto.client_id != null &&
      config.client_id &&
      String(dto.client_id) !== String(config.client_id)
    ) {
      this.logger.warn(
        `Callback ticket GHN: client_id ${dto.client_id} không khớp cấu hình, bỏ qua`,
      );
      return { received: true };
    }

    await this.upsertFromGhn(provider.id, dto as GhnTicket);
    return { received: true };
  }

  /** Đồng bộ lại toàn bộ ticket từ GHN — dùng khi nghi callback bị mất. */
  async syncFromCarrier() {
    const provider = await this.prisma.shippingProvider.findUnique({
      where: { code: GHN_PROVIDER_CODE },
    });
    const config = (provider?.connectionConfig ??
      {}) as CarrierConnectionConfig;
    if (!provider || !config.token || !config.shop_id) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        'GHN chưa được kết nối',
        422,
      );
    }

    const tickets = await this.providers.ghn.getTickets({
      token: config.token,
      shopId: config.shop_id,
    });
    let synced = 0;
    for (const t of tickets ?? []) {
      if (t?.id == null) continue;
      await this.upsertFromGhn(provider.id, t);
      synced++;
    }
    return { synced };
  }

  /**
   * Upsert theo `external_id` (GHN `id`) và thay toàn bộ `conversations[]` — GHN gửi lại cả
   * luồng mỗi lần, nên delete+create tránh trùng lặp mà không cần khoá tự nhiên cho từng dòng.
   */
  private async upsertFromGhn(providerId: bigint, t: GhnTicket) {
    const externalId = String(t.id);
    const orderCode = t.order_code ?? '';

    // Vận đơn tương ứng (nếu callback đến trước khi tạo ticket từ app)
    const fulfillment = orderCode
      ? await this.prisma.fulfillment.findFirst({
          where: { trackingNumber: orderCode },
          orderBy: { id: 'desc' },
          select: { id: true, orderId: true },
        })
      : null;

    const shared = {
      status: parseStatus(t.status, t.status_id),
      statusRaw: t.status ?? null,
      category: parseCategory(t.type),
      contactName: t.c_name ?? null,
      contactEmail: t.c_email ?? null,
      contactPhone: t.c_phone != null ? String(t.c_phone) : null,
      attachments: toJson(t.attachments),
      externalCreatedAt: parseDate(t.created_at),
      externalUpdatedAt: parseDate(t.updated_at),
      syncedAt: new Date(),
      ...(fulfillment
        ? { fulfillmentId: fulfillment.id, orderId: fulfillment.orderId }
        : {}),
    };

    const ticket = await this.prisma.carrierTicket.upsert({
      where: { externalId },
      create: {
        providerId,
        externalId,
        orderCode,
        description: t.description ?? '',
        ...shared,
      },
      update: {
        // `description` do GHN giữ nguyên bản gốc — cập nhật cho khớp
        ...(t.description ? { description: t.description } : {}),
        ...shared,
      },
    });

    if (Array.isArray(t.conversations)) {
      await this.prisma.$transaction([
        this.prisma.carrierTicketMessage.deleteMany({
          where: { ticketId: ticket.id },
        }),
        this.prisma.carrierTicketMessage.createMany({
          data: t.conversations.map((c) => ({
            ticketId: ticket.id,
            // GHN không nói rõ ai gửi; email của mình → shop, còn lại coi là hãng
            senderType:
              c.from_email &&
              shared.contactEmail &&
              c.from_email === shared.contactEmail
                ? 'shop'
                : 'carrier',
            body: c.body ?? '',
            fromEmail: c.from_email ?? null,
            attachments: toJson(c.attachments),
            externalCreatedAt: parseDate(c.created_at),
          })),
        }),
      ]);
    }

    return ticket;
  }

  private async byId(id: bigint) {
    const ticket = await this.prisma.carrierTicket.findUnique({
      where: { id },
      include: { messages: { orderBy: { externalCreatedAt: 'asc' } } },
    });
    if (!ticket) throw new NotFoundException('Không tìm thấy ticket');
    return serializeTicket(ticket);
  }
}

type TicketWithMessages = Prisma.CarrierTicketGetPayload<{
  include: { messages: true };
}>;

function serializeTicket(t: TicketWithMessages) {
  return {
    id: t.id.toString(),
    external_id: t.externalId,
    fulfillment_id: t.fulfillmentId?.toString() ?? null,
    order_id: t.orderId?.toString() ?? null,
    order_code: t.orderCode,
    category: t.category,
    category_label: CATEGORY_TO_GHN[t.category],
    status: t.status,
    status_raw: t.statusRaw,
    description: t.description,
    attachments: t.attachments ?? null,
    contact_name: t.contactName,
    contact_email: t.contactEmail,
    contact_phone: t.contactPhone,
    external_created_at: t.externalCreatedAt,
    external_updated_at: t.externalUpdatedAt,
    synced_at: t.syncedAt,
    created_at: t.createdAt,
    messages: t.messages.map((m) => ({
      id: m.id.toString(),
      sender_type: m.senderType,
      from_email: m.fromEmail,
      body: m.body,
      attachments: m.attachments ?? null,
      created_at: m.externalCreatedAt ?? m.createdAt,
    })),
  };
}
