import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as path from 'path';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { ChannelWebhookDto } from '../orders/order.dto';
import { OrderService } from '../orders/order.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ShopeeSyncService } from './shopee/shopee-sync.service';

type PendingChannelOrder = ChannelWebhookDto & { external_id: string };

@Injectable()
export class ChannelSyncService {
  private readonly logger = new Logger(ChannelSyncService.name);

  constructor(
    private prisma: PrismaService,
    private orders: OrderService,
    private shopeeSync: ShopeeSyncService,
  ) {}

  /** Danh sách shop đã ủy quyền kết nối trực tiếp (TikTok Shop, Shopee...). Không trả token. */
  async listConnections() {
    const rows = await this.prisma.channelConnection.findMany({
      orderBy: { createdAt: 'desc' },
      include: { location: { select: { id: true, name: true } } },
    });
    return rows.map((r) => ({
      id: r.id.toString(),
      channel: r.channel,
      shop_id: r.shopId,
      shop_name: r.shopName,
      connected_at: r.createdAt,
      access_token_expires_at: r.accessTokenExpiresAt,
      refresh_token_expires_at: r.refreshTokenExpiresAt,
      granted_scopes_count: r.grantedScopes.length,
      location: r.location
        ? { id: r.location.id.toString(), name: r.location.name }
        : null,
    }));
  }

  async updateConnectionLocation(connectionId: string, locationId: string) {
    const id = BigInt(connectionId);
    const locId = BigInt(locationId);
    await this.prisma.location.findUniqueOrThrow({ where: { id: locId } });
    const conn = await this.prisma.channelConnection.update({
      where: { id },
      data: { locationId: locId },
      include: { location: { select: { id: true, name: true } } },
    });
    return {
      id: conn.id.toString(),
      channel: conn.channel,
      shop_id: conn.shopId,
      shop_name: conn.shopName,
      location: conn.location
        ? { id: conn.location.id.toString(), name: conn.location.name }
        : null,
    };
  }

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

  /** Đồng bộ đơn chờ từ file queue + kéo đơn Shopee đã kết nối */
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

    const shopee = await this.shopeeSync.syncShopeeOrders(user);

    this.logger.log(
      `Synced ${results.filter((r) => r.order_id).length} pending + ${shopee.synced} Shopee orders`,
    );
    return {
      pending: {
        synced: results.filter((r) => r.order_id).length,
        results,
      },
      shopee,
    };
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
