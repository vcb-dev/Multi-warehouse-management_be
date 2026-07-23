import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

const orderInclude = {
  items: {
    include: { variant: { select: { productId: true, imageUrl: true, unit: true } } },
  },
  customer: true,
  branch: {
    select: {
      code: true,
      name: true,
      phone: true,
      address: true,
      ward: true,
      district: true,
      province: true,
    },
  },
  assignedTo: { select: { id: true, name: true, email: true } },
  createdBy: { select: { id: true, name: true, email: true } },
  fulfillments: {
    orderBy: { id: 'desc' },
    include: {
      packer: { select: { id: true, name: true, email: true } },
      provider: { select: { id: true, code: true, name: true, type: true } },
      fromBranch: { select: { id: true, code: true, name: true } },
    },
  },
} satisfies Prisma.OrderInclude;

export type OrderWithRelations = Prisma.OrderGetPayload<{
  include: typeof orderInclude;
}>;

@Injectable()
export class OrderRepository {
  constructor(private prisma: PrismaService) {}

  findMany(args: Prisma.OrderFindManyArgs) {
    return this.prisma.order.findMany(args);
  }

  count(where: Prisma.OrderWhereInput) {
    return this.prisma.order.count({ where });
  }

  findById(id: bigint) {
    return this.prisma.order.findUnique({
      where: { id },
      include: orderInclude,
    });
  }

  findByCode(code: string) {
    return this.prisma.order.findUnique({ where: { code } });
  }

  get client() {
    return this.prisma;
  }
}

export { orderInclude };
