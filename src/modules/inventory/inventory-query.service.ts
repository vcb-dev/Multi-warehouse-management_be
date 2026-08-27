import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import {
  assertLocationPermission,
  locationScopeFilter,
} from '../../common/auth/access';
import { findVariantIdsByQuery } from '../../common/search/unaccent-search';
import {
  appendAnd,
  parseDateRange,
  parseIdList,
  parseIntRange,
  parseList,
  textContainsAny,
} from '../../common/query/filter-params';
import { ListInventoryQueryDto, ListMovementsQueryDto } from './inventory.dto';
import { serializeLevel, serializeMovement } from './inventory.serializer';
import {
  InventoryNxtService,
  NxtRowInput,
  rootProductCode,
} from './inventory-nxt.service';

const LOW_STOCK_THRESHOLD = Number(process.env.LOW_STOCK_THRESHOLD ?? 5);

/**
 * Bảy chỉ số kho của Sapo — mỗi cái là một cột thật trên `inventory_levels`,
 * nên lọc theo khoảng số là so sánh trực tiếp, không phải tính lại.
 */
const BUCKET_COLUMNS = {
  on_hand: 'onHand',
  available: 'available',
  committed: 'committed',
  incoming: 'incoming',
  packed: 'packed',
  reserved: 'reserved',
  unavailable: 'unavailable',
} as const;

type BucketColumn = (typeof BUCKET_COLUMNS)[keyof typeof BUCKET_COLUMNS];
type BucketRanges = Partial<
  Record<BucketColumn, { gte?: number; lte?: number }>
>;

function bucketRanges(query: ListInventoryQueryDto): BucketRanges | undefined {
  const ranges: BucketRanges = {};
  let any = false;
  const raw = query as unknown as Record<string, number | undefined>;
  for (const [param, column] of Object.entries(BUCKET_COLUMNS)) {
    const range = parseIntRange(raw[`${param}_min`], raw[`${param}_max`]);
    if (range) {
      ranges[column] = range;
      any = true;
    }
  }
  return any ? ranges : undefined;
}

/**
 * Khoảng có bao trùm số 0 hay không.
 *
 * Ở nhánh "chọn kho", variant chưa từng có bản ghi tồn tại kho đó vẫn hiện ra
 * với mọi chỉ số bằng 0. Nếu khoảng lọc bao trùm 0 mà chỉ dùng `some` thì đúng
 * những dòng ấy lại rơi ra ngoài — trong khi chúng là thứ người dùng đang tìm.
 */
function rangesIncludeZero(ranges: BucketRanges): boolean {
  return Object.values(ranges).every(
    (r) =>
      (r.gte === undefined || r.gte <= 0) &&
      (r.lte === undefined || r.lte >= 0),
  );
}

/** Bộ lọc theo thuộc tính sản phẩm, dùng chung cho cả hai nhánh danh sách. */
function productClause(
  query: ListInventoryQueryDto,
): Prisma.ProductWhereInput | undefined {
  const clause: Prisma.ProductWhereInput = {};
  let any = false;

  // Khớp một phần, không phân biệt hoa thường: giao diện cho gõ tay hai tiêu
  // chí này, khớp chính xác sẽ ra 0 dòng chỉ vì thiếu một chữ hay sai hoa thường.
  const productTypes = parseList(query.product_types);
  if (productTypes) {
    appendAnd(clause, textContainsAny('productType', productTypes));
    any = true;
  }

  const vendors = parseList(query.vendors);
  if (vendors) {
    appendAnd(clause, textContainsAny('vendor', vendors));
    any = true;
  }

  const tags = parseList(query.tags);
  if (tags) {
    clause.tags = { hasSome: tags };
    any = true;
  }

  const createdOn = parseDateRange(query.created_on_min, query.created_on_max);
  if (createdOn) {
    clause.createdOn = createdOn;
    any = true;
  }

  return any ? clause : undefined;
}

@Injectable()
export class InventoryQueryService {
  constructor(
    private prisma: PrismaService,
    private nxt: InventoryNxtService,
  ) {}

  /** Gộp extras NXT vào các dòng đã serialize (khóa `${variant_id}:${location_id}`) */
  private async withNxtExtras<
    T extends {
      variant_id: string;
      location_id: string;
      product_id: string;
      sku: string;
      on_hand: number;
      committed: number;
    },
  >(rows: T[], query: ListInventoryQueryDto) {
    const from = query.date_from ? new Date(query.date_from) : undefined;
    const inputs: NxtRowInput[] = rows.map((r) => ({
      variantId: BigInt(r.variant_id),
      locationId: BigInt(r.location_id),
      productId: BigInt(r.product_id),
      onHand: r.on_hand,
      committed: r.committed,
    }));
    const extras = await this.nxt.enrich(inputs, from);
    return rows.map((r) => ({
      ...r,
      ma_sp: rootProductCode(r.sku),
      ...extras.get(`${r.variant_id}:${r.location_id}`)!,
    }));
  }

  async listInventory(query: ListInventoryQueryDto, user: AuthUser) {
    if (query.location_id) {
      return this.listByWarehouse(query, user);
    }
    return this.listExistingLevels(query, user);
  }

  /** Lấy toàn bộ dòng khớp filter (không phân trang) — dùng cho Xuất file */
  async exportRows(query: ListInventoryQueryDto, user: AuthUser) {
    const unpaginated = { ...query, page: 1, page_size: 100000 };
    const { data } = query.location_id
      ? await this.listByWarehouse(unpaginated, user)
      : await this.listExistingLevels(unpaginated, user);
    return data;
  }

  private async listExistingLevels(
    query: ListInventoryQueryDto,
    user: AuthUser,
  ) {
    const page = query.page ?? 1;
    const pageSize = query.limit ?? query.page_size ?? 20;
    const where = await this.buildLevelWhere(query, user);

    const [rows, total] = await Promise.all([
      this.prisma.inventoryLevel.findMany({
        where,
        include: {
          variant: { include: { product: true } },
          location: true,
        },
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: [{ location: { code: 'asc' } }, { variant: { sku: 'asc' } }],
      }),
      this.prisma.inventoryLevel.count({ where }),
    ]);

    return {
      data: await this.withNxtExtras(rows.map(serializeLevel), query),
      total,
      page,
      page_size: pageSize,
    };
  }

  /** Khi chọn kho: hiển thị mọi variant (kể cả chưa có inventory_level) */
  private async listByWarehouse(query: ListInventoryQueryDto, user: AuthUser) {
    const page = query.page ?? 1;
    const pageSize = query.limit ?? query.page_size ?? 20;
    const locationId = BigInt(query.location_id!);
    // Nhánh này bỏ qua buildLevelWhere nên không được thừa hưởng bộ lọc kho —
    // thiếu dòng này thì `?location_id=` xem được tồn của kho bất kỳ.
    assertLocationPermission(user, 'inventory:view', locationId);

    const location = await this.prisma.location.findUniqueOrThrow({
      where: { id: locationId },
    });

    const variantWhere = await this.buildVariantWhere(query, locationId);

    const [variants, total] = await Promise.all([
      this.prisma.productVariant.findMany({
        where: variantWhere,
        include: {
          product: true,
          inventoryLevels: { where: { locationId } },
        },
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { sku: 'asc' },
      }),
      this.prisma.productVariant.count({ where: variantWhere }),
    ]);

    const data = variants.map((v) => {
      const level = v.inventoryLevels[0];
      if (level) {
        return serializeLevel({
          ...level,
          variant: v,
          location,
        });
      }
      return {
        variant_id: v.id.toString(),
        location_id: locationId.toString(),
        product_id: v.productId.toString(),
        sku: v.sku,
        product_name: v.product.name,
        image_url: v.imageUrl ?? v.product.imageUrl ?? null,
        unit: v.unit ?? null,
        location_code: location.code,
        location_name: location.name,
        on_hand: 0,
        committed: 0,
        packed: 0,
        unavailable: 0,
        incoming: 0,
        available: 0,
        price: v.price.toString(),
        cost: v.cost.toString(),
        updated_at: new Date(0).toISOString(),
      };
    });

    return {
      data: await this.withNxtExtras(data, query),
      total,
      page,
      page_size: pageSize,
    };
  }

  private async buildVariantWhere(
    query: ListInventoryQueryDto,
    locationId: bigint,
  ): Promise<Prisma.ProductVariantWhereInput> {
    const where: Prisma.ProductVariantWhereInput = {};

    if (query.variant_id) {
      where.id = BigInt(query.variant_id);
    }

    const variantIds = parseIdList(query.variant_ids);
    if (variantIds) {
      where.id = { in: variantIds };
    }

    if (query.q?.trim()) {
      const ids = await findVariantIdsByQuery(this.prisma, query.q.trim());
      appendAnd(where, { id: { in: ids } });
    }

    if (query.low_stock) {
      appendAnd(where, {
        OR: [
          { inventoryLevels: { none: { locationId } } },
          {
            inventoryLevels: {
              some: { locationId, available: { lte: LOW_STOCK_THRESHOLD } },
            },
          },
        ],
      });
    }

    if (query.stock_status === 'in_stock') {
      appendAnd(where, {
        inventoryLevels: { some: { locationId, available: { gt: 0 } } },
      });
    } else if (query.stock_status === 'out_of_stock') {
      appendAnd(where, {
        OR: [
          { inventoryLevels: { none: { locationId } } },
          { inventoryLevels: { some: { locationId, available: { lte: 0 } } } },
        ],
      });
    } else if (query.stock_status === 'negative') {
      // Âm THẬT (< 0), không gộp dòng bằng 0 như out_of_stock — và không lấy dòng
      // chưa có bản ghi tồn ở kho này (chưa nhập bao giờ, không phải âm kho).
      appendAnd(where, {
        inventoryLevels: { some: { locationId, available: { lt: 0 } } },
      });
    }

    // Cùng bộ lọc như nhánh kia, chỉ khác hình dạng: ở đây phải đi qua quan hệ.
    const ranges = bucketRanges(query);
    if (ranges) {
      const branches: Prisma.ProductVariantWhereInput[] = [
        { inventoryLevels: { some: { locationId, ...ranges } } },
      ];
      if (rangesIncludeZero(ranges)) {
        branches.push({ inventoryLevels: { none: { locationId } } });
      }
      appendAnd(where, branches.length > 1 ? { OR: branches } : branches[0]);
    }

    const product = productClause(query);
    if (product) appendAnd(where, { product });

    return where;
  }

  async listMovements(
    variantId: bigint,
    query: ListMovementsQueryDto,
    user: AuthUser,
  ) {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? 20;
    const where: Prisma.InventoryMovementWhereInput = { variantId };

    if (query.location_id) {
      const locationId = BigInt(query.location_id);
      assertLocationPermission(user, 'inventory:view', locationId);
      where.locationId = locationId;
    } else {
      where.locationId = locationScopeFilter(user, 'inventory:view');
    }

    if (query.bucket) where.bucket = query.bucket;

    if (query.from || query.to) {
      where.createdAt = {};
      if (query.from) where.createdAt.gte = new Date(query.from);
      if (query.to) where.createdAt.lte = new Date(query.to);
    }

    const [rows, total] = await Promise.all([
      this.prisma.inventoryMovement.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.inventoryMovement.count({ where }),
    ]);

    return {
      data: rows.map(serializeMovement),
      total,
      page,
      page_size: pageSize,
    };
  }

  private async buildLevelWhere(
    query: ListInventoryQueryDto,
    user: AuthUser,
  ): Promise<Prisma.InventoryLevelWhereInput> {
    const where: Prisma.InventoryLevelWhereInput = {};

    where.locationId = locationScopeFilter(user, 'inventory:view');

    if (query.variant_id) {
      where.variantId = BigInt(query.variant_id);
    }

    const variantIds = parseIdList(query.variant_ids);
    if (variantIds) {
      where.variantId = { in: variantIds };
    }

    if (query.low_stock) {
      where.available = { lte: LOW_STOCK_THRESHOLD };
    }

    if (query.stock_status === 'in_stock') {
      where.available = { gt: 0 };
    } else if (query.stock_status === 'out_of_stock') {
      where.available = { lte: 0 };
    } else if (query.stock_status === 'negative') {
      where.available = { lt: 0 };
    }

    if (query.q?.trim()) {
      const ids = await findVariantIdsByQuery(this.prisma, query.q.trim());
      appendAnd(where, { variantId: { in: ids } });
    }

    // Bảy khoảng số đi qua appendAnd vì `available` có thể đã bị low_stock /
    // stock_status chiếm ở trên — gán thẳng sẽ đè mất bộ lọc kia.
    const ranges = bucketRanges(query);
    if (ranges) appendAnd(where, ranges);

    const product = productClause(query);
    if (product) appendAnd(where, { variant: { product } });

    return where;
  }
}
