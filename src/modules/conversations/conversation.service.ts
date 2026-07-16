import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { findConversationIdsByQuery } from '../../common/search/unaccent-search';
import {
  CreateConversationDto,
  CreateMessageDto,
  ListConversationsQueryDto,
} from './conversation.dto';

@Injectable()
export class ConversationService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ListConversationsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Prisma.ConversationWhereInput = {};
    if (query.search?.trim()) {
      const ids = await findConversationIdsByQuery(
        this.prisma,
        query.search.trim(),
      );
      where.id = { in: ids };
    }

    const [rows, total] = await Promise.all([
      this.prisma.conversation.findMany({
        where,
        orderBy: { lastMessageAt: 'desc' },
        skip,
        take: limit,
        include: {
          messages: {
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
        },
      }),
      this.prisma.conversation.count({ where }),
    ]);

    return {
      data: rows.map((c) => this.mapConversation(c)),
      meta: { page, limit, total },
    };
  }

  async findOne(id: bigint) {
    const row = await this.prisma.conversation.findUnique({
      where: { id },
      include: {
        messages: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!row) throw new NotFoundException('Conversation not found');
    return { data: this.mapConversationDetail(row) };
  }

  async create(dto: CreateConversationDto) {
    const row = await this.prisma.conversation.create({
      data: {
        customerName: dto.customer_name,
        customerPhone: dto.customer_phone,
        channel: (dto.channel as Prisma.ConversationCreateInput['channel']) ?? 'other',
        customerId: dto.customer_id ? BigInt(dto.customer_id) : undefined,
        assignedToId: dto.assigned_to ? BigInt(dto.assigned_to) : undefined,
      },
      include: {
        messages: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });
    return { data: this.mapConversation(row) };
  }

  async addMessage(
    conversationId: bigint,
    dto: CreateMessageDto,
    userId: bigint,
  ) {
    const exists = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
    });
    if (!exists) throw new NotFoundException('Conversation not found');

    const senderType = dto.sender_type ?? 'staff';
    const msg = await this.prisma.conversationMessage.create({
      data: {
        conversationId,
        body: dto.body,
        senderType,
        createdById: senderType === 'staff' ? userId : undefined,
      },
    });

    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { lastMessageAt: msg.createdAt },
    });

    return {
      data: {
        id: msg.id.toString(),
        sender_type: msg.senderType,
        body: msg.body,
        created_at: msg.createdAt.toISOString(),
      },
    };
  }

  private mapConversation(
    c: Prisma.ConversationGetPayload<{
      include: { messages: true };
    }>,
  ) {
    const last = c.messages[0];
    return {
      id: c.id.toString(),
      channel: c.channel,
      customer_name: c.customerName,
      customer_phone: c.customerPhone,
      customer_id: c.customerId?.toString() ?? null,
      assigned_to: c.assignedToId?.toString() ?? null,
      last_message_at: c.lastMessageAt.toISOString(),
      last_message: last
        ? {
            body: last.body,
            sender_type: last.senderType,
            created_at: last.createdAt.toISOString(),
          }
        : null,
    };
  }

  private mapConversationDetail(
    c: Prisma.ConversationGetPayload<{ include: { messages: true } }>,
  ) {
    return {
      ...this.mapConversation(c),
      messages: c.messages.map((m) => ({
        id: m.id.toString(),
        sender_type: m.senderType,
        body: m.body,
        created_at: m.createdAt.toISOString(),
      })),
    };
  }
}
