import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import {
  assertLocationPermission,
  locationScopeFilter,
} from '../../common/auth/access';
import { BusinessException } from '../../common/exceptions/business.exception';
import { findProductIdsByQuery } from '../../common/search/unaccent-search';
import {
  appendAnd,
  firstDefined,
  parseDateRange,
  parseIdList,
  parseList,
  textContainsAny,
} from '../../common/query/filter-params';
import { CategoryService } from '../categories/category.service';
import {
  CreateProductDto,
  ListProductsQueryDto,
  ProductInventoryQueryDto,
  ProductFacetQueryDto,
  ProductVariantDto,
  UpdateProductDto,
  VariantPriceHistoryQueryDto,
} from './product.dto';
import { ProductRepository } from './product.repository';
import {
  serializeProductDetail,
  serializeProductListItem,
  slugify,
} from './product.serializer';
import { VariantService } from './variant.service';
import { VariantPriceHistoryService } from './variant-price-history.service';
import { serializeVariantPriceHistory } from './variant-price-history.serializer';

/** SP nhiều variant + DB remote — syncVariants có thể > 5s mặc định của Prisma */
const PRODUCT_TX_TIMEOUT_MS = 30_000;

@Injectable()
export class ProductService {
  constructor(
    private repo: ProductRepository,
    private variants: VariantService,
    private categories: CategoryService,
    private priceHistory: VariantPriceHistoryService,
  ) {}

  async buildListWhere(
    query: ListProductsQueryDto,
  ): Promise<Prisma.ProductWhereInput> {
    const where: Prisma.ProductWhereInput = {};

    if (query.q?.trim()) {
      const ids = await findProductIdsByQuery(this.repo.client, query.q.trim());
      where.id = { in: ids };
    }
    // Khớp một phần, không phân biệt hoa thường — giao diện cho gõ tay hai
    // tiêu chí này (chưa có endpoint trả danh sách nhãn hiệu/loại sẵn có), nên
    // khớp chính xác sẽ ra 0 dòng chỉ vì thiếu một chữ hay sai hoa thường.
    const vendors = parseList(firstDefined(query.vendors, query.brand));
    if (vendors) appendAnd(where, textContainsAny('vendor', vendors));

    const productTypes = parseList(
      firstDefined(query.product_types, query.product_type),
    );
    if (productTypes) {
      appendAnd(where, textContainsAny('productType', productTypes));
    }

    if (query.is_published !== undefined)
      where.status = query.is_published ? 'active' : { not: 'active' };

    const categoryIds = parseIdList(
      firstDefined(query.category_ids, query.category_id),
    );
    if (categoryIds) {
      where.categories = { some: { categoryId: { in: categoryIds } } };
    }

    const channels = parseList(firstDefined(query.channels, query.channel));
    if (channels) {
      where.salesChannels = { some: { channel: { in: channels } } };
    }

    const tags = parseList(query.tags);
    if (tags) where.tags = { hasSome: tags };

    const vatPitCodes = parseList(query.vat_pit_category_codes);
    if (vatPitCodes) where.vatPitCategoryCode = { in: vatPitCodes };

    const createdOn = parseDateRange(
      query.created_on_min,
      query.created_on_max,
    );
    if (createdOn) where.createdOn = createdOn;

    return where;
  }

  async list(query: ListProductsQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.limit ?? query.page_size ?? 20;
    const where = await this.buildListWhere(query);
    const [rows, total] = await Promise.all([
      this.repo.client.product.findMany({
        where,
        orderBy: { modifiedOn: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          variants: {
            where: { enabled: true },
            orderBy: { id: 'asc' },
            select: { sku: true, barcode: true, price: true, unit: true },
          },
        },
      }),
      this.repo.count(where),
    ]);

    return {
      data: rows.map((row) =>
        serializeProductListItem(row, { searchQuery: query.q }),
      ),
      total,
      page,
      page_size: pageSize,
    };
  }

  /**
   * Tag đang dùng trên toàn bộ sản phẩm (chủ yếu do đồng bộ Sapo đổ về), xếp
   * theo số sản phẩm giảm dần để tag hay dùng nằm trên đầu ô chọn.
   */
  async listTags(query: ProductFacetQueryDto) {
    const rows = await this.repo.listTags({
      q: query.q?.trim() || undefined,
      limit: query.limit ?? 1000,
    });
    return {
      data: rows.map((r) => ({
        tag: r.tag,
        product_count: Number(r.product_count),
      })),
    };
  }

  /** Loại sản phẩm đang dùng, cũng xếp theo số sản phẩm giảm dần như tag */
  async listProductTypes(query: ProductFacetQueryDto) {
    const rows = await this.repo.listProductTypes({
      q: query.q?.trim() || undefined,
      limit: query.limit ?? 1000,
    });
    return {
      data: rows.map((r) => ({
        product_type: r.product_type,
        product_count: Number(r.product_count),
      })),
    };
  }

  /** Nhãn hiệu đang dùng, xếp theo số sản phẩm giảm dần như loại sản phẩm */
  async listVendors(query: ProductFacetQueryDto) {
    const rows = await this.repo.listVendors({
      q: query.q?.trim() || undefined,
      limit: query.limit ?? 1000,
    });
    return {
      data: rows.map((r) => ({
        vendor: r.vendor,
        product_count: Number(r.product_count),
      })),
    };
  }

  async findOne(id: bigint) {
    const row = await this.repo.findById(id);
    if (!row) throw new NotFoundException('Không tìm thấy sản phẩm');
    return { data: serializeProductDetail(row) };
  }

  async create(dto: CreateProductDto, user: AuthUser) {
    await this.validateSkus(dto.variants?.map((v) => v.sku) ?? []);

    const alias = await this.uniqueAlias(
      dto.alias?.trim() || slugify(dto.name),
    );
    const options = dto.options ?? [];
    if (options.length > 3) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        'Tối đa 3 thuộc tính',
        422,
      );
    }

    const variantRows = this.buildVariantRows(alias, options, dto);

    const product = await this.repo.client.$transaction(
      async (tx) => {
        const p = await tx.product.create({
          data: {
            name: dto.name.trim(),
            alias,
            vendor: dto.vendor?.trim() || null,
            productType: dto.product_type?.trim() || null,
            tags: dto.tags ?? [],
            status: dto.is_published === false ? 'draft' : 'active',
            content: dto.content?.trim() || null,
            summary: dto.summary?.trim() || null,
            imageUrl: dto.image_urls?.[0] ?? null,
            metaTitle: dto.meta_title?.trim() || null,
            metaDescription: dto.meta_description?.trim() || null,
            vatPitCategoryCode: dto.vat_pit_category_code?.trim() || null,
          },
        });

        if (dto.image_urls?.length) {
          await tx.productImage.createMany({
            data: dto.image_urls.map((url, i) => ({
              productId: p.id,
              url,
              position: i,
              isPrimary: i === 0,
            })),
          });
        }

        if (dto.sales_channels?.length) {
          await tx.productSalesChannel.createMany({
            data: dto.sales_channels.map((channel) => ({
              productId: p.id,
              channel,
            })),
          });
        }

        if (dto.category_ids?.length) {
          await tx.productCategory.createMany({
            data: dto.category_ids.map((cid) => ({
              productId: p.id,
              categoryId: BigInt(cid),
            })),
          });
        }

        const optionRecords = [];
        for (let i = 0; i < options.length; i++) {
          const opt = await tx.productOption.create({
            data: {
              productId: p.id,
              name: options[i].name.trim(),
              position: i,
            },
          });
          optionRecords.push({ ...options[i], id: opt.id });
        }

        for (const vr of variantRows) {
          const variant = await tx.productVariant.create({
            data: {
              productId: p.id,
              sku: vr.sku,
              price: vr.price,
              cost: vr.cost ?? 0,
              compareAtPrice: vr.compareAtPrice,
              barcode: vr.barcode,
              imageUrl: vr.imageUrl,
              weight: vr.weight,
              weightUnit: vr.weightUnit,
              unit: vr.unit,
              taxable: vr.taxable,
              requiresShipping: vr.requiresShipping,
              inventoryManagement: vr.inventoryManagement,
              inventoryPolicy: vr.inventoryPolicy,
            },
          });

          // await this.priceHistory.logIfChanged({
          //   tx,
          //   variantId: variant.id,
          //   field: 'price',
          //   oldValue: null,
          //   newValue: vr.price,
          //   changedById: user.userId,
          //   source: 'create',
          // });

          // await this.priceHistory.logIfChanged({
          //   tx,
          //   variantId: variant.id,
          //   field: 'cost',
          //   oldValue: null,
          //   newValue: vr.cost ?? 0,
          //   changedById: user.userId,
          //   source: 'create',
          // });

          if (optionRecords.length) {
            for (let i = 0; i < optionRecords.length; i++) {
              await tx.variantOptionValue.create({
                data: {
                  variantId: variant.id,
                  optionId: optionRecords[i].id,
                  value: vr.optionValues[i],
                },
              });
            }
          }
        }

        await this.categories.evaluateAutoForProduct(tx, p.id);

        await tx.activityLog.create({
          data: {
            userId: user.userId,
            action: 'product.create',
            entityType: 'product',
            entityId: p.id,
            metadata: { name: p.name, alias: p.alias },
          },
        });

        return p;
      },
      { timeout: PRODUCT_TX_TIMEOUT_MS },
    );

    const count = await this.repo.client.productVariant.count({
      where: { productId: product.id, enabled: true },
    });

    return {
      id: product.id.toString(),
      alias: product.alias,
      variant_count: count,
    };
  }

  async update(id: bigint, dto: UpdateProductDto, user: AuthUser) {
    const existing = await this.repo.findById(id);
    if (!existing) throw new NotFoundException('Không tìm thấy sản phẩm');

    const newSkus = dto.variants?.map((v) => v.sku) ?? [];
    const keepSkus = existing.variants.map((v) => v.sku);
    const toCheck = newSkus.filter((s) => !keepSkus.includes(s));
    await this.validateSkus(toCheck, id);

    await this.repo.client.$transaction(
      async (tx) => {
        await tx.product.update({
          where: { id },
          data: {
            ...(dto.name ? { name: dto.name.trim() } : {}),
            ...(dto.vendor !== undefined
              ? { vendor: dto.vendor?.trim() || null }
              : {}),
            ...(dto.product_type !== undefined
              ? { productType: dto.product_type?.trim() || null }
              : {}),
            ...(dto.tags ? { tags: dto.tags } : {}),
            ...(dto.is_published !== undefined
              ? { status: dto.is_published ? 'active' : 'draft' }
              : {}),
            ...(dto.content !== undefined
              ? { content: dto.content?.trim() || null }
              : {}),
            ...(dto.summary !== undefined
              ? { summary: dto.summary?.trim() || null }
              : {}),
            ...(dto.meta_title !== undefined
              ? { metaTitle: dto.meta_title?.trim() || null }
              : {}),
            ...(dto.meta_description !== undefined
              ? { metaDescription: dto.meta_description?.trim() || null }
              : {}),
            ...(dto.vat_pit_category_code !== undefined
              ? {
                  vatPitCategoryCode: dto.vat_pit_category_code?.trim() || null,
                }
              : {}),
          },
        });

        // unit/taxable/requires_shipping/track_inventory/allow_backorder giờ ở cấp
        // variant (theo Sapo) — áp giá trị chung này cho mọi variant hiện có trừ
        // khi request cũng gửi kèm `variants[]` (syncVariants sẽ set giá trị mới hơn).
        const hasVariantLevelUpdate =
          dto.unit !== undefined ||
          dto.taxable !== undefined ||
          dto.requires_shipping !== undefined ||
          dto.track_inventory !== undefined ||
          dto.allow_backorder !== undefined;
        if (hasVariantLevelUpdate && !dto.variants) {
          await tx.productVariant.updateMany({
            where: { productId: id },
            data: {
              ...(dto.unit !== undefined
                ? { unit: dto.unit?.trim() || null }
                : {}),
              ...(dto.taxable !== undefined ? { taxable: dto.taxable } : {}),
              ...(dto.requires_shipping !== undefined
                ? { requiresShipping: dto.requires_shipping }
                : {}),
              ...(dto.track_inventory !== undefined
                ? { inventoryManagement: dto.track_inventory ? 'bizweb' : '' }
                : {}),
              ...(dto.allow_backorder !== undefined
                ? { inventoryPolicy: dto.allow_backorder ? 'continue' : 'deny' }
                : {}),
            },
          });
        }

        if (dto.image_urls) {
          await tx.productImage.deleteMany({ where: { productId: id } });
          if (dto.image_urls.length) {
            await tx.productImage.createMany({
              data: dto.image_urls.map((url, i) => ({
                productId: id,
                url,
                position: i,
                isPrimary: i === 0,
              })),
            });
            await tx.product.update({
              where: { id },
              data: { imageUrl: dto.image_urls[0] },
            });
          }
        }

        if (dto.sales_channels) {
          await tx.productSalesChannel.deleteMany({ where: { productId: id } });
          if (dto.sales_channels.length) {
            await tx.productSalesChannel.createMany({
              data: dto.sales_channels.map((channel) => ({
                productId: id,
                channel,
              })),
            });
          }
        }

        if (dto.category_ids) {
          await tx.productCategory.deleteMany({
            where: {
              productId: id,
              category: { conditionType: 'manual' },
            },
          });
          if (dto.category_ids.length) {
            await tx.productCategory.createMany({
              data: dto.category_ids.map((cid) => ({
                productId: id,
                categoryId: BigInt(cid),
              })),
              skipDuplicates: true,
            });
          }
        }

        if (dto.options && dto.variants) {
          await this.syncVariants(tx, id, existing.alias, dto.options, dto, {
            userId: user.userId,
            source: 'manual',
          });
        }

        await this.categories.evaluateAutoForProduct(tx, id);

        await tx.activityLog.create({
          data: {
            userId: user.userId,
            action: 'product.update',
            entityType: 'product',
            entityId: id,
          },
        });
      },
      { timeout: PRODUCT_TX_TIMEOUT_MS },
    );

    return this.findOne(id);
  }

  async getInventory(
    id: bigint,
    query: ProductInventoryQueryDto,
    user: AuthUser,
  ) {
    const product = await this.repo.findById(id);
    if (!product) throw new NotFoundException('Không tìm thấy sản phẩm');

    const variantIds = product.variants.map((v) => v.id);
    if (!variantIds.length) return { data: [] };

    const where: Prisma.InventoryLevelWhereInput = {
      variantId: { in: variantIds },
    };
    // Thiếu chốt chặn này thì `?location_id=` xem được tồn của kho bất kỳ.
    if (query.location_id) {
      const locationId = BigInt(query.location_id);
      assertLocationPermission(user, 'inventory:view', locationId);
      where.locationId = locationId;
    } else {
      where.locationId = locationScopeFilter(user, 'inventory:view');
    }

    const levels = await this.repo.client.inventoryLevel.findMany({
      where,
      include: { location: true },
    });

    return {
      data: levels.map((l) => ({
        variant_id: l.variantId.toString(),
        location_id: l.locationId.toString(),
        location_name: l.location.name,
        on_hand: l.onHand,
        available: l.available,
        committed: l.committed,
        incoming: l.incoming,
        packed: l.packed,
        unavailable: l.unavailable,
      })),
    };
  }

  /**
   * Lấy lịch sử giá/vốn của một phiên bản sản phẩm.
   */
  async getVariantPriceHistory(
    productId: bigint,
    variantId: bigint,
    query: VariantPriceHistoryQueryDto,
  ) {
    // variantId phải thuộc productId, nếu không thì throw lỗi
    const variant = await this.repo.client.productVariant.findFirst({
      where: { id: variantId, productId },
      select: { id: true },
    });
    if (!variant) throw new NotFoundException('Không tìm thấy phiên bản');

    const page = query.page ?? 1;
    const pageSize = query.page_size ?? 20;

    const where: Prisma.VariantPriceHistoryWhereInput = {
      variantId,
      ...(query.field ? { field: query.field } : {}),
    };

    // promise all để lấy lịch sử giá/vốn và tổng số lượng lịch sử
    const [rows, total] = await Promise.all([
      this.repo.client.variantPriceHistory.findMany({
        where,
        include: {
          changedBy: {
            select: { firstName: true, lastName: true, email: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.repo.client.variantPriceHistory.count({ where }),
    ]);

    return {
      data: rows.map(serializeVariantPriceHistory),
      total,
      page,
      page_size: pageSize,
    };
  }

  /** Cờ requires_shipping/taxable/inventory_management/inventory_policy/unit sống ở
   *  ProductVariant theo Sapo — variant tự ghi đè nếu có, không thì dùng giá trị
   *  chung của sản phẩm (dto cấp trên). */
  private resolveVariantFlags(
    dto: {
      unit?: string;
      taxable?: boolean;
      requires_shipping?: boolean;
      track_inventory?: boolean;
      allow_backorder?: boolean;
    },
    v?: ProductVariantDto,
  ) {
    // Không gửi thì trả `undefined` chứ không tự bịa mặc định: lúc create Prisma
    // sẽ lấy default của cột (trùng đúng các giá trị cũ ở đây), lúc update thì
    // giữ nguyên giá trị đang lưu thay vì ghi đè.
    const unit = v?.unit ?? dto.unit;
    const trackInventory = v?.track_inventory ?? dto.track_inventory;
    const allowBackorder = v?.allow_backorder ?? dto.allow_backorder;
    return {
      unit: unit === undefined ? undefined : unit.trim() || null,
      taxable: v?.taxable ?? dto.taxable,
      requiresShipping: v?.requires_shipping ?? dto.requires_shipping,
      inventoryManagement:
        trackInventory === undefined
          ? undefined
          : trackInventory
            ? 'bizweb'
            : '',
      inventoryPolicy:
        allowBackorder === undefined
          ? undefined
          : allowBackorder
            ? 'continue'
            : 'deny',
    };
  }

  private buildVariantRows(
    alias: string,
    options: CreateProductDto['options'],
    dto: Pick<
      CreateProductDto,
      | 'variants'
      | 'unit'
      | 'taxable'
      | 'requires_shipping'
      | 'track_inventory'
      | 'allow_backorder'
    >,
  ) {
    const variants = dto.variants;
    if (!options?.length) {
      const v = variants?.[0];
      return [
        {
          sku: v?.sku?.trim() || this.variants.suggestSku(alias, []),
          skuExplicit: Boolean(v?.sku?.trim()),
          price: v?.price ?? 0,
          cost: v?.cost,
          compareAtPrice: v?.compare_at_price,
          barcode: v?.barcode,
          imageUrl: v?.image_url,
          weight: v?.weight,
          weightUnit: v?.weight_unit,
          optionValues: [] as string[],
          ...this.resolveVariantFlags(dto, v),
        },
      ];
    }

    const combos = this.variants.cartesian(options);
    const byKey = new Map(
      (variants ?? []).map((v) => [
        this.variants.optionKey(v.option_values),
        v,
      ]),
    );

    return combos.map((optionValues) => {
      const key = this.variants.optionKey(optionValues);
      const input = byKey.get(key);
      return {
        // SKU do người dùng nhập là nguồn sự thật; chỉ tự sinh khi bỏ trống.
        sku:
          input?.sku?.trim() || this.variants.suggestSku(alias, optionValues),
        skuExplicit: Boolean(input?.sku?.trim()),
        price: input?.price ?? 0,
        cost: input?.cost,
        compareAtPrice: input?.compare_at_price,
        barcode: input?.barcode,
        imageUrl: input?.image_url,
        weight: input?.weight,
        weightUnit: input?.weight_unit,
        optionValues,
        ...this.resolveVariantFlags(dto, input),
      };
    });
  }

  private sortedOptionValues(
    optionValues: { optionId: bigint; value: string }[],
  ): string[] {
    return [...optionValues]
      .sort((a, b) => Number(a.optionId - b.optionId))
      .map((ov) => ov.value);
  }

  private async syncVariants(
    tx: Prisma.TransactionClient,
    productId: bigint,
    alias: string,
    options: NonNullable<CreateProductDto['options']>,
    dto: Pick<
      CreateProductDto,
      | 'variants'
      | 'unit'
      | 'taxable'
      | 'requires_shipping'
      | 'track_inventory'
      | 'allow_backorder'
    >,
    ctx: { userId?: bigint; source?: 'manual' | 'import' | 'create' },
  ) {
    const existingVariants = await tx.productVariant.findMany({
      where: { productId },
      include: { optionValues: true },
    });

    const existingByKey = new Map<string, (typeof existingVariants)[0]>();
    for (const ev of existingVariants) {
      existingByKey.set(
        this.variants.optionKey(this.sortedOptionValues(ev.optionValues)),
        ev,
      );
    }

    await tx.variantOptionValue.deleteMany({
      where: { variant: { productId } },
    });
    await tx.productOption.deleteMany({ where: { productId } });

    if (options.length) {
      await tx.productOption.createMany({
        data: options.map((o, i) => ({
          productId,
          name: o.name.trim(),
          position: i,
        })),
      });
    }
    const optionRecords = await tx.productOption.findMany({
      where: { productId },
      orderBy: { position: 'asc' },
    });

    const desired = this.buildVariantRows(alias, options, dto);
    const desiredKeys = new Set(
      desired.map((d) => this.variants.optionKey(d.optionValues)),
    );

    const optionValueRows: {
      variantId: bigint;
      optionId: bigint;
      value: string;
    }[] = [];

    for (const d of desired) {
      const key = this.variants.optionKey(d.optionValues);
      const match = existingByKey.get(key);
      let variantId: bigint;

      // Request không gửi SKU thì giữ nguyên SKU đang lưu — nếu lấy SKU tự sinh
      // làm chuẩn, mọi lần sửa giá/tên đều bị coi là "đổi SKU" rồi xoá-tạo lại
      // phiên bản (hoặc chặn bằng VARIANT_IN_USE khi đã có tồn kho).
      const desiredSku = d.skuExplicit ? d.sku : (match?.sku ?? d.sku);

      if (match && match.sku === desiredSku) {
        const nextCost = d.cost ?? match.cost;
        await this.priceHistory.logIfChanged({
          tx,
          variantId: match.id,
          field: 'price',
          oldValue: match.price,
          newValue: d.price,
          changedById: ctx.userId,
          source: ctx.source,
        });
        await this.priceHistory.logIfChanged({
          tx,
          variantId: match.id,
          field: 'cost',
          oldValue: match.cost,
          newValue: nextCost,
          changedById: ctx.userId,
          source: ctx.source,
        });
        await tx.productVariant.update({
          where: { id: match.id },
          data: {
            price: d.price,
            cost: d.cost ?? match.cost,
            compareAtPrice: d.compareAtPrice,
            barcode: d.barcode,
            imageUrl: d.imageUrl,
            weight: d.weight,
            weightUnit: d.weightUnit,
            unit: d.unit,
            taxable: d.taxable,
            requiresShipping: d.requiresShipping,
            inventoryManagement: d.inventoryManagement,
            inventoryPolicy: d.inventoryPolicy,
            enabled: true,
          },
        });
        variantId = match.id;
      } else {
        if (match) {
          const blocked = await this.repo.variantIdsBlockedFromDelete(tx, [
            match.id,
          ]);
          if (blocked.has(match.id)) {
            throw new BusinessException(
              'VARIANT_IN_USE',
              `Không thể đổi SKU phiên bản ${match.sku} — đã phát sinh tồn kho hoặc chứng từ`,
              409,
            );
          }
          await this.repo.deleteVariants(tx, [match.id]);
        }
        const created = await tx.productVariant.create({
          data: {
            productId,
            sku: desiredSku,
            price: d.price,
            cost: d.cost ?? 0,
            compareAtPrice: d.compareAtPrice,
            barcode: d.barcode,
            imageUrl: d.imageUrl,
            weight: d.weight,
            weightUnit: d.weightUnit,
            unit: d.unit,
            taxable: d.taxable,
            requiresShipping: d.requiresShipping,
            inventoryManagement: d.inventoryManagement,
            inventoryPolicy: d.inventoryPolicy,
          },
        });
        variantId = created.id;
      }

      for (let i = 0; i < optionRecords.length; i++) {
        optionValueRows.push({
          variantId,
          optionId: optionRecords[i].id,
          value: d.optionValues[i],
        });
      }
    }

    if (optionValueRows.length) {
      await tx.variantOptionValue.createMany({ data: optionValueRows });
    }

    const toRemove = existingVariants.filter((ev) => {
      const key = this.variants.optionKey(
        this.sortedOptionValues(ev.optionValues),
      );
      return !desiredKeys.has(key);
    });

    if (toRemove.length) {
      const blocked = await this.repo.variantIdsBlockedFromDelete(
        tx,
        toRemove.map((v) => v.id),
      );
      const blockedVariant = toRemove.find((v) => blocked.has(v.id));
      if (blockedVariant) {
        throw new BusinessException(
          'VARIANT_IN_USE',
          `Không thể xóa phiên bản ${blockedVariant.sku} — đã phát sinh tồn kho hoặc chứng từ`,
          409,
        );
      }
      await this.repo.deleteVariants(
        tx,
        toRemove.map((v) => v.id),
      );
    }
  }

  private async validateSkus(skus: string[], excludeProductId?: bigint) {
    const seen = new Set<string>();
    for (const sku of skus) {
      const trimmed = sku?.trim();
      if (!trimmed) continue;
      // Trùng ngay trong cùng một request: bắt ở đây, nếu không sẽ vỡ ở ràng
      // buộc unique của DB và trả về lỗi P2002 thô.
      if (seen.has(trimmed)) {
        throw new BusinessException(
          'DUPLICATE_SKU',
          `SKU "${trimmed}" bị lặp trong danh sách phiên bản`,
          409,
        );
      }
      seen.add(trimmed);
      const existing = await this.repo.findVariantBySku(trimmed);
      if (
        existing &&
        (!excludeProductId || existing.productId !== excludeProductId)
      ) {
        throw new BusinessException(
          'DUPLICATE_SKU',
          `SKU "${trimmed}" đã tồn tại`,
          409,
        );
      }
    }
  }

  private async uniqueAlias(base: string): Promise<string> {
    let alias = base || 'san-pham';
    let n = 0;
    while (await this.repo.findByAlias(alias)) {
      n += 1;
      alias = `${base}-${n}`;
    }
    return alias;
  }
}
