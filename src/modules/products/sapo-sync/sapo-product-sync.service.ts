import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { SapoClient, SapoOption, SapoProduct, SapoVariant } from './sapo-client';

export interface SapoProductSyncCounts {
  productsSeen: number;
  productsCreated: number;
  productsUpdated: number;
  variantsCreated: number;
  variantsUpdated: number;
  imagesResynced: number;
  optionsCreated: number;
  skuConflicts: number;
  aliasConflicts: number;
  errors: number;
}

/**
 * Mặc định Prisma timeout transaction ở 5s — không đủ cho sản phẩm nhiều
 * phiên bản: mỗi phiên bản cần 1 round-trip kiểm tra xung đột SKU trước khi
 * ghi (đo thực tế 21/08/2026: SP 12 phiên bản làm transaction văng "Transaction
 * not found" giữa chừng).
 */
const TX_OPTIONS = { timeout: 30_000, maxWait: 10_000 };

const emptyCounts = (): SapoProductSyncCounts => ({
  productsSeen: 0,
  productsCreated: 0,
  productsUpdated: 0,
  variantsCreated: 0,
  variantsUpdated: 0,
  imagesResynced: 0,
  optionsCreated: 0,
  skuConflicts: 0,
  aliasConflicts: 0,
  errors: 0,
});

const t = (v: string | null | undefined): string | null =>
  v == null ? null : String(v).trim() || null;

const parseTags = (v: string | null): string[] =>
  v ? String(v).split(',').map((x) => x.trim()).filter(Boolean) : [];

/** Option chỉ có đúng Title/Default Title là placeholder của Sapo cho hàng
 *  không phân loại — tạo vào DB chỉ tổ làm rác màn hình chi tiết. */
const isDegenerateOptions = (options: SapoOption[]): boolean =>
  options.length === 1 &&
  options[0].name === 'Title' &&
  (options[0].values ?? []).length === 1 &&
  options[0].values[0] === 'Default Title';

type ExistingProduct = {
  id: bigint;
  alias: string;
  variants: { id: bigint; sapoId: bigint | null; sku: string }[];
};

/**
 * Đồng bộ sản phẩm từ Sapo, chạy định kỳ qua `SapoProductSyncScheduler`.
 *
 * BỐI CẢNH (20/08/2026): dự án chưa từng có đường sync sản phẩm tự động — mọi
 * việc trước đây làm bằng script chạy tay (`backend/scripts/*.js`). Một đợt
 * import thủ công cũ (script đã bị xoá khỏi repo) từng gặp lỗi: khi SKU/alias
 * Sapo trả về bị một dòng khác trong DB chiếm giữ, nó ÂM THẦM ghi mã giả
 * (`SAPO-V-<id>`, `sapo-<id>`) thay vì báo lỗi — hậu quả là 96% catalog bị sai
 * mã trong nhiều tháng không ai biết, phải dọn bằng tay (xem memory
 * `sapo_product_field_drift`). Service này SỬA TRIỆT ĐỂ nguyên nhân đó:
 *
 * 1. LUÔN khớp sản phẩm/phiên bản qua `sapoId` trước — không bao giờ suy đoán
 *    qua tên/SKU, nên không thể tự tạo ra bản trùng như đợt import cũ.
 * 2. Khi SKU/alias thật bị chiếm: KHÔNG ghi đè mù. Với dòng đã tồn tại thì giữ
 *    nguyên giá trị cũ (không có gì để mất), chỉ log cảnh báo để soát tay.
 *    Với dòng mới tạo thì dùng mã tạm CÓ ĐÁNH DẤU RÕ (`SKU-PENDING-<id>`) —
 *    cố tình khác hẳn tên đợt bug cũ để không lẫn, và tăng bộ đếm
 *    `skuConflicts`/`aliasConflicts` để `SapoProductSyncScheduler` log ra ngoài.
 * 3. KHÔNG BAO GIỜ xoá sản phẩm/phiên bản tự động — nếu Sapo không còn trả về
 *    một sản phẩm, dữ liệu cục bộ vẫn giữ nguyên (xoá cần soát tay, xem
 *    `scripts/merge-duplicate-products*.js` cho quy trình gộp/xoá an toàn).
 * 4. KHÔNG đụng các trường riêng của dự án mà Sapo không có: `category`,
 *    `material`, `craftType`, `isDiscontinued`, `enabled`, `cost` (giá vốn lấy
 *    từ InventoryItem, không có trong `/admin/products.json`).
 */
@Injectable()
export class SapoProductSyncService {
  private readonly logger = new Logger(SapoProductSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sapo: SapoClient,
  ) {}

  /**
   * Đồng bộ toàn bộ catalog. KHÔNG lọc theo `updated_at_min` — đã đo thực tế
   * (21/08/2026): Sapo bump `modified_on` trên GẦN NHƯ TOÀN BỘ sản phẩm mỗi
   * vài chục phút (do tồn kho biến động theo đơn hàng liên tục, không phải
   * nội dung sản phẩm đổi), nên lọc theo thời gian không thu hẹp được gì —
   * cửa sổ "20 phút" từng trả về 12.387/12.400 sản phẩm. Bù lại, phần lớn sản
   * phẩm trong một lượt quét KHÔNG có gì thay đổi ở các trường ta quan tâm
   * (nội dung, giá, options...), nên `syncBatch` so sánh trước rồi CHỈ ghi
   * DB cho phần thật sự khác — một lượt quét đầy đủ vì vậy vẫn nhanh.
   */
  async syncAll(): Promise<SapoProductSyncCounts> {
    const counts = emptyCounts();
    const BATCH = 200;
    let batch: SapoProduct[] = [];
    for await (const s of this.sapo.iterateProducts()) {
      batch.push(s);
      if (batch.length >= BATCH) {
        await this.syncBatch(batch, counts);
        batch = [];
      }
    }
    if (batch.length) await this.syncBatch(batch, counts);
    return counts;
  }

  private async syncBatch(batch: SapoProduct[], counts: SapoProductSyncCounts) {
    const sapoIds = batch.map((s) => BigInt(s.id));
    const existingList = await this.prisma.product.findMany({
      where: { sapoId: { in: sapoIds } },
      select: {
        id: true,
        sapoId: true,
        alias: true,
        name: true,
        vendor: true,
        productType: true,
        metaTitle: true,
        metaDescription: true,
        summary: true,
        content: true,
        status: true,
        type: true,
        templateLayout: true,
        vatPitCategoryCode: true,
        tags: true,
        publishedOn: true,
        images: { select: { url: true } },
        variants: {
          select: {
            id: true,
            sapoId: true,
            sku: true,
            barcode: true,
            title: true,
            price: true,
            compareAtPrice: true,
            weight: true,
            weightUnit: true,
            unit: true,
            taxable: true,
            requiresShipping: true,
            inventoryManagement: true,
            inventoryPolicy: true,
            lotManagement: true,
            position: true,
            type: true,
            requiresComponents: true,
          },
        },
        _count: { select: { options: true } },
      },
    });
    const existingBySapoId = new Map(
      existingList.map((p) => [p.sapoId!.toString(), p]),
    );

    for (const s of batch) {
      counts.productsSeen++;
      try {
        const existing = existingBySapoId.get(String(s.id));
        if (existing) {
          await this.updateExistingProductIfChanged(existing, s, counts);
        } else {
          await this.createNewProduct(s, counts);
        }
      } catch (e) {
        counts.errors++;
        this.logger.error(
          `SP Sapo ${s.id} lỗi đồng bộ: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

  /** So trước, chỉ mở transaction/ghi DB khi thật sự có khác biệt — tránh mỗi
   *  lượt quét đụng cả ~12k sản phẩm dù 99% không đổi gì. */
  private productOrVariantChanged(
    existing: NonNullable<
      Awaited<ReturnType<SapoProductSyncService['fetchOneForDiff']>>
    >,
    s: SapoProduct,
  ): boolean {
    if (t(s.name) !== t(existing.name)) return true;
    if (t(s.vendor) !== t(existing.vendor)) return true;
    if (t(s.product_type) !== t(existing.productType)) return true;
    if (t(s.meta_title) !== t(existing.metaTitle)) return true;
    if (t(s.meta_description) !== t(existing.metaDescription)) return true;
    if (t(s.summary) !== t(existing.summary)) return true;
    if (t(s.content) !== t(existing.content)) return true;
    if ((t(s.status) ?? 'draft') !== t(existing.status)) return true;
    if ((t(s.type) ?? 'normal') !== t(existing.type)) return true;
    if (t(s.template_layout) !== t(existing.templateLayout)) return true;
    if (t(s.vat_pit_category_code) !== t(existing.vatPitCategoryCode)) return true;
    const sTags = parseTags(s.tags).slice().sort().join('|');
    const dTags = [...existing.tags].sort().join('|');
    if (sTags !== dTags) return true;
    const sPub = s.published_on ? new Date(s.published_on).getTime() : null;
    const dPub = existing.publishedOn ? existing.publishedOn.getTime() : null;
    if (sPub !== dPub) return true;
    const desiredAlias = t(s.alias);
    if (desiredAlias && desiredAlias !== existing.alias) return true;

    const sImgUrls = new Set((s.images ?? []).map((i) => i.src));
    const dImgUrls = new Set(existing.images.map((i) => i.url));
    if (
      sImgUrls.size !== dImgUrls.size ||
      [...sImgUrls].some((u) => !dImgUrls.has(u))
    ) {
      return true;
    }

    if (existing._count.options === 0) {
      const options = s.options ?? [];
      if (options.length && !isDegenerateOptions(options)) return true;
    }

    const dVarBySapoId = new Map(
      existing.variants.filter((v) => v.sapoId != null).map((v) => [v.sapoId!.toString(), v]),
    );
    for (const v of s.variants ?? []) {
      const dv = dVarBySapoId.get(String(v.id));
      if (!dv) return true; // phiên bản mới, SP chưa có
      if (t(v.sku) && t(v.sku) !== dv.sku) return true;
      if (t(v.barcode) !== t(dv.barcode)) return true;
      if (t(v.title) !== t(dv.title)) return true;
      if (Number(v.price ?? 0) !== Number(dv.price)) return true;
      const sCap =
        v.compare_at_price != null && Number(v.compare_at_price) > 0
          ? Number(v.compare_at_price)
          : null;
      const dCap = dv.compareAtPrice != null ? Number(dv.compareAtPrice) : null;
      if (sCap !== dCap) return true;
      const sWeight = v.weight != null ? Number(v.weight) : null;
      const dWeight = dv.weight != null ? Number(dv.weight) : null;
      if (sWeight !== dWeight) return true;
      if (t(v.weight_unit) !== t(dv.weightUnit)) return true;
      if (t(v.unit) !== t(dv.unit)) return true;
      if (Boolean(v.taxable) !== dv.taxable) return true;
      if (Boolean(v.requires_shipping) !== dv.requiresShipping) return true;
      if ((v.inventory_management ?? 'bizweb') !== dv.inventoryManagement) return true;
      if ((t(v.inventory_policy) ?? 'deny') !== t(dv.inventoryPolicy)) return true;
      if (Boolean(v.lot_management) !== dv.lotManagement) return true;
      if ((v.position ?? 0) !== dv.position) return true;
      if ((t(v.type) ?? 'normal') !== t(dv.type)) return true;
      if (Boolean(v.requires_components) !== dv.requiresComponents) return true;
    }
    return false;
  }

  /** Chỉ để suy ra kiểu tham số cho `productOrVariantChanged` — không gọi thật. */
  private fetchOneForDiff() {
    return this.prisma.product.findFirst({
      select: {
        id: true,
        sapoId: true,
        alias: true,
        name: true,
        vendor: true,
        productType: true,
        metaTitle: true,
        metaDescription: true,
        summary: true,
        content: true,
        status: true,
        type: true,
        templateLayout: true,
        vatPitCategoryCode: true,
        tags: true,
        publishedOn: true,
        images: { select: { url: true } },
        variants: {
          select: {
            id: true,
            sapoId: true,
            sku: true,
            barcode: true,
            title: true,
            price: true,
            compareAtPrice: true,
            weight: true,
            weightUnit: true,
            unit: true,
            taxable: true,
            requiresShipping: true,
            inventoryManagement: true,
            inventoryPolicy: true,
            lotManagement: true,
            position: true,
            type: true,
            requiresComponents: true,
          },
        },
        _count: { select: { options: true } },
      },
    });
  }

  private async updateExistingProductIfChanged(
    existing: NonNullable<
      Awaited<ReturnType<SapoProductSyncService['fetchOneForDiff']>>
    >,
    s: SapoProduct,
    counts: SapoProductSyncCounts,
  ) {
    if (!this.productOrVariantChanged(existing, s)) return;
    await this.updateExistingProduct(existing, s, counts);
  }

  // ---------------------------------------------------------------- create

  private async resolveSkuForCreate(
    tx: Prisma.TransactionClient,
    desired: string | null,
    sapoVariantId: number,
  ): Promise<{ sku: string; conflict: boolean; reason?: string }> {
    const want = t(desired);
    if (!want) {
      return { sku: `SKU-PENDING-${sapoVariantId}`, conflict: true, reason: 'Sapo không có SKU' };
    }
    const holder = await tx.productVariant.findUnique({
      where: { sku: want },
      select: { id: true },
    });
    if (!holder) return { sku: want, conflict: false };
    return { sku: `SKU-PENDING-${sapoVariantId}`, conflict: true, reason: 'SKU đã bị dòng khác chiếm' };
  }

  private async resolveAliasForCreate(
    tx: Prisma.TransactionClient,
    desired: string | null,
    sapoId: number,
  ): Promise<{ alias: string; conflict: boolean }> {
    const base = t(desired) ?? `sapo-${sapoId}`;
    const holder = await tx.product.findUnique({
      where: { alias: base },
      select: { id: true },
    });
    if (!holder) return { alias: base, conflict: false };
    return { alias: `sapo-${sapoId}`, conflict: true };
  }

  private async createNewProduct(s: SapoProduct, counts: SapoProductSyncCounts) {
    const options = s.options ?? [];
    const includeOptions = options.length > 0 && !isDegenerateOptions(options);

    await this.prisma.$transaction(async (tx) => {
      const { alias, conflict: aliasConflict } = await this.resolveAliasForCreate(
        tx, t(s.alias), s.id,
      );
      if (aliasConflict) {
        counts.aliasConflicts++;
        this.logger.warn(
          `SP Sapo ${s.id}: alias "${t(s.alias)}" đã bị SP khác chiếm, tạm dùng "${alias}"`,
        );
      }

      const product = await tx.product.create({
        data: {
          sapoId: BigInt(s.id),
          alias,
          name: s.name || `SP ${s.id}`,
          vendor: t(s.vendor),
          productType: t(s.product_type),
          metaTitle: t(s.meta_title),
          metaDescription: t(s.meta_description),
          summary: t(s.summary),
          content: t(s.content),
          status: t(s.status) ?? 'draft',
          type: t(s.type) ?? 'normal',
          templateLayout: t(s.template_layout),
          vatPitCategoryCode: t(s.vat_pit_category_code),
          tags: parseTags(s.tags),
          publishedOn: s.published_on ? new Date(s.published_on) : null,
          createdOn: s.created_on ? new Date(s.created_on) : new Date(),
          imageUrl: t(s.image?.src ?? null),
        },
      });

      let optionIds: bigint[] = [];
      if (includeOptions) {
        const sorted = [...options].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
        for (let i = 0; i < sorted.length; i++) {
          const o = await tx.productOption.create({
            data: { productId: product.id, name: sorted[i].name.trim(), position: i },
          });
          optionIds.push(o.id);
        }
        counts.optionsCreated++;
      }

      for (const v of s.variants ?? []) {
        const { sku, conflict, reason } = await this.resolveSkuForCreate(tx, v.sku, v.id);
        if (conflict) {
          counts.skuConflicts++;
          this.logger.warn(
            `Phiên bản Sapo ${v.id} (SP ${s.id}): ${reason} — tạm dùng "${sku}", cần soát tay`,
          );
        }
        const variant = await tx.productVariant.create({
          data: {
            productId: product.id,
            sapoId: BigInt(v.id),
            inventoryItemId:
              v.inventory_item_id != null ? BigInt(v.inventory_item_id) : null,
            sku,
            barcode: t(v.barcode),
            title: t(v.title),
            price: String(v.price ?? 0),
            compareAtPrice:
              v.compare_at_price != null && Number(v.compare_at_price) > 0
                ? String(v.compare_at_price)
                : null,
            weight: v.weight != null ? String(v.weight) : null,
            weightUnit: t(v.weight_unit),
            unit: t(v.unit),
            taxable: Boolean(v.taxable),
            requiresShipping: Boolean(v.requires_shipping),
            inventoryManagement: v.inventory_management ?? 'bizweb',
            inventoryPolicy: t(v.inventory_policy) ?? 'deny',
            lotManagement: Boolean(v.lot_management),
            position: v.position ?? 0,
            type: t(v.type) ?? 'normal',
            requiresComponents: Boolean(v.requires_components),
          },
        });

        if (optionIds.length) {
          const vals = [v.option1, v.option2, v.option3];
          for (let i = 0; i < optionIds.length; i++) {
            const val = t(vals[i]);
            if (!val) continue;
            await tx.variantOptionValue.create({
              data: { variantId: variant.id, optionId: optionIds[i], value: val },
            });
          }
        }
      }

      for (const img of s.images ?? []) {
        await tx.productImage.create({
          data: {
            productId: product.id,
            url: img.src,
            position: img.position ?? 0,
            isPrimary: s.image != null && img.id === s.image.id,
          },
        });
      }
    }, TX_OPTIONS);

    counts.productsCreated++;
  }

  // ---------------------------------------------------------------- update

  private async updateExistingProduct(
    existing: ExistingProduct,
    s: SapoProduct,
    counts: SapoProductSyncCounts,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const desiredAlias = t(s.alias);
      let alias = existing.alias;
      if (desiredAlias && desiredAlias !== existing.alias) {
        const holder = await tx.product.findUnique({
          where: { alias: desiredAlias },
          select: { id: true },
        });
        if (!holder || holder.id === existing.id) {
          alias = desiredAlias;
        } else {
          counts.aliasConflicts++;
          // Không ghi placeholder đè lên alias hiện có (kể cả alias giả cũ) —
          // giữ nguyên, chỉ log để soát tay nếu vẫn đang là dạng "sapo-<id>".
          if (/^sapo-\d+$/i.test(existing.alias)) {
            this.logger.warn(
              `SP Sapo ${s.id}: muốn đổi alias "${existing.alias}" -> "${desiredAlias}" nhưng đã bị SP khác chiếm`,
            );
          }
        }
      }

      await tx.product.update({
        where: { id: existing.id },
        data: {
          alias,
          name: s.name || undefined,
          vendor: t(s.vendor),
          productType: t(s.product_type),
          metaTitle: t(s.meta_title),
          metaDescription: t(s.meta_description),
          summary: t(s.summary),
          content: t(s.content),
          status: t(s.status) ?? 'draft',
          type: t(s.type) ?? 'normal',
          templateLayout: t(s.template_layout),
          vatPitCategoryCode: t(s.vat_pit_category_code),
          tags: parseTags(s.tags),
          publishedOn: s.published_on ? new Date(s.published_on) : null,
          // category/material/craftType/isDiscontinued: field riêng dự án,
          // Sapo không có — KHÔNG đụng.
        },
      });

      const dbVariantBySapoId = new Map(
        existing.variants
          .filter((v) => v.sapoId != null)
          .map((v) => [v.sapoId!.toString(), v]),
      );

      for (const v of s.variants ?? []) {
        const local = dbVariantBySapoId.get(String(v.id));
        if (local) {
          await this.updateVariant(tx, local, v, s.id, counts);
        } else {
          await this.createVariantOnExistingProduct(tx, existing.id, v, s.id, counts);
        }
      }

      await this.resyncImagesIfChanged(tx, existing.id, s, counts);

      const currentOptionCount = await tx.productOption.count({
        where: { productId: existing.id },
      });
      if (currentOptionCount === 0) {
        const options = s.options ?? [];
        if (options.length && !isDegenerateOptions(options)) {
          await this.createOptionsForProduct(tx, existing.id, options, s.variants ?? []);
          counts.optionsCreated++;
        }
      }
    }, TX_OPTIONS);

    counts.productsUpdated++;
  }

  private async updateVariant(
    tx: Prisma.TransactionClient,
    local: { id: bigint; sku: string },
    v: SapoVariant,
    sapoProductId: number,
    counts: SapoProductSyncCounts,
  ) {
    const desiredSku = t(v.sku);
    let skuPatch: string | undefined;
    if (desiredSku && desiredSku !== local.sku) {
      const holder = await tx.productVariant.findUnique({
        where: { sku: desiredSku },
        select: { id: true },
      });
      if (!holder || holder.id === local.id) {
        skuPatch = desiredSku;
      } else {
        counts.skuConflicts++;
        // Vẫn đang mã tạm (di sản đợt import cũ hoặc do lần sync trước xung
        // đột) — log để soát tay. Nếu SKU hiện tại đã là mã thật khác thì đây
        // chỉ là Sapo trả SKU khác trước đó (sản phẩm/biến thể bị đổi mã bên
        // Sapo) — cũng giữ nguyên, không đoán.
        if (/^(SP|SAPO-V|SKU-PENDING)-\d+$/i.test(local.sku)) {
          this.logger.warn(
            `Phiên bản Sapo ${v.id} (SP ${sapoProductId}): muốn đổi sku "${local.sku}" -> "${desiredSku}" nhưng đã bị dòng khác chiếm`,
          );
        }
      }
    }

    await tx.productVariant.update({
      where: { id: local.id },
      data: {
        ...(skuPatch !== undefined ? { sku: skuPatch } : {}),
        barcode: t(v.barcode),
        title: t(v.title),
        price: String(v.price ?? 0),
        compareAtPrice:
          v.compare_at_price != null && Number(v.compare_at_price) > 0
            ? String(v.compare_at_price)
            : null,
        weight: v.weight != null ? String(v.weight) : null,
        weightUnit: t(v.weight_unit),
        unit: t(v.unit),
        taxable: Boolean(v.taxable),
        requiresShipping: Boolean(v.requires_shipping),
        inventoryManagement: v.inventory_management ?? 'bizweb',
        inventoryPolicy: t(v.inventory_policy) ?? 'deny',
        lotManagement: Boolean(v.lot_management),
        position: v.position ?? 0,
        type: t(v.type) ?? 'normal',
        requiresComponents: Boolean(v.requires_components),
        // cost/enabled/imageUrl: field riêng dự án hoặc nguồn khác — KHÔNG đụng.
      },
    });
    counts.variantsUpdated++;
  }

  private async createVariantOnExistingProduct(
    tx: Prisma.TransactionClient,
    productId: bigint,
    v: SapoVariant,
    sapoProductId: number,
    counts: SapoProductSyncCounts,
  ) {
    const { sku, conflict, reason } = await this.resolveSkuForCreate(tx, v.sku, v.id);
    if (conflict) {
      counts.skuConflicts++;
      this.logger.warn(
        `Phiên bản Sapo ${v.id} (SP ${sapoProductId}): ${reason} — tạm dùng "${sku}", cần soát tay`,
      );
    }
    const variant = await tx.productVariant.create({
      data: {
        productId,
        sapoId: BigInt(v.id),
        inventoryItemId: v.inventory_item_id != null ? BigInt(v.inventory_item_id) : null,
        sku,
        barcode: t(v.barcode),
        title: t(v.title),
        price: String(v.price ?? 0),
        compareAtPrice:
          v.compare_at_price != null && Number(v.compare_at_price) > 0
            ? String(v.compare_at_price)
            : null,
        weight: v.weight != null ? String(v.weight) : null,
        weightUnit: t(v.weight_unit),
        unit: t(v.unit),
        taxable: Boolean(v.taxable),
        requiresShipping: Boolean(v.requires_shipping),
        inventoryManagement: v.inventory_management ?? 'bizweb',
        inventoryPolicy: t(v.inventory_policy) ?? 'deny',
        lotManagement: Boolean(v.lot_management),
        position: v.position ?? 0,
        type: t(v.type) ?? 'normal',
        requiresComponents: Boolean(v.requires_components),
      },
    });
    counts.variantsCreated++;

    // Gắn giá trị tuỳ chọn nếu SP đã có sẵn bộ option (khớp theo thứ tự
    // position, giống option1/2/3 phẳng của Sapo).
    const options = await tx.productOption.findMany({
      where: { productId },
      orderBy: { position: 'asc' },
      select: { id: true },
    });
    if (options.length) {
      const vals = [v.option1, v.option2, v.option3];
      for (let i = 0; i < options.length; i++) {
        const val = t(vals[i]);
        if (!val) continue;
        await tx.variantOptionValue.create({
          data: { variantId: variant.id, optionId: options[i].id, value: val },
        });
      }
    }
  }

  private async createOptionsForProduct(
    tx: Prisma.TransactionClient,
    productId: bigint,
    options: SapoOption[],
    sapoVariants: SapoVariant[],
  ) {
    const sorted = [...options].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    const optionIds: bigint[] = [];
    for (let i = 0; i < sorted.length; i++) {
      const o = await tx.productOption.create({
        data: { productId, name: sorted[i].name.trim(), position: i },
      });
      optionIds.push(o.id);
    }
    const localVariants = await tx.productVariant.findMany({
      where: { productId },
      select: { id: true, sapoId: true },
    });
    const bySapoId = new Map(
      localVariants.filter((v) => v.sapoId != null).map((v) => [v.sapoId!.toString(), v.id]),
    );
    for (const v of sapoVariants) {
      const localId = bySapoId.get(String(v.id));
      if (!localId) continue;
      const vals = [v.option1, v.option2, v.option3];
      for (let i = 0; i < optionIds.length; i++) {
        const val = t(vals[i]);
        if (!val) continue;
        await tx.variantOptionValue.create({
          data: { variantId: localId, optionId: optionIds[i], value: val },
        });
      }
    }
  }

  private async resyncImagesIfChanged(
    tx: Prisma.TransactionClient,
    productId: bigint,
    s: SapoProduct,
    counts: SapoProductSyncCounts,
  ) {
    const current = await tx.productImage.findMany({
      where: { productId },
      select: { url: true },
    });
    const currentUrls = new Set(current.map((c) => c.url));
    const sapoUrls = new Set((s.images ?? []).map((i) => i.src));
    const same =
      currentUrls.size === sapoUrls.size &&
      [...sapoUrls].every((u) => currentUrls.has(u));
    if (same) return;

    await tx.productImage.deleteMany({ where: { productId } });
    if (s.images?.length) {
      await tx.productImage.createMany({
        data: s.images.map((img) => ({
          productId,
          url: img.src,
          position: img.position ?? 0,
          isPrimary: s.image != null && img.id === s.image.id,
        })),
      });
    }
    counts.imagesResynced++;

    const wantUrl = t(s.image?.src ?? null);
    if (wantUrl) {
      await tx.product.update({ where: { id: productId }, data: { imageUrl: wantUrl } });
    }
  }
}
