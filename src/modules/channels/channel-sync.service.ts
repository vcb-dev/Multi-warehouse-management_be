import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as path from 'path';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { ChannelWebhookDto } from '../orders/order.dto';
import { OrderService } from '../orders/order.service';
import { PrismaService } from '../../prisma/prisma.service';

type PendingChannelOrder = ChannelWebhookDto & { external_id: string };

@Injectable()
export class ChannelSyncService {
  private readonly logger = new Logger(ChannelSyncService.name);

  constructor(
    private prisma: PrismaService,
    private orders: OrderService,
  ) {}

  async handleWebhook(dto: ChannelWebhookDto, user: AuthUser) {
    let customerId: bigint | undefined;
    if (dto.customer_phone) {
      const existing = await this.prisma.customer.findFirst({
        where: { phone: dto.customer_phone.trim() },
      });
      if (existing) {
        customerId = existing.id;
      } else {
        const created = await this.prisma.customer.create({
          data: {
            phone: dto.customer_phone.trim(),
            firstName: dto.customer_name?.trim() || null,
          },
        });
        customerId = created.id;
      }
    }

    const result = await this.orders.create(
      {
        location_id: dto.location_id,
        source_name: dto.source,
        customer_id: customerId?.toString(),
        phone: dto.customer_phone,
        items: dto.items,
      },
      user,
    );

    return { order_id: result.id, code: result.code, status: result.status };
  }

  /** Đồng bộ đơn chờ từ kênh đã kết nối (file queue hoặc env) */
  async syncConnectedChannels(user: AuthUser) {
    const pending = await this.loadPendingOrders();
    const results: {
      external_id: string;
      order_id?: string;
      code?: string;
      error?: string;
    }[] = [];
    const remaining: PendingChannelOrder[] = [];

    for (const dto of pending) {
      try {
        const res = await this.handleWebhook(dto, user);
        results.push({
          external_id: dto.external_id,
          order_id: res.order_id,
          code: res.code,
        });
      } catch (e) {
        results.push({
          external_id: dto.external_id,
          error: e instanceof Error ? e.message : 'Lỗi không xác định',
        });
        remaining.push(dto);
      }
    }

    if (!process.env.CHANNEL_SYNC_PENDING_JSON) {
      await this.savePendingOrders(remaining);
    }

    this.logger.log(`Synced ${results.filter((r) => r.order_id).length} pending channel orders`);
    return { synced: results.filter((r) => r.order_id).length, results };
  }

  private queueFilePath(): string {
    return (
      process.env.CHANNEL_SYNC_QUEUE_FILE ??
      path.join(process.cwd(), 'data', 'channel-pending-orders.json')
    );
  }

  private async savePendingOrders(orders: PendingChannelOrder[]) {
    const filePath = this.queueFilePath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(orders, null, 2));
  }

  private async loadPendingOrders(): Promise<PendingChannelOrder[]> {
    const fromEnv = process.env.CHANNEL_SYNC_PENDING_JSON;
    if (fromEnv) {
      try {
        return JSON.parse(fromEnv) as PendingChannelOrder[];
      } catch {
        this.logger.warn('CHANNEL_SYNC_PENDING_JSON không hợp lệ');
      }
    }

    const filePath = this.queueFilePath();
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      return JSON.parse(raw) as PendingChannelOrder[];
    } catch {
      return [];
    }
  }
}
