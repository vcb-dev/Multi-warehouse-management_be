import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { serializeActivityLog } from './activity-log.serializer';

@Injectable()
export class ActivityLogService {
  constructor(private prisma: PrismaService) {}

  async getHistory(entityType: string, entityId: bigint) {
    const rows = await this.prisma.activityLog.findMany({
      where: { entityType, entityId },
      include: {
        user: { select: { firstName: true, lastName: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return { data: rows.map(serializeActivityLog) };
  }
}
