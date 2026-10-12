import {
  PackageCategory,
  PackingStatus,
  Prisma,
  ShipmentStatus,
} from '@prisma/client';
import {
  appendAnd,
  firstDefined,
  parseBool,
  parseEnumList,
  parseIdList,
  parseList,
} from '../../common/query/filter-params';
import { userDisplayName } from '../../common/utils/user-display-name';
import { carrierDisplayName } from './carrier-display';
import type { ListPackagesQueryDto } from './fulfillment.dto';

/** Tab nhanh của màn "In & đóng gói" (khớp thứ tự tab trên Sapo). */
export const PACKING_TABS = [
  'not_shipped',
  'not_printed',
  'printed',
  'not_packed',
  'packed',
] as const;

export type PackingTab = (typeof PACKING_TABS)[number];

/**
 * Điều kiện lọc màn "In & đóng gói".
 *
 * Hàng đợi chỉ gồm kiện hàng CÒN TRONG KHO: phiếu đang mở, chưa huỷ, và hãng
 * chưa lấy hàng (chưa đẩy vận chuyển hoặc đang "Chờ lấy hàng"). Kiện đã rời kho
 * thuộc màn Vận đơn.
 *
 * Kho lọc theo ĐƠN HÀNG chứ không theo `fulfillments.location_id`: phiếu mới
 * tạo yêu cầu đóng gói chưa có `location_id` (chỉ được ghi lúc đẩy vận chuyển),
 * lọc trên phiếu sẽ làm rơi đúng những kiện cần đóng gói nhất.
 */
export function buildPackingListWhere(
  query: ListPackagesQueryDto,
  locationIds: bigint[] | undefined,
): Prisma.FulfillmentWhereInput {
  const where: Prisma.FulfillmentWhereInput = {
    status: { not: 'cancelled' },
    closedAt: null,
    cancelledOn: null,
  };
  appendAnd(where, {
    OR: [{ shipmentStatus: null }, { shipmentStatus: ShipmentStatus.pending }],
  });

  if (locationIds)
    appendAnd(where, { order: { locationId: { in: locationIds } } });

  const tab = query.tab?.trim() as PackingTab | undefined;
  if (tab === 'not_shipped') {
    appendAnd(where, { shipmentStatus: null });
  } else if (tab === 'not_printed') {
    appendAnd(where, { deliveryNotePrintedAt: null });
  } else if (tab === 'printed') {
    appendAnd(where, { deliveryNotePrintedAt: { not: null } });
  } else if (tab === 'not_packed') {
    // Liệt kê tường minh thay vì `NOT packed`: so sánh `<>` trong SQL loại luôn
    // dòng NULL, mà phiếu đẩy vận chuyển thẳng (không qua yêu cầu đóng gói) có
    // `packed_status` NULL và vẫn là kiện chưa đóng gói.
    appendAnd(where, {
      OR: [
        { packedStatus: null },
        {
          packedStatus: { in: [PackingStatus.unknown, PackingStatus.packing] },
        },
      ],
    });
  } else if (tab === 'packed') {
    appendAnd(where, { packedStatus: PackingStatus.packed });
  }

  const printed = parseBool(query.printed);
  if (printed !== undefined) {
    appendAnd(where, {
      deliveryNotePrintedAt: printed ? { not: null } : null,
    });
  }

  const packing = parseEnumList(
    query.packing_status,
    Object.values(PackingStatus),
  );
  if (packing) appendAnd(where, { packedStatus: { in: packing } });

  const categories = parseEnumList(
    query.package_category,
    Object.values(PackageCategory),
  );
  if (categories) appendAnd(where, { packageCategory: { in: categories } });

  const providerIds = parseIdList(query.provider_ids);
  if (providerIds) appendAnd(where, { providerId: { in: providerIds } });

  const sources = parseList(query.sources);
  if (sources) appendAnd(where, { order: { sourceName: { in: sources } } });

  const q = query.q?.trim();
  if (q) {
    appendAnd(where, {
      OR: [
        { name: { contains: q, mode: 'insensitive' } },
        { trackingNumber: { contains: q, mode: 'insensitive' } },
        { order: { name: { contains: q, mode: 'insensitive' } } },
      ],
    });
  }

  return where;
}

/** `location_ids` (hoặc tên cũ `location_id`) của request. */
export function requestedLocationIds(query: ListPackagesQueryDto) {
  return parseIdList(firstDefined(query.location_ids, query.location_id));
}

export const packingListInclude = {
  provider: { select: { id: true, code: true, name: true } },
  packer: { select: { firstName: true, lastName: true, email: true } },
  order: {
    select: {
      id: true,
      name: true,
      sourceName: true,
      location: { select: { id: true, name: true } },
    },
  },
} satisfies Prisma.FulfillmentInclude;

export type PackingListRow = Prisma.FulfillmentGetPayload<{
  include: typeof packingListInclude;
}>;

/** Một dòng bảng "In & đóng gói". */
export function serializePackingListItem(f: PackingListRow) {
  return {
    id: f.id.toString(),
    name: f.name, // mã kiện hàng
    order_id: f.orderId.toString(),
    order_name: f.order.name,
    source_name: f.order.sourceName,
    tracking_number: f.trackingNumber,
    packed_status: f.packedStatus,
    packed_on: f.packedOn?.toISOString() ?? null,
    packer_name: f.packer
      ? (userDisplayName(f.packer) ?? f.packer.email)
      : null,
    shipment_status: f.shipmentStatus,
    provider_name: carrierDisplayName(f),
    delivery_method: f.deliveryMethod,
    package_category: f.packageCategory,
    total_quantity: f.totalQuantity,
    delivery_note_printed_at: f.deliveryNotePrintedAt?.toISOString() ?? null,
    location_name: f.order.location.name,
    created_on: f.createdOn.toISOString(),
  };
}
