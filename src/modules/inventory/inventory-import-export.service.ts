import { Injectable } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import type { Response } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { assertLocationPermission } from '../../common/auth/access';
import {
  EXPORT_ROW_LIMIT,
  ExportField,
  describeFields,
  exportFilename,
  resolveFields,
  singleBatch,
  streamXlsx,
} from '../../common/utils/xlsx-export';
import { ExportInventoryQueryDto } from './inventory.dto';
import { InventoryQueryService } from './inventory-query.service';
import { InventoryService } from './inventory.service';

type InventoryRow = Awaited<
  ReturnType<InventoryQueryService['exportRows']>
>[number];

const G_PRODUCT = 'Thông tin sản phẩm';
const G_STOCK = 'Tồn kho';
const G_NXT = 'Nhập xuất tồn';
const G_ADVICE = 'Gợi ý nhập hàng';

/**
 * `default: true` giữ nguyên bộ cột cũ của màn Tồn kho theo đúng thứ tự — file
 * xuất mặc định không đổi so với trước, người dùng muốn khác thì tự chọn trong
 * dialog "Tùy chọn trường dữ liệu xuất".
 */
const INVENTORY_FIELDS: ExportField<InventoryRow>[] = [
  {
    key: 'ma_sp',
    header: 'Mã SP',
    group: G_PRODUCT,
    width: 14,
    default: true,
    value: (r) => r.ma_sp,
  },
  {
    key: 'sku',
    header: 'Mã SKU',
    group: G_PRODUCT,
    width: 20,
    locked: true,
    default: true,
    value: (r) => r.sku,
  },
  {
    key: 'product_name',
    header: 'Sản phẩm',
    group: G_PRODUCT,
    width: 40,
    default: true,
    value: (r) => r.product_name,
  },
  {
    key: 'price',
    header: 'Giá bán',
    group: G_PRODUCT,
    width: 14,
    default: true,
    value: (r) => Number(r.price),
  },
  {
    key: 'cost',
    header: 'Giá vốn',
    group: G_PRODUCT,
    width: 14,
    default: true,
    value: (r) => Number(r.cost),
  },
  {
    key: 'unit',
    header: 'Đơn vị tính',
    group: G_PRODUCT,
    width: 12,
    default: true,
    value: (r) => r.unit ?? '',
  },
  {
    key: 'ton_dau_ky',
    header: 'Tồn đầu kì',
    group: G_NXT,
    width: 12,
    default: true,
    value: (r) => r.ton_dau_ky,
  },
  {
    key: 'sl_nhap',
    header: 'SL Nhập',
    group: G_NXT,
    width: 10,
    default: true,
    value: (r) => r.sl_nhap,
  },
  {
    key: 'sl_xuat',
    header: 'SL Xuất',
    group: G_NXT,
    width: 10,
    default: true,
    value: (r) => r.sl_xuat,
  },
  {
    key: 'on_hand',
    header: 'Tồn kho',
    group: G_STOCK,
    width: 12,
    default: true,
    value: (r) => r.on_hand,
  },
  {
    key: 'available',
    header: 'Có thể bán',
    group: G_STOCK,
    width: 12,
    default: true,
    value: (r) => r.available,
  },
  {
    key: 'ban_15',
    header: 'Bán 15 ngày',
    group: G_NXT,
    width: 12,
    default: true,
    value: (r) => r.ban_15,
  },
  {
    key: 'ban_30',
    header: 'Bán 30 ngày',
    group: G_NXT,
    width: 12,
    default: true,
    value: (r) => r.ban_30,
  },
  {
    key: 'ban_90',
    header: 'Bán 90 ngày',
    group: G_NXT,
    width: 12,
    default: true,
    value: (r) => r.ban_90,
  },
  {
    key: 'committed',
    header: 'Hàng đặt',
    group: G_STOCK,
    width: 12,
    default: true,
    value: (r) => r.committed,
  },
  {
    key: 'nk_dang_ve',
    header: 'Hàng NK đang về',
    group: G_STOCK,
    width: 15,
    default: true,
    value: (r) => r.nk_dang_ve,
  },
  {
    key: 'ck_dang_ve',
    header: 'Chuyển kho đang về',
    group: G_STOCK,
    width: 17,
    default: true,
    value: (r) => r.ck_dang_ve,
  },
  {
    key: 'dm_ton_min_15',
    header: 'ĐM tồn MIN 15 ngày',
    group: G_ADVICE,
    width: 17,
    default: true,
    value: (r) => r.dm_ton_min_15,
  },
  {
    key: 'can_nhap_15',
    header: 'Cần nhập đủ bán 15 ngày',
    group: G_ADVICE,
    width: 20,
    default: true,
    value: (r) => r.can_nhap_15,
  },
  {
    key: 'isr',
    header: 'Tồn/Bán (ISR)',
    group: G_ADVICE,
    width: 12,
    default: true,
    value: (r) => r.isr ?? '',
  },
  {
    key: 'tinh_trang',
    header: 'Tình trạng',
    group: G_ADVICE,
    width: 24,
    default: true,
    value: (r) => r.tinh_trang,
  },
  {
    key: 'ncc',
    header: 'NCC',
    group: G_PRODUCT,
    width: 24,
    default: true,
    value: (r) => r.ncc ?? '',
  },
  {
    key: 'nhom_hang_1',
    header: 'Nhóm hàng 1',
    group: G_PRODUCT,
    width: 16,
    default: true,
    value: (r) => r.nhom_hang_1 ?? '',
  },
  {
    key: 'nhom_hang_2',
    header: 'Nhóm hàng 2',
    group: G_PRODUCT,
    width: 16,
    default: true,
    value: (r) => r.nhom_hang_2 ?? '',
  },
  {
    key: 'nhom_hang_3',
    header: 'Nhóm hàng 3',
    group: G_PRODUCT,
    width: 16,
    default: true,
    value: (r) => r.nhom_hang_3 ?? '',
  },
  {
    key: 'packed',
    header: 'Đang đóng gói',
    group: G_STOCK,
    width: 14,
    default: true,
    value: (r) => r.packed,
  },
  {
    key: 'unavailable',
    header: 'Không thể bán',
    group: G_STOCK,
    width: 14,
    default: true,
    value: (r) => r.unavailable,
  },

  {
    key: 'location_name',
    header: 'Kho',
    group: G_STOCK,
    width: 24,
    value: (r) => r.location_name,
  },
  {
    key: 'location_code',
    header: 'Mã kho',
    group: G_STOCK,
    width: 14,
    value: (r) => r.location_code,
  },
  {
    key: 'incoming',
    header: 'Hàng đang về',
    group: G_STOCK,
    width: 14,
    value: (r) => r.incoming,
  },
  {
    key: 'xep_loai_ban',
    header: 'Xếp loại bán',
    group: G_ADVICE,
    width: 16,
    value: (r) => r.xep_loai_ban,
  },
  {
    key: 'variant_id',
    header: 'ID phiên bản',
    group: G_PRODUCT,
    width: 16,
    value: (r) => r.variant_id,
  },
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

  /** Danh sách trường cho dialog "Tùy chọn trường dữ liệu xuất" */
  fields() {
    return { data: describeFields(INVENTORY_FIELDS) };
  }

  async export(
    query: ExportInventoryQueryDto,
    user: AuthUser,
    res: Response,
  ): Promise<void> {
    // Tồn kho nạp trọn tập rồi mới ghi (NXT phải enrich theo lô) — chặn trần ở
    // tầng truy vấn thay vì chỉ cắt lúc ghi, để không kéo về dữ liệu thừa.
    const rows = await this.queryService.exportRows(
      { ...query, page: 1, page_size: EXPORT_ROW_LIMIT },
      user,
    );

    await streamXlsx(res, {
      filename: exportFilename('ton-kho'),
      sheetName: 'Ton kho',
      fields: resolveFields(INVENTORY_FIELDS, query.fields),
      batches: singleBatch(rows),
    });
  }
}

@Injectable()
export class InventoryImportService {
  constructor(
    private prisma: PrismaService,
    private inventory: InventoryService,
  ) {}

  async importExcel(buffer: Buffer, locationId: bigint, user: AuthUser) {
    assertLocationPermission(user, 'inventory:receive', locationId);

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
          locationId,
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
