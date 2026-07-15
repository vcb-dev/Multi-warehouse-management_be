import { Injectable } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { InventoryBucket, MovementType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { ListInventoryQueryDto } from './inventory.dto';
import { InventoryQueryService } from './inventory-query.service';
import { InventoryService } from './inventory.service';

const EXPORT_COLUMNS = [
  { header: 'Mã SKU', key: 'sku', width: 20 },
  { header: 'Sản phẩm', key: 'product_name', width: 40 },
  { header: 'Giá bán', key: 'price', width: 14 },
  { header: 'Giá vốn', key: 'cost', width: 14 },
  { header: 'Đơn vị tính', key: 'unit', width: 12 },
  { header: 'Tồn kho', key: 'on_hand', width: 12 },
  { header: 'Có thể bán', key: 'available', width: 12 },
  { header: 'Đang giao dịch', key: 'committed', width: 14 },
  { header: 'Đang về kho', key: 'incoming', width: 12 },
  { header: 'Đang đóng gói', key: 'packing', width: 14 },
  { header: 'Không thể bán', key: 'unavailable', width: 14 },
];

const IMPORT_HEADERS: Record<string, string> = {
  'Mã SKU': 'sku',
  'Tồn kho': 'on_hand',
};

function buildColumnMap(sheet: ExcelJS.Worksheet): Map<string, number> {
  const map = new Map<string, number>();
  const headerRow = sheet.getRow(1);
  headerRow.eachCell((cell, colNumber) => {
    const label = String(cell.value ?? '').trim();
    const field = IMPORT_HEADERS[label];
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

@Injectable()
export class InventoryExportService {
  constructor(private queryService: InventoryQueryService) {}

  async exportExcel(
    query: ListInventoryQueryDto,
    user: AuthUser,
  ): Promise<Buffer> {
    const rows = await this.queryService.exportRows(query, user);

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Ton kho');
    sheet.columns = EXPORT_COLUMNS;

    for (const r of rows) {
      sheet.addRow({
        sku: r.sku,
        product_name: r.product_name,
        price: Number(r.price),
        cost: Number(r.cost),
        unit: r.unit ?? '',
        on_hand: r.on_hand,
        available: r.available,
        committed: r.committed,
        incoming: r.incoming,
        packing: r.packing,
        unavailable: r.unavailable,
      });
    }

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }
}

@Injectable()
export class InventoryImportService {
  constructor(
    private prisma: PrismaService,
    private inventory: InventoryService,
  ) {}

  async importExcel(buffer: Buffer, warehouseId: bigint, user: AuthUser) {
    this.inventory.assertWarehouseAccess(user, warehouseId);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
    const sheet = workbook.worksheets[0];
    if (!sheet) {
      return { updated: 0, errors: [{ row: 0, message: 'Sheet trống' }] };
    }

    const cols = buildColumnMap(sheet);
    if (!cols.has('sku') || !cols.has('on_hand')) {
      return {
        updated: 0,
        errors: [{ row: 1, message: 'Thiếu cột "Mã SKU" hoặc "Tồn kho"' }],
      };
    }

    let updated = 0;
    const errors: { row: number; message: string }[] = [];

    for (let i = 2; i <= sheet.rowCount; i++) {
      const row = sheet.getRow(i);
      const sku = cellStr(row, cols.get('sku'));
      if (!sku) continue;

      const targetOnHand = cellNum(row, cols.get('on_hand'));

      try {
        const variant = await this.prisma.productVariant.findUnique({
          where: { sku },
        });
        if (!variant) {
          errors.push({ row: i, message: `Không tìm thấy SKU "${sku}"` });
          continue;
        }

        const level = await this.prisma.inventoryLevel.findUnique({
          where: {
            variantId_warehouseId: { variantId: variant.id, warehouseId },
          },
        });
        const currentOnHand = level?.onHand ?? 0;
        const change = targetOnHand - currentOnHand;
        if (change === 0) continue;

        await this.inventory.applyMovement({
          variantId: variant.id,
          warehouseId,
          bucket: InventoryBucket.on_hand,
          change,
          type: MovementType.adjust,
          referenceType: 'import',
          createdById: user.userId,
        });
        updated += 1;
      } catch (e) {
        errors.push({
          row: i,
          message: e instanceof Error ? e.message : 'Lỗi không xác định',
        });
      }
    }

    return { updated, errors };
  }
}
