import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, StocktakeStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  BusinessException,
  InsufficientStockException,
} from '../../common/exceptions/business.exception';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import {
  assertLocationPermission,
  locationScopeFilter,
} from '../../common/auth/access';
import { InventoryService } from '../inventory/inventory.service';
import { sortForLocking } from '../inventory/inventory.types';
import {
  CreateStocktakeDto,
  ListStocktakesQueryDto,
  StocktakeItemDto,
  UpdateStocktakeDto,
} from './stocktake.dto';
import { serializeStocktake } from './stocktake.serializer';

/** Khớp @RequirePermission của các endpoint đọc trong stocktake.controller. */
const READ_PERMISSIONS = ['inventory:stocktake', 'inventory:view'];

/**
 * Cân bằng khoá tồn từng dòng nên phiếu nhiều dòng chạy lâu hơn hẳn một giao dịch thường —
 * lấy cùng ngưỡng với đường đơn hàng thay vì 5s mặc định của Prisma.
 */
const BALANCE_TX_OPTIONS = { maxWait: 15_000, timeout: 30_000 };

const stocktakeInclude = {
  items: {
    include: {
      variant: {
        select: { sku: true, cost: true, product: { select: { name: true } } },
      },
    },
    orderBy: { id: 'asc' },
  },
  location: { select: { code: true, name: true } },
  createdBy: { select: { firstName: true, lastName: true, email: true } },
  balancedBy: { select: { firstName: true, lastName: true, email: true } },
} satisfies Prisma.StocktakeInclude;

@Injectable()
export class StocktakeService {
  constructor(
    private prisma: PrismaService,
    private inventory: InventoryService,
  ) {}

  async list(query: ListStocktakesQueryDto, user: AuthUser) {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? 20;
    const where: Prisma.StocktakeWhereInput = {};

    if (query.status) where.status = query.status as StocktakeStatus;
    if (query.location_id) where.locationId = BigInt(query.location_id);

    const readable = locationScopeFilter(user, READ_PERMISSIONS);
    if (readable) where.locationId = readable;

    const [rows, total] = await Promise.all([
      this.prisma.stocktake.findMany({
        where,
        include: stocktakeInclude,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.stocktake.count({ where }),
    ]);

    return {
      data: rows.map(serializeStocktake),
      total,
      page,
      page_size: pageSize,
    };
  }

  async findOne(id: bigint, user: AuthUser) {
    const st = await this.prisma.stocktake.findUnique({
      where: { id },
      include: stocktakeInclude,
    });
    if (!st) throw new NotFoundException('Không tìm thấy phiếu kiểm hàng');
    assertLocationPermission(user, READ_PERMISSIONS, st.locationId);
    return { data: serializeStocktake(st) };
  }

  async create(dto: CreateStocktakeDto, user: AuthUser) {
    const locationId = BigInt(dto.location_id);
    assertLocationPermission(user, 'inventory:stocktake', locationId);
    await this.prisma.location.findUniqueOrThrow({ where: { id: locationId } });

    const items = this.normalizeItems(dto.items);
    if (!items.length) {
      throw new BusinessException(
        'STOCKTAKE_EMPTY',
        'Phiếu kiểm hàng phải có ít nhất một dòng',
      );
    }

    const systemQty = await this.snapshotSystemQuantities(
      locationId,
      items.map((i) => i.variantId),
    );

    const created = await this.prisma.$transaction(async (tx) => {
      const code = await this.generateCode(tx);
      const st = await tx.stocktake.create({
        data: {
          code,
          locationId,
          note: dto.note ?? null,
          createdById: user.userId,
          items: {
            create: items.map((i) => ({
              variantId: i.variantId,
              systemQuantity: systemQty.get(i.variantId.toString()) ?? 0,
              countedQuantity: i.countedQuantity,
              note: i.note,
            })),
          },
        },
        include: stocktakeInclude,
      });

      await tx.activityLog.create({
        data: {
          userId: user.userId,
          action: 'stocktake.create',
          entityType: 'stocktake',
          entityId: st.id,
          metadata: { code: st.code, line_count: items.length },
        },
      });
      return st;
    });

    return { data: serializeStocktake(created) };
  }

  async update(id: bigint, dto: UpdateStocktakeDto, user: AuthUser) {
    const st = await this.prisma.stocktake.findUnique({
      where: { id },
      select: { id: true, locationId: true, status: true, code: true },
    });
    if (!st) throw new NotFoundException('Không tìm thấy phiếu kiểm hàng');
    assertLocationPermission(user, 'inventory:stocktake', st.locationId);
    this.assertEditable(st.status);

    const items = dto.items ? this.normalizeItems(dto.items) : null;
    // Chỉ chụp tồn cho dòng MỚI thêm; dòng cũ giữ nguyên `system_quantity` đã chụp lúc tạo
    // phiếu, nếu không thì mỗi lần lưu nháp lại dời mốc và người đếm không bao giờ đối chiếu
    // được với con số họ nhìn thấy lúc bắt đầu đếm.
    const systemQty = items
      ? await this.snapshotSystemQuantities(
          st.locationId,
          items.map((i) => i.variantId),
        )
      : null;

    const updated = await this.prisma.$transaction(async (tx) => {
      if (items) {
        const keep = items.map((i) => i.variantId);
        await tx.stocktakeItem.deleteMany({
          where: { stocktakeId: id, variantId: { notIn: keep } },
        });
        for (const item of items) {
          await tx.stocktakeItem.upsert({
            where: {
              stocktakeId_variantId: {
                stocktakeId: id,
                variantId: item.variantId,
              },
            },
            create: {
              stocktakeId: id,
              variantId: item.variantId,
              systemQuantity: systemQty?.get(item.variantId.toString()) ?? 0,
              countedQuantity: item.countedQuantity,
              note: item.note,
            },
            update: {
              countedQuantity: item.countedQuantity,
              note: item.note,
            },
          });
        }
      }

      return tx.stocktake.update({
        where: { id },
        data: { ...(dto.note !== undefined ? { note: dto.note } : {}) },
        include: stocktakeInclude,
      });
    });

    return { data: serializeStocktake(updated) };
  }

  /**
   * Cân bằng: kéo `on_hand` của từng dòng đã đếm về đúng số đếm, sinh movement `adjust`
   * mang `reference_type = 'stocktake'`.
   *
   * Cả phiếu chạy trong MỘT transaction: cân bằng một nửa rồi lỗi sẽ để lại phiếu vừa
   * "đã cân bằng" vừa còn lệch, không ai đối chiếu nổi. Thà bắt sửa dòng gây lỗi rồi bấm lại.
   */
  async balance(id: bigint, user: AuthUser) {
    const st = await this.prisma.stocktake.findUnique({
      where: { id },
      include: { items: { include: { variant: { select: { sku: true } } } } },
    });
    if (!st) throw new NotFoundException('Không tìm thấy phiếu kiểm hàng');
    assertLocationPermission(user, 'inventory:stocktake', st.locationId);
    this.assertEditable(st.status);

    const counted = st.items.filter((i) => i.countedQuantity != null);
    if (!counted.length) {
      throw new BusinessException(
        'STOCKTAKE_NOTHING_COUNTED',
        'Chưa dòng nào được đếm — không có gì để cân bằng',
      );
    }

    const result = await this.prisma.$transaction(async (tx) => {
      let diffLineCount = 0;
      let diffQuantity = 0;

      // sortForLocking: mọi phiếu khoá tồn theo cùng một thứ tự nên hai phiếu chạy song
      // song không ôm khoá chéo rồi deadlock.
      const rows = sortForLocking(
        counted.map((i) => ({
          variantId: i.variantId,
          locationId: st.locationId,
          counted: i.countedQuantity as number,
          sku: i.variant?.sku ?? i.variantId.toString(),
        })),
      );

      for (const row of rows) {
        // Đọc tồn ngay trước khi điều chỉnh để ghi lại con số lệch. Số điều chỉnh THẬT do
        // `adjustOnHandTo` tự tính lại sau khi đã khoá dòng — hai số chỉ lệch nhau nếu có
        // giao dịch chen vào đúng khe này, và khi đó số đúng là số của nó, không phải số ở đây.
        const level = await tx.inventoryLevel.findUnique({
          where: {
            variantId_locationId: {
              variantId: row.variantId,
              locationId: row.locationId,
            },
          },
          select: { onHand: true },
        });
        const before = level?.onHand ?? 0;
        const diff = row.counted - before;

        try {
          await this.inventory.adjustOnHandTo(
            {
              variantId: row.variantId,
              locationId: row.locationId,
              targetOnHand: row.counted,
              referenceType: 'stocktake',
              referenceId: id,
              createdById: user.userId,
            },
            tx,
          );
        } catch (e) {
          if (e instanceof InsufficientStockException) {
            // Đếm ra ít hơn phần đang giữ chỗ cho đơn/đóng gói: hạ `on_hand` xuống sẽ đẩy
            // available âm và bị chặn. Nói rõ SKU nào để người dùng xử lý đơn giữ chỗ trước,
            // thay vì trả về đúng chữ "Không đủ tồn available" cho cả phiếu.
            throw new BusinessException(
              'STOCKTAKE_BLOCKED_BY_COMMITTED',
              `SKU ${row.sku}: số đếm (${row.counted}) thấp hơn phần đang giữ chỗ cho đơn/đóng gói tại kho này. ` +
                'Xử lý các đơn đang giữ hàng rồi cân bằng lại.',
              409,
            );
          }
          throw e;
        }

        if (diff !== 0) {
          diffLineCount += 1;
          diffQuantity += diff;
        }
      }

      const updated = await tx.stocktake.update({
        where: { id },
        data: {
          status: StocktakeStatus.balanced,
          balancedById: user.userId,
          balancedAt: new Date(),
          diffLineCount,
          diffQuantity,
        },
        include: stocktakeInclude,
      });

      await tx.activityLog.create({
        data: {
          userId: user.userId,
          action: 'stocktake.balance',
          entityType: 'stocktake',
          entityId: id,
          metadata: {
            code: updated.code,
            diff_line_count: diffLineCount,
            diff_quantity: diffQuantity,
          },
        },
      });
      return updated;
    }, BALANCE_TX_OPTIONS);

    return { data: serializeStocktake(result) };
  }

  async cancel(id: bigint, user: AuthUser) {
    const st = await this.prisma.stocktake.findUnique({
      where: { id },
      select: { id: true, locationId: true, status: true },
    });
    if (!st) throw new NotFoundException('Không tìm thấy phiếu kiểm hàng');
    assertLocationPermission(user, 'inventory:stocktake', st.locationId);
    this.assertEditable(st.status);

    const updated = await this.prisma.stocktake.update({
      where: { id },
      data: { status: StocktakeStatus.cancelled, cancelledAt: new Date() },
      include: stocktakeInclude,
    });
    return { data: serializeStocktake(updated) };
  }

  /**
   * Phiếu đã cân bằng KHÔNG sửa/huỷ được: movement `adjust` đã ghi vào sổ tồn, huỷ phiếu
   * mà không sinh bút toán ngược sẽ khiến phiếu và tồn kể hai câu chuyện khác nhau. Muốn
   * sửa thì lập phiếu kiểm mới.
   */
  private assertEditable(status: StocktakeStatus) {
    if (status === StocktakeStatus.balanced) {
      throw new BusinessException(
        'STOCKTAKE_ALREADY_BALANCED',
        'Phiếu đã cân bằng — lập phiếu kiểm mới nếu cần điều chỉnh tiếp',
        409,
      );
    }
    if (status === StocktakeStatus.cancelled) {
      throw new BusinessException('STOCKTAKE_CANCELLED', 'Phiếu đã hủy', 409);
    }
  }

  /** Gộp dòng trùng phiên bản (dòng sau thắng) — bảng có UNIQUE (phiếu, phiên bản). */
  private normalizeItems(items: StocktakeItemDto[]) {
    const byVariant = new Map<
      string,
      { variantId: bigint; countedQuantity: number | null; note: string | null }
    >();
    for (const i of items) {
      byVariant.set(i.variant_id, {
        variantId: BigInt(i.variant_id),
        countedQuantity: i.counted_quantity ?? null,
        note: i.note ?? null,
      });
    }
    return [...byVariant.values()];
  }

  /** Tồn `on_hand` hiện tại của từng phiên bản tại kho — phiên bản chưa có dòng tồn = 0. */
  private async snapshotSystemQuantities(
    locationId: bigint,
    variantIds: bigint[],
  ) {
    const levels = await this.prisma.inventoryLevel.findMany({
      where: { locationId, variantId: { in: variantIds } },
      select: { variantId: true, onHand: true },
    });
    return new Map(levels.map((l) => [l.variantId.toString(), l.onHand]));
  }

  private async generateCode(tx: Prisma.TransactionClient) {
    const count = await tx.stocktake.count();
    return `KK${String(count + 1).padStart(6, '0')}`;
  }
}
