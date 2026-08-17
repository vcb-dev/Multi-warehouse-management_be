import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Response } from 'express';
import {
  EXPORT_ROW_LIMIT,
  ExportField,
  describeFields,
  exportFilename,
  resolveFields,
  streamXlsx,
  vnDateTime,
} from '../../common/utils/xlsx-export';
import { ExportProductsQueryDto } from './product.dto';
import { ProductRepository } from './product.repository';
import { ProductService } from './product.service';

/** Số sản phẩm nạp mỗi lượt truy vấn khi stream — xem ghi chú lô ở order-export.service.ts */
const BATCH_SIZE = 2000;

const exportInclude = {
  variants: { where: { enabled: true }, orderBy: { id: 'asc' } },
} satisfies Prisma.ProductInclude;

type ExportProduct = Prisma.ProductGetPayload<{
  include: typeof exportInclude;
}>;
type ExportVariant = ExportProduct['variants'][number];

/** Mỗi phiên bản là một dòng; sản phẩm không có phiên bản vẫn ra đúng 1 dòng */
type ProductRow = {
  index: number;
  product: ExportProduct;
  variant: ExportVariant | null;
};

const G_PRODUCT = 'Thông tin sản phẩm';
const G_VARIANT = 'Thông tin phiên bản';
const G_PRICE = 'Giá & kho';

/**
 * Bộ trường `default: true` giữ nguyên 12 cột cũ theo đúng thứ tự — file xuất
 * mặc định vẫn nhập ngược lại được qua `SAPO_PRODUCT_HEADERS`. Người dùng tự
 * đổi cột thì file đó không còn dùng làm file nhập.
 */
const PRODUCT_FIELDS: ExportField<ProductRow>[] = [
  {
    key: 'alias',
    header: 'Đường dẫn/Alias',
    group: G_PRODUCT,
    width: 24,
    default: true,
    value: (r) => r.product.alias,
  },
  {
    key: 'name',
    header: 'Tên sản phẩm*',
    group: G_PRODUCT,
    width: 40,
    locked: true,
    default: true,
    value: (r) => r.product.name,
  },
  {
    key: 'vendor',
    header: 'Nhãn hiệu',
    group: G_PRODUCT,
    width: 20,
    default: true,
    value: (r) => r.product.vendor ?? '',
  },
  {
    key: 'product_type',
    header: 'Loại sản phẩm',
    group: G_PRODUCT,
    width: 16,
    default: true,
    value: (r) => r.product.productType ?? '',
  },
  {
    key: 'tags',
    header: 'Tags',
    group: G_PRODUCT,
    width: 24,
    default: true,
    value: (r) => r.product.tags.join(', '),
  },
  {
    key: 'unit',
    header: 'Đơn vị tính',
    group: G_VARIANT,
    width: 12,
    default: true,
    value: (r) => r.variant?.unit ?? '',
  },
  {
    key: 'is_published',
    header: 'Hiển thị*',
    group: G_PRODUCT,
    width: 10,
    default: true,
    value: (r) => (r.product.status === 'active' ? 'Có' : 'Không'),
  },
  {
    key: 'sku',
    header: 'Mã SKU',
    group: G_VARIANT,
    width: 20,
    default: true,
    value: (r) => r.variant?.sku ?? '',
  },
  {
    key: 'price',
    header: 'Giá',
    group: G_PRICE,
    width: 14,
    default: true,
    value: (r) => (r.variant ? Number(r.variant.price) : 0),
  },
  {
    key: 'compare_at_price',
    header: 'Giá so sánh',
    group: G_PRICE,
    width: 14,
    default: true,
    value: (r) =>
      r.variant?.compareAtPrice ? Number(r.variant.compareAtPrice) : '',
  },
  {
    key: 'cost',
    header: 'Giá vốn',
    group: G_PRICE,
    width: 14,
    default: true,
    value: (r) => (r.variant ? Number(r.variant.cost) : ''),
  },
  {
    key: 'barcode',
    header: 'Barcode',
    group: G_VARIANT,
    width: 16,
    default: true,
    value: (r) => r.variant?.barcode ?? '',
  },

  {
    key: 'id',
    header: 'ID sản phẩm',
    group: G_PRODUCT,
    width: 16,
    value: (r) => r.product.id.toString(),
  },
  {
    key: 'variant_id',
    header: 'ID phiên bản',
    group: G_VARIANT,
    width: 16,
    value: (r) => r.variant?.id.toString() ?? '',
  },
  {
    key: 'variant_title',
    header: 'Tên phiên bản',
    group: G_VARIANT,
    width: 24,
    value: (r) => r.variant?.title ?? '',
  },
  {
    key: 'status',
    header: 'Trạng thái',
    group: G_PRODUCT,
    width: 14,
    value: (r) => r.product.status,
  },
  {
    key: 'description',
    header: 'Mô tả',
    group: G_PRODUCT,
    width: 40,
    value: (r) => stripHtml(r.product.content),
  },
  {
    key: 'created_on',
    header: 'Ngày tạo',
    group: G_PRODUCT,
    width: 18,
    value: (r) => vnDateTime(r.product.createdOn),
  },
  {
    key: 'modified_on',
    header: 'Ngày cập nhật',
    group: G_PRODUCT,
    width: 18,
    value: (r) => vnDateTime(r.product.modifiedOn),
  },
];

function stripHtml(html: string | null): string {
  if (!html) return '';
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

@Injectable()
export class ProductExportService {
  constructor(
    private products: ProductService,
    private repo: ProductRepository,
  ) {}

  /** Danh sách trường cho dialog "Tùy chọn trường dữ liệu xuất" */
  fields() {
    return { data: describeFields(PRODUCT_FIELDS) };
  }

  async export(query: ExportProductsQueryDto, res: Response): Promise<void> {
    const where = await this.buildExportWhere(query);

    await streamXlsx(res, {
      filename: exportFilename('san-pham'),
      sheetName: 'San pham',
      fields: resolveFields(PRODUCT_FIELDS, query.fields),
      batches: this.productRows(where),
    });
  }

  /** Trải sản phẩm thành dòng file: mỗi phiên bản một dòng */
  private async *productRows(
    where: Prisma.ProductWhereInput,
  ): AsyncGenerator<ProductRow[]> {
    let index = 0;
    for await (const products of this.iterateProducts(where)) {
      const rows: ProductRow[] = [];
      for (const product of products) {
        if (product.variants.length) {
          for (const variant of product.variants) {
            rows.push({ index: ++index, product, variant });
          }
        } else {
          rows.push({ index: ++index, product, variant: null });
        }
      }
      yield rows;
    }
  }

  /**
   * `ids` (sản phẩm được chọn / đang hiển thị) chỉ thu hẹp thêm chứ không thay
   * thế bộ lọc màn hình, để file xuất luôn nằm trong đúng phạm vi đang xem.
   */
  private async buildExportWhere(
    query: ExportProductsQueryDto,
  ): Promise<Prisma.ProductWhereInput> {
    const where = await this.products.buildListWhere(query);
    const ids = (query.ids ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!ids.length) return where;
    return { AND: [where, { id: { in: ids.map((id) => BigInt(id)) } }] };
  }

  /** Keyset theo (modifiedOn, id) giảm dần — cùng thứ tự với bảng danh sách */
  private async *iterateProducts(
    where: Prisma.ProductWhereInput,
  ): AsyncGenerator<ExportProduct[]> {
    let cursor: { modifiedOn: Date; id: bigint } | null = null;
    let fetched = 0;

    while (fetched < EXPORT_ROW_LIMIT) {
      const keyset: Prisma.ProductWhereInput | null = cursor
        ? {
            OR: [
              { modifiedOn: { lt: cursor.modifiedOn } },
              { modifiedOn: cursor.modifiedOn, id: { lt: cursor.id } },
            ],
          }
        : null;

      const batch: ExportProduct[] = await this.repo.client.product.findMany({
        where: keyset ? { AND: [where, keyset] } : where,
        orderBy: [{ modifiedOn: 'desc' }, { id: 'desc' }],
        take: BATCH_SIZE,
        include: exportInclude,
      });
      if (!batch.length) return;

      fetched += batch.length;
      const last = batch[batch.length - 1];
      cursor = { modifiedOn: last.modifiedOn, id: last.id };
      yield batch;

      if (batch.length < BATCH_SIZE) return;
    }
  }
}
