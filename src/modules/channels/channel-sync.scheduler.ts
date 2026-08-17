import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { UserRole } from '@prisma/client';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { ChannelSyncService } from './channel-sync.service';

@Injectable()
export class ChannelSyncScheduler {
  private readonly logger = new Logger(ChannelSyncScheduler.name);

  constructor(
    private readonly sync: ChannelSyncService,
    private readonly prisma: PrismaService,
  ) {}

  @Cron(process.env.CHANNEL_SYNC_CRON ?? CronExpression.EVERY_10_MINUTES)
  async pollPendingOrders() {
    if (process.env.CHANNEL_SYNC_CRON_ENABLED !== 'true') return;

    const admin = await this.prisma.user.findFirst({
      where: { email: 'admin@local.dev', active: true },
    });
    if (!admin) {
      this.logger.warn('Channel sync cron: admin@local.dev not found');
      return;
    }

    const user: AuthUser = {
      userId: admin.id,
      email: admin.email,
      roles: [UserRole.admin],
      locationIds: [],
    };

    try {
      const result = await this.sync.syncConnectedChannels(user);
      this.logger.log(
        `Channel sync cron: pending ${result.pending.synced}/${result.pending.results.length}, shopee ${result.shopee.synced}`,
      );
    } catch (e) {
      this.logger.error(
        'Channel sync cron failed',
        e instanceof Error ? e.stack : e,
      );
    }
  }
}
