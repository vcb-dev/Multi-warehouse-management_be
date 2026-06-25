import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/permissions.decorator';
import { PrismaService } from '../../prisma/prisma.service';

@ApiTags('customers')
@ApiBearerAuth()
@Controller('customers')
export class CustomersController {
  constructor(private prisma: PrismaService) {}

  @Get()
  @RequirePermission('customer:view')
  async search(@Query('q') q?: string) {
    const term = q?.trim();
    const rows = await this.prisma.customer.findMany({
      where: term
        ? {
            OR: [
              { phone: { contains: term } },
              { email: { contains: term, mode: 'insensitive' } },
              { firstName: { contains: term, mode: 'insensitive' } },
              { lastName: { contains: term, mode: 'insensitive' } },
            ],
          }
        : undefined,
      take: 20,
      orderBy: { id: 'desc' },
    });
    return {
      data: rows.map((c) => ({
        id: c.id.toString(),
        first_name: c.firstName,
        last_name: c.lastName,
        phone: c.phone,
        email: c.email,
        label: [c.firstName, c.lastName].filter(Boolean).join(' ') || c.phone || c.email,
      })),
    };
  }
}
