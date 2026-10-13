import { Injectable, NotFoundException } from '@nestjs/common';
import { CarrierTicketCategory, Prisma } from '@prisma/client';
import {
  assertLocationPermission,
  locationScopeFilter,
} from '../../common/auth/access';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { BusinessException } from '../../common/exceptions/business.exception';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateCarrierTicketDto,
  ReplyCarrierTicketDto,
} from './fulfillment.dto';

const CATEGORY_LABEL: Record<CarrierTicketCategory, string> = {
  [CarrierTicketCategory.tu_van]: 'Tư vấn',
  [CarrierTicketCategory.hoi_giao_lay_tra_hang]: 'Hối Giao/Lấy/Trả hàng',
  [CarrierTicketCategory.thay_doi_thong_tin]: 'Thay đổi thông tin',
  [CarrierTicketCategory.khieu_nai]: 'Khiếu nại',
};

/** Chưa hãng nào đang tích hợp có API ticket — các thao tác gửi sang hãng đều dừng ở đây. */
function ticketApiUnavailable(): never {
  throw new BusinessException(
    'VALIDATION_ERROR',
    'Hiện chưa có hãng vận chuyển nào hỗ trợ ticket qua API',
    422,
  );
}

/**
 * Phiếu hỗ trợ mở với hãng vận chuyển. Sapo không có khái niệm này nên bảng
 * `carrier_tickets` là của riêng dự án. Hãng duy nhất từng nối API ticket (GHN) đã gỡ:
 * giữ lại bảng, phần đọc và các route để nối hãng khác sau, còn tạo/trả lời/đồng bộ thì
 * báo lỗi rõ ràng thay vì âm thầm không làm gì.
 */
@Injectable()
export class CarrierTicketService {
  constructor(private prisma: PrismaService) {}

  async list(user: AuthUser, fulfillmentId?: string) {
    const tickets = await this.prisma.carrierTicket.findMany({
      where: {
        ...(fulfillmentId ? { fulfillmentId: BigInt(fulfillmentId) } : {}),
        // Chỉ ticket của đơn thuộc kho user được phép xem; ticket chưa map được vận đơn
        // (orderId null) thì không thuộc kho nào nên ẩn khỏi danh sách thường
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
      include: { order: true },
    });
    if (!fulfillment) throw new NotFoundException('Không tìm thấy vận đơn');
    assertLocationPermission(user, 'order:pack', fulfillment.order.locationId);
    return ticketApiUnavailable();
  }

  async reply(id: bigint, _dto: ReplyCarrierTicketDto, _user: AuthUser) {
    await this.byId(id);
    return ticketApiUnavailable();
  }

  syncFromCarrier() {
    return ticketApiUnavailable();
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
    category_label: CATEGORY_LABEL[t.category],
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
