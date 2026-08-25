import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { BusinessException } from '../../../common/exceptions/business.exception';
import { SapoClient } from '../../products/sapo-sync/sapo-client';

/**
 * Đồng bộ danh sách kho/chi nhánh (`locations`) từ Sapo.
 *
 * Vì sao cần: 16 location trong DB được nạp ĐÚNG MỘT LẦN bằng migration
 * `20260728040000_sapo_locations_merge`, sau đó không có gì cập nhật nữa — trong `src/`
 * trước file này không có một lời gọi `/admin/locations.json` nào. Shop lập kho mới khá
 * thường xuyên (5 kho VAT mới chỉ trong tháng 4–7/2026), mà kho mới không có trong DB thì:
 *
 * - đơn từ kho đó rơi về kho mặc định (xem `SapoOrderSyncService`), sai chỗ mà không ai biết;
 * - tồn của kho đó không bao giờ được kéo về (`SapoInventorySyncService` chỉ đụng kho có
 *   `sapo_id` khớp).
 *
 * Ba quy ước:
 *
 * 1. **Không bao giờ xoá.** Sapo không trả về một kho không có nghĩa là kho đó biến mất —
 *    có thể chỉ bị ẩn/phân quyền. Mà kho đã có đơn/tồn trỏ vào thì xoá cũng không được
 *    (FK RESTRICT). Kho vắng mặt chỉ được báo cáo, không đụng.
 *
 * 2. **Sapo sở hữu thông tin mô tả** (tên, trạng thái, địa chỉ, các cờ fulfill/inventory) —
 *    ghi đè mỗi lượt. App không có màn sửa kho nên không có chỉnh tay nào để bảo vệ.
 *
 * 3. **`code` là UNIQUE nên phải né va chạm.** Chỉ ghi khi Sapo có `code` và code đó chưa
 *    thuộc về kho khác; đụng thì bỏ qua đúng trường đó và báo cáo, thay vì để cả lượt đồng
 *    bộ chết vì một mã trùng.
 */

const PAGE_LIMIT = 250;

type SapoLocation = {
  id: number | string;
  store_id?: number | string | null;
  code?: string | null;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  province?: string | null;
  province_code?: string | null;
  district?: string | null;
  district_code?: string | null;
  ward?: string | null;
  ward_code?: string | null;
  country?: string | null;
  country_code?: string | null;
  zip?: string | null;
  status?: string | null;
  default_location?: boolean | null;
  fulfill_order?: boolean | null;
  fulfillment_pickup?: boolean | null;
  inventory_management?: boolean | null;
  deactivate_inventory_at?: string | null;
  offline_store?: boolean | null;
  owner_type?: string | null;
  inventory_process_status?: string | null;
  created_on?: string | null;
};

export interface SapoLocationSyncResult {
  fetched: number;
  created: number;
  updated: number;
  unchanged: number;
  /** Kho đang có trong DB mà lượt này Sapo không trả về — chỉ báo cáo, không đụng. */
  missing_in_sapo: { sapo_id: string; name: string }[];
  /** Kho mới thấy lần đầu — cần gán quyền/kho mặc định cho nhân viên thì mới dùng được. */
  new_locations: { sapo_id: string; name: string }[];
  /** `code` của Sapo trùng kho khác nên bỏ qua riêng trường đó. */
  code_conflicts: string[];
}

const t = (v: string | null | undefined): string | null =>
  v == null ? null : String(v).trim() || null;

/**
 * Đúng các cột Sapo sở hữu. Khai tay thay vì `Omit<Prisma.LocationUncheckedCreateInput, …>`:
 * kiểu của Prisma còn kèm cả quan hệ (orders, fulfillments…), làm vòng so sánh bên dưới
 * đụng phải khoá không tồn tại trên bản ghi đã select.
 */
type LocationScalars = {
  storeId: bigint | null;
  code?: string | null;
  name: string;
  email: string | null;
  phone: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  province: string | null;
  provinceCode: string | null;
  district: string | null;
  districtCode: string | null;
  ward: string | null;
  wardCode: string | null;
  country: string | null;
  countryCode: string | null;
  zip: string | null;
  status: string;
  defaultLocation: boolean;
  fulfillOrder: boolean;
  fulfillmentPickup: boolean;
  inventoryManagement: boolean;
  deactivateInventoryAt: Date | null;
  offlineStore: boolean;
  ownerType: string | null;
  inventoryProcessStatus: string | null;
  createdOn?: Date;
};

@Injectable()
export class SapoLocationSyncService {
  private readonly logger = new Logger(SapoLocationSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sapo: SapoClient,
  ) {}

  isConfigured(): boolean {
    return this.sapo.isConfigured();
  }

  async syncLocations(): Promise<SapoLocationSyncResult> {
    if (!this.sapo.isConfigured()) {
      throw new BusinessException(
        'CHANNEL_NOT_CONFIGURED',
        'Thiếu SAPO_STORE/SAPO_API_KEY/SAPO_API_SECRET trong cấu hình server',
        500,
      );
    }

    const remote: SapoLocation[] = [];
    for (let page = 1; ; page++) {
      const body = await this.sapo.get<{ locations?: SapoLocation[] }>(
        `/admin/locations.json?limit=${PAGE_LIMIT}&page=${page}`,
      );
      const rows = body.locations ?? [];
      remote.push(...rows);
      if (rows.length < PAGE_LIMIT) break;
    }

    const existing = await this.prisma.location.findMany({
      select: { id: true, sapoId: true, code: true, name: true },
    });
    const bySapoId = new Map(
      existing.filter((l) => l.sapoId).map((l) => [String(l.sapoId), l]),
    );
    const codeOwner = new Map(
      existing.filter((l) => l.code).map((l) => [l.code as string, l.id]),
    );

    const result: SapoLocationSyncResult = {
      fetched: remote.length,
      created: 0,
      updated: 0,
      unchanged: 0,
      missing_in_sapo: [],
      new_locations: [],
      code_conflicts: [],
    };

    for (const loc of remote) {
      const sapoId = BigInt(loc.id);
      const current = bySapoId.get(String(loc.id));
      const data = this.toData(loc, current?.id ?? null, codeOwner, result);

      if (!current) {
        const created = await this.prisma.location.create({
          data: { sapoId, ...data },
          select: { id: true, code: true },
        });
        if (created.code) codeOwner.set(created.code, created.id);
        result.created += 1;
        result.new_locations.push({
          sapo_id: String(loc.id),
          name: data.name,
        });
        continue;
      }

      // So trước khi ghi: `modified_on` là `@updatedAt`, ghi vô nghĩa cũng làm cột đó nhảy
      // và khiến mọi lượt chạy trông như có thay đổi.
      const before = await this.prisma.location.findUniqueOrThrow({
        where: { id: current.id },
      });
      const changed = (Object.keys(data) as (keyof LocationScalars)[]).some(
        (k) => `${before[k] ?? ''}` !== `${data[k] ?? ''}`,
      );
      if (!changed) {
        result.unchanged += 1;
        continue;
      }

      await this.prisma.location.update({
        where: { id: current.id },
        data,
      });
      if (data.code) codeOwner.set(data.code, current.id);
      result.updated += 1;
    }

    const remoteIds = new Set(remote.map((l) => String(l.id)));
    result.missing_in_sapo = existing
      .filter((l) => l.sapoId && !remoteIds.has(String(l.sapoId)))
      .map((l) => ({ sapo_id: String(l.sapoId), name: l.name }));

    if (result.new_locations.length) {
      this.logger.warn(
        `Đồng bộ kho Sapo: ${result.new_locations.length} kho MỚI — ` +
          result.new_locations
            .map((l) => `${l.name} (${l.sapo_id})`)
            .join(', ') +
          '. Cần gán quyền kho cho nhân viên thì họ mới thấy dữ liệu của kho này.',
      );
    }
    if (result.missing_in_sapo.length) {
      this.logger.warn(
        `Đồng bộ kho Sapo: ${result.missing_in_sapo.length} kho có trong DB nhưng Sapo không trả về (giữ nguyên) — ` +
          result.missing_in_sapo
            .map((l) => `${l.name} (${l.sapo_id})`)
            .join(', '),
      );
    }
    return result;
  }

  private toData(
    loc: SapoLocation,
    currentId: bigint | null,
    codeOwner: Map<string, bigint>,
    result: SapoLocationSyncResult,
  ): LocationScalars {
    const code = t(loc.code);
    // `code` UNIQUE: chỉ nhận khi chưa ai giữ, hoặc chính kho này đang giữ.
    const owner = code ? codeOwner.get(code) : undefined;
    const codeUsable = !code || owner === undefined || owner === currentId;
    if (code && !codeUsable) result.code_conflicts.push(code);

    return {
      storeId: loc.store_id != null ? BigInt(loc.store_id) : null,
      ...(codeUsable ? { code } : {}),
      // Kho không tên bên Sapo thì lấy id làm nhãn — cột `name` NOT NULL, và để chuỗi rỗng
      // thì trên UI thành dòng trống không ai biết là kho nào.
      name: t(loc.name) ?? `Kho Sapo ${loc.id}`,
      email: t(loc.email),
      phone: t(loc.phone),
      address1: t(loc.address1),
      address2: t(loc.address2),
      city: t(loc.city),
      province: t(loc.province),
      provinceCode: t(loc.province_code),
      district: t(loc.district),
      districtCode: t(loc.district_code),
      ward: t(loc.ward),
      wardCode: t(loc.ward_code),
      country: t(loc.country),
      countryCode: t(loc.country_code),
      zip: t(loc.zip),
      status: t(loc.status) ?? 'active',
      defaultLocation: loc.default_location ?? false,
      fulfillOrder: loc.fulfill_order ?? false,
      fulfillmentPickup: loc.fulfillment_pickup ?? false,
      inventoryManagement: loc.inventory_management ?? true,
      deactivateInventoryAt: loc.deactivate_inventory_at
        ? new Date(loc.deactivate_inventory_at)
        : null,
      offlineStore: loc.offline_store ?? false,
      ownerType: t(loc.owner_type),
      inventoryProcessStatus: t(loc.inventory_process_status),
      ...(loc.created_on ? { createdOn: new Date(loc.created_on) } : {}),
    };
  }
}
