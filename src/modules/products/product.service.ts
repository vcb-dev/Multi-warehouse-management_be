import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { BusinessException } from '../../common/exceptions/business.exception';
import { findProductIdsByQuery } from '../../common/search/unaccent-search';
import { CategoryService } from '../categories/category.service';
import {
  CreateProductDto,
  ListProductsQueryDto,
  ProductInventoryQueryDto,
  UpdateProductDto,
} from './product.dto';
import { ProductRepository } from './product.repository';
import {
  serializeProductDetail,
  serializeProductListItem,
  slugify,
} from './product.serializer';
import { VariantService } from './variant.service';

/** SP nhiều variant + DB remote — syncVariants có thể > 5s mặc định của Prisma */
const PRODUCT_TX_TIMEOUT_MS = 30_000;

@Injectable()
export class ProductService {
  constructor(
    private repo: ProductRepository,
    private variants: VariantService,
    private categories: CategoryService,
  ) {}

  async buildListWhere(
    query: ListProductsQueryDto,
  ): Promise<Prisma.ProductWhereInput> {
    const where: Prisma.ProductWhereInput = {};

    if (query.q?.trim()) {
      const ids = await findProductIdsByQuery(this.repo.client, query.q.trim());
      where.id = { in: ids };
    }
    if (query.brand?.trim()) {
      where.brand = { contains: query.brand.trim(), mode: 'insensitive' };
    }
    if (query.product_type?.trim()) {
      where.productType = {
        contains: query.product_type.trim(),
        mode: 'insensitive',
      };
    }
    if (query.is_published !== undefined)
      where.isPublished = query.is_published;
    if (query.category_id) {
      where.categories = { some: { categoryId: BigInt(query.category_id) } };
    }
    if (query.channel) {
      where.salesChannels = { some: { channel: query.channel } };
    }

    return where;
  }

  async list(query: ListProductsQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? 20;
    const where = await this.buildListWhere(query);
    const [rows, total] = await Promise.all([
      this.repo.client.product.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          variants: {
            where: { enabled: true },
            orderBy: { id: 'asc' },
            select: { sku: true, price: true },
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

  async findOne(id: bigint) {
    const row = await this.repo.findById(id);
    if (!row) throw new NotFoundException('Không tìm thấy sản phẩm');
    return { data: serializeProductDetail(row) };
  }

  async create(dto: CreateProductDto, user: AuthUser) {
    await this.validateSkus(dto.variants?.map((v) => v.sku) ?? []);

    const slug = await this.uniqueSlug(dto.slug?.trim() || slugify(dto.name));
    const options = dto.options ?? [];
    if (options.length > 3) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        'Tối đa 3 thuộc tính',
        422,
      );
    }

    const variantRows = this.buildVariantRows(slug, options, dto.variants);

    const product = await this.repo.client.$transaction(
      async (tx) => {
        const p = await tx.product.create({
          data: {
            name: dto.name.trim(),
            slug,
            brand: dto.brand?.trim() || null,
            productType: dto.product_type?.trim() || null,
            unit: dto.unit?.trim() || null,
            tags: dto.tags ?? [],
            isPublished: dto.is_published ?? false,
            description: dto.description?.trim() || null,
            shortDescription: dto.short_description?.trim() || null,
            imageUrl: dto.image_urls?.[0] ?? null,
            seoTitle: dto.seo_title?.trim() || null,
            seoDescription: dto.seo_description?.trim() || null,
            taxable: dto.taxable ?? true,
            taxIndustryGroup: dto.tax_industry_group?.trim() || null,
            trackInventory: dto.track_inventory ?? true,
            allowBackorder: dto.allow_backorder ?? false,
            requiresShipping: dto.requires_shipping ?? true,
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
            },
          });

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
            metadata: { name: p.name, slug: p.slug },
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
      slug: product.slug,
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
            ...(dto.brand !== undefined
              ? { brand: dto.brand?.trim() || null }
              : {}),
            ...(dto.product_type !== undefined
              ? { productType: dto.product_type?.trim() || null }
              : {}),
            ...(dto.unit !== undefined
              ? { unit: dto.unit?.trim() || null }
              : {}),
            ...(dto.tags ? { tags: dto.tags } : {}),
            ...(dto.is_published !== undefined
              ? { isPublished: dto.is_published }
              : {}),
            ...(dto.description !== undefined
              ? { description: dto.description?.trim() || null }
              : {}),
            ...(dto.short_description !== undefined
              ? { shortDescription: dto.short_description?.trim() || null }
              : {}),
            ...(dto.seo_title !== undefined
              ? { seoTitle: dto.seo_title?.trim() || null }
              : {}),
            ...(dto.seo_description !== undefined
              ? { seoDescription: dto.seo_description?.trim() || null }
              : {}),
            ...(dto.taxable !== undefined ? { taxable: dto.taxable } : {}),
            ...(dto.tax_industry_group !== undefined
              ? { taxIndustryGroup: dto.tax_industry_group?.trim() || null }
              : {}),
            ...(dto.track_inventory !== undefined
              ? { trackInventory: dto.track_inventory }
              : {}),
            ...(dto.allow_backorder !== undefined
              ? { allowBackorder: dto.allow_backorder }
              : {}),
            ...(dto.requires_shipping !== undefined
              ? { requiresShipping: dto.requires_shipping }
              : {}),
          },
        });

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
          await this.syncVariants(
            tx,
            id,
            existing.slug,
            dto.options,
            dto.variants,
          );
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

    const levels = await this.repo.client.inventoryLevel.findMany({
      where: {
        variantId: { in: variantIds },
        ...(query.warehouse_id
          ? { warehouseId: BigInt(query.warehouse_id) }
          : {}),
      },
      include: { warehouse: true },
    });

    return {
      data: levels.map((l) => ({
        variant_id: l.variantId.toString(),
        warehouse_id: l.warehouseId.toString(),
        warehouse_name: l.warehouse.name,
        on_hand: l.onHand,
        available: l.available,
        committed: l.committed,
        incoming: l.incoming,
        packing: l.packing,
        unavailable: l.unavailable,
      })),
    };
  }

  private buildVariantRows(
    slug: string,
    options: CreateProductDto['options'],
    variants?: CreateProductDto['variants'],
  ) {
    if (!options?.length) {
      const v = variants?.[0];
      return [
        {
          sku: v?.sku ?? this.variants.suggestSku(slug, []),
          price: v?.price ?? 0,
          cost: v?.cost,
          compareAtPrice: v?.compare_at_price,
          barcode: v?.barcode,
          imageUrl: v?.image_url,
          weight: v?.weight,
          weightUnit: v?.weight_unit,
          optionValues: [] as string[],
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
        sku: this.variants.suggestSku(slug, optionValues),
        price: input?.price ?? 0,
        cost: input?.cost,
        compareAtPrice: input?.compare_at_price,
        barcode: input?.barcode,
        imageUrl: input?.image_url,
        weight: input?.weight,
        weightUnit: input?.weight_unit,
        optionValues,
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
    slug: string,
    options: NonNullable<CreateProductDto['options']>,
    variants: NonNullable<CreateProductDto['variants']>,
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

    const desired = this.buildVariantRows(slug, options, variants);
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

      if (match && match.sku === d.sku) {
        await tx.productVariant.update({
          where: { id: match.id },
          data: {
            price: d.price,
            cost: d.cost ?? match.cost,
            compareAtPrice: d.compareAtPrice,
            barcode: d.barcode,
            imageUrl: d.imageUrl,
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
            sku: d.sku,
            price: d.price,
            cost: d.cost ?? 0,
            compareAtPrice: d.compareAtPrice,
            barcode: d.barcode,
            imageUrl: d.imageUrl,
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
    for (const sku of skus) {
      const trimmed = sku.trim();
      if (!trimmed) continue;
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

  private async uniqueSlug(base: string): Promise<string> {
    let slug = base || 'san-pham';
    let n = 0;
    while (await this.repo.findBySlug(slug)) {
      n += 1;
      slug = `${base}-${n}`;
    }
    return slug;
  }
}
