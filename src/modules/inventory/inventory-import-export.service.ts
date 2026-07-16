import { Injectable } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { ListInventoryQueryDto } from './inventory.dto';
import { InventoryQueryService } from './inventory-query.service';
import { InventoryService } from './inventory.service';

const EXPORT_COLUMNS = [
  { header: 'Mã SP', key: 'ma_sp', width: 14 },
  { header: 'Mã SKU', key: 'sku', width: 20 },
  { header: 'Sản phẩm', key: 'product_name', width: 40 },
  { header: 'Giá bán', key: 'price', width: 14 },
  { header: 'Giá vốn', key: 'cost', width: 14 },
  { header: 'Đơn vị tính', key: 'unit', width: 12 },
  { header: 'Tồn đầu kì', key: 'ton_dau_ky', width: 12 },
  { header: 'SL Nhập', key: 'sl_nhap', width: 10 },
  { header: 'SL Xuất', key: 'sl_xuat', width: 10 },
  { header: 'Tồn kho', key: 'on_hand', width: 12 },
  { header: 'Có thể bán', key: 'available', width: 12 },
  { header: 'Bán 15 ngày', key: 'ban_15', width: 12 },
  { header: 'Bán 30 ngày', key: 'ban_30', width: 12 },
  { header: 'Bán 90 ngày', key: 'ban_90', width: 12 },
  { header: 'Hàng đặt', key: 'committed', width: 12 },
  { header: 'Hàng NK đang về', key: 'nk_dang_ve', width: 15 },
  { header: 'Chuyển kho đang về', key: 'ck_dang_ve', width: 17 },
  { header: 'ĐM tồn MIN 15 ngày', key: 'dm_ton_min_15', width: 17 },
  { header: 'Cần nhập đủ bán 15 ngày', key: 'can_nhap_15', width: 20 },
  { header: 'Tồn/Bán (ISR)', key: 'isr', width: 12 },
  { header: 'Tình trạng', key: 'tinh_trang', width: 24 },
  { header: 'NCC', key: 'ncc', width: 24 },
  { header: 'Nhóm hàng 1', key: 'nhom_hang_1', width: 16 },
  { header: 'Nhóm hàng 2', key: 'nhom_hang_2', width: 16 },
  { header: 'Nhóm hàng 3', key: 'nhom_hang_3', width: 16 },
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
        ma_sp: r.ma_sp,
        sku: r.sku,
        product_name: r.product_name,
        price: Number(r.price),
        cost: Number(r.cost),
        unit: r.unit ?? '',
        ton_dau_ky: r.ton_dau_ky,
        sl_nhap: r.sl_nhap,
        sl_xuat: r.sl_xuat,
        on_hand: r.on_hand,
        available: r.available,
        ban_15: r.ban_15,
        ban_30: r.ban_30,
        ban_90: r.ban_90,
        committed: r.committed,
        nk_dang_ve: r.nk_dang_ve,
        ck_dang_ve: r.ck_dang_ve,
        dm_ton_min_15: r.dm_ton_min_15,
        can_nhap_15: r.can_nhap_15,
        isr: r.isr ?? '',
        tinh_trang: r.tinh_trang,
        ncc: r.ncc ?? '',
        nhom_hang_1: r.nhom_hang_1 ?? '',
        nhom_hang_2: r.nhom_hang_2 ?? '',
        nhom_hang_3: r.nhom_hang_3 ?? '',
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

        const result = await this.inventory.adjustOnHandTo({
          variantId: variant.id,
          warehouseId,
          targetOnHand,
          referenceType: 'import',
          createdById: user.userId,
        });
        if (!result) continue;
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
