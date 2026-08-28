import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

const orderInclude = {
  items: {
    include: {
      variant: { select: { productId: true, imageUrl: true, unit: true } },
    },
  },
  customer: true,
  location: {
    select: {
      code: true,
      name: true,
      phone: true,
      address1: true,
      ward: true,
      district: true,
      province: true,
    },
  },
  assignedTo: {
    select: { id: true, firstName: true, lastName: true, email: true },
  },
  createdBy: {
    select: { id: true, firstName: true, lastName: true, email: true },
  },
  fulfillments: {
    orderBy: { id: 'desc' },
    include: {
      packer: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
      provider: { select: { id: true, code: true, name: true, type: true } },
      location: { select: { id: true, code: true, name: true } },
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
    return this.prisma.order.findUnique({ where: { name: code } });
  }

  /**
   * Khoá dòng đơn và đọc lại số tiền NGAY TRONG transaction thanh toán. Đọc ngoài
   * transaction rồi ghi `total_received = <giá trị đã đọc> + tiền thu` là lost update:
   * hai lần bấm "Nhận tiền" song song cùng đọc số cũ, đơn chỉ cộng một lần nhưng vẫn
   * sinh hai phiếu thu và hai bút toán công nợ.
   */
  async lockPayment(tx: Prisma.TransactionClient, id: bigint) {
    const rows = await tx.$queryRaw<
      Array<{ total_price: Prisma.Decimal; total_received: Prisma.Decimal }>
    >`
      SELECT total_price, total_received
      FROM orders
      WHERE id = ${id}
      FOR UPDATE
    `;
    return rows[0] ?? null;
  }

  get client() {
    return this.prisma;
  }
}

export { orderInclude };
