import { Injectable } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { ProductRepository } from './product.repository';
import { ProductService } from './product.service';

/** Cột Excel Sapo — `Sản phẩm/Danh_sách_sản_phẩm.xlsx` */
const SAPO_PRODUCT_HEADERS: Record<string, string> = {
  'Đường dẫn/Alias': 'alias',
  'Tên sản phẩm*': 'name',
  'Tên sản phẩm': 'name',
  'Nhãn hiệu': 'vendor',
  'Loại sản phẩm': 'product_type',
  Tags: 'tags',
  'Đơn vị tính': 'unit',
  'Hiển thị*': 'is_published',
  'Hiển thị': 'is_published',
  'Mã SKU': 'sku',
  Giá: 'price',
  'Giá so sánh': 'compare_at_price',
  'Giá vốn': 'cost',
  Barcode: 'barcode',
};

function buildColumnMap(sheet: ExcelJS.Worksheet): Map<string, number> {
  const map = new Map<string, number>();
  const headerRow = sheet.getRow(1);
  headerRow.eachCell((cell, colNumber) => {
    const label = String(cell.value ?? '').trim();
    const field = SAPO_PRODUCT_HEADERS[label];
    if (field) map.set(field, colNumber);
  });
  return map;
}

function cellStr(row: ExcelJS.Row, col?: number): string {
  if (!col) return '';
  return String(row.getCell(col).value ?? '').trim();
}

function cellNum(row: ExcelJS.Row, col?: number): number {
  if (!col) return 0;
  const v = row.getCell(col).value;
  if (v == null || v === '') return 0;
  return Number(v);
}

function parseBool(raw: string): boolean {
  const v = raw.toLowerCase();
  return v === 'có' || v === 'co' || v === 'yes' || v === 'true' || v === '1';
}

function parseTags(raw: string): string[] {
  if (!raw) return [];
  return raw
    .split(/[,;]/)
    .map((t) => t.trim())
    .filter(Boolean);
}

@Injectable()
export class ProductImportService {
  constructor(
    private products: ProductService,
    private repo: ProductRepository,
  ) {}

  async importExcel(buffer: Buffer, user: AuthUser) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
    const sheet = workbook.worksheets[0];
    if (!sheet) {
      return {
        created: 0,
        updated: 0,
        errors: [{ row: 0, message: 'Sheet trống' }],
      };
    }

    const cols = buildColumnMap(sheet);
    if (!cols.has('name') && !cols.has('sku')) {
      return {
        created: 0,
        updated: 0,
        errors: [{ row: 1, message: 'Không nhận diện được header Excel Sapo' }],
      };
    }

    let created = 0;
    let updated = 0;
    const errors: { row: number; message: string }[] = [];

    for (let i = 2; i <= sheet.rowCount; i++) {
      const row = sheet.getRow(i);
      const name = cellStr(row, cols.get('name'));
      const sku = cellStr(row, cols.get('sku'));
      const price = cellNum(row, cols.get('price'));
      const vendor = cellStr(row, cols.get('vendor')) || undefined;
      const productType = cellStr(row, cols.get('product_type')) || undefined;
      const unit = cellStr(row, cols.get('unit')) || undefined;
      const tags = parseTags(cellStr(row, cols.get('tags')));
      const publishedRaw = cellStr(row, cols.get('is_published'));
      const isPublished = publishedRaw ? parseBool(publishedRaw) : true;

      if (!name && !sku) continue;
      if (!name || !sku) {
        errors.push({ row: i, message: 'Thiếu tên hoặc SKU' });
        continue;
      }

      try {
        const existing = await this.repo.findVariantBySku(sku);
        const variantPayload = {
          option_values: [] as string[],
          sku,
          price: price || 0,
          compare_at_price:
            cellNum(row, cols.get('compare_at_price')) || undefined,
          cost: cellNum(row, cols.get('cost')) || undefined,
          barcode: cellStr(row, cols.get('barcode')) || undefined,
        };

        if (existing) {
          await this.products.update(
            existing.productId,
            {
              name,
              vendor,
              product_type: productType,
              unit,
              tags,
              is_published: isPublished,
              variants: [variantPayload],
            },
            user,
          );
          updated += 1;
        } else {
          await this.products.create(
            {
              name,
              vendor,
              product_type: productType,
              unit,
              tags,
              is_published: isPublished,
              variants: [variantPayload],
            },
            user,
          );
          created += 1;
        }
      } catch (e) {
        errors.push({
          row: i,
          message: e instanceof Error ? e.message : 'Lỗi không xác định',
        });
      }
    }

    return { created, updated, errors };
  }
}
