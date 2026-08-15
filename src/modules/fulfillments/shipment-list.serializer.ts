import { Prisma } from '@prisma/client';
import { carrierDisplayName } from './carrier-display';

export const shipmentListInclude = {
  provider: { select: { id: true, code: true, name: true } },
  location: { select: { id: true, code: true, name: true } },
  order: { select: { id: true, name: true, tags: true } },
} satisfies Prisma.FulfillmentInclude;

export type ShipmentListRow = Prisma.FulfillmentGetPayload<{
  include: typeof shipmentListInclude;
}>;

function dec(v: Prisma.Decimal): number {
  return Number(v);
}

/** Một dòng bảng “Danh sách vận đơn” — khớp VanDonRow trên FE */
export function serializeShipmentListItem(f: ShipmentListRow) {
  return {
    id: f.id.toString(),
    shipment_created_on: f.shipmentCreatedOn?.toISOString() ?? null,
    name: f.name, // mã giao hàng nội bộ (FUN…)
    tracking_number: f.trackingNumber,
    order_id: f.orderId.toString(),
    order_name: f.order.name,
    shipment_status: f.shipmentStatus,
    to_name: f.toName,
    to_phone: f.toPhone,
    to_ward: f.toWard,
    to_district: f.toDistrict,
    to_province: f.toProvince,
    provider_name: carrierDisplayName(f),
    cod_amount: dec(f.codAmount),
    shipping_fee: dec(f.shippingFee),
    location_name: f.location?.name ?? null,
    package_category: f.packageCategory,
    delivery_method: f.deliveryMethod,
    fee_payer: f.feePayer,
    delivered_on: f.deliveredOn?.toISOString() ?? null,
    total_quantity: f.totalQuantity,
    delivery_note_printed_at: f.deliveryNotePrintedAt?.toISOString() ?? null,
    order_tags: f.order.tags ?? [],
    cancelled_on: f.cancelledOn?.toISOString() ?? null,
    expected_delivery_date: f.expectedDeliveryDate?.toISOString() ?? null,
    reconciliation_status: null, // chưa có field DB — để null như UI hiện tại
  };
}
