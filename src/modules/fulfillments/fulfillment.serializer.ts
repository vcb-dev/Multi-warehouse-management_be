import { Prisma } from '@prisma/client';
import { userDisplayName } from '../../common/utils/user-display-name';

const fulfillmentInclude = {
  packer: { select: { id: true, firstName: true, lastName: true, email: true } },
  provider: { select: { id: true, code: true, name: true, type: true } },
  location: { select: { id: true, code: true, name: true } },
} satisfies Prisma.FulfillmentInclude;

export type FulfillmentWithRelations = Prisma.FulfillmentGetPayload<{
  include: typeof fulfillmentInclude;
}>;

function dec(v: Prisma.Decimal): number {
  return Number(v);
}

export function serializeFulfillment(f: FulfillmentWithRelations) {
  return {
    id: f.id.toString(),
    sapo_id: f.sapoId?.toString() ?? null,
    name: f.name,
    order_id: f.orderId.toString(),
    store_id: f.storeId?.toString() ?? null,
    status: f.status,
    // Đóng gói
    packed_status: f.packedStatus,
    assigned_packer_id: f.assignedPackerId?.toString() ?? null,
    packer_name: f.packer ? (userDisplayName(f.packer) ?? f.packer.email) : null,
    packed_on: f.packedOn?.toISOString() ?? null,
    delivery_note_printed_at: f.deliveryNotePrintedAt?.toISOString() ?? null,
    // Vận đơn
    shipment_status: f.shipmentStatus,
    delivery_method: f.deliveryMethod,
    shipment_category: f.shipmentCategory,
    package_category: f.packageCategory,
    shipping_type: f.shippingType,
    provider_id: f.providerId?.toString() ?? null,
    provider_name: f.provider?.name ?? null,
    provider_code: f.provider?.code ?? null,
    service_code: f.serviceCode,
    service_name: f.serviceName,
    tracking_info: {
      tracking_company: f.trackingCompany,
      carrier: f.carrier,
      carrier_name: f.carrierName,
      tracking_number: f.trackingNumber,
      tracking_url: f.trackingUrl,
      tracking_numbers: f.trackingNumbers,
      tracking_urls: f.trackingUrls,
    },
    tracking_number: f.trackingNumber,
    tracking_url: f.trackingUrl,
    shipping_label_slip_url: f.shippingLabelSlipUrl,
    shipping_label_slip_error: f.shippingLabelSlipError,
    notify_customer: f.notifyCustomer,
    total_quantity: f.totalQuantity,
    sla: f.sla,
    abnormal: f.abnormal,
    picking_issues: f.pickingIssues,
    // Phí/kích thước (của dự án)
    shipping_fee: dec(f.shippingFee),
    fee_payer: f.feePayer,
    cod_amount: dec(f.codAmount),
    weight_grams: f.weightGrams,
    length_cm: f.lengthCm,
    width_cm: f.widthCm,
    height_cm: f.heightCm,
    delivery_requirement: f.deliveryRequirement,
    note: f.note,
    // Địa chỉ nhận
    to_name: f.toName,
    to_phone: f.toPhone,
    to_address: f.toAddress,
    to_ward: f.toWard,
    to_district: f.toDistrict,
    to_province: f.toProvince,
    // Địa chỉ lấy hàng (Sapo `origin_address`)
    location_id: f.locationId?.toString() ?? null,
    origin_address: {
      name: f.originName,
      email: f.originEmail,
      phone: f.originPhone,
      address1: f.originAddress1,
      address2: f.originAddress2,
      ward: f.originWard,
      ward_code: f.originWardCode,
      district: f.originDistrict,
      district_code: f.originDistrictCode,
      province: f.originProvince,
      province_code: f.originProvinceCode,
      city: f.originCity,
      country: f.originCountry,
      country_code: f.originCountryCode,
      zip_code: f.originZipCode,
    },
    // Mốc thời gian
    shipment_created_on: f.shipmentCreatedOn?.toISOString() ?? null,
    picked_on: f.pickedOn?.toISOString() ?? null,
    sorted_on: f.sortedOn?.toISOString() ?? null,
    inspected_on: f.inspectedOn?.toISOString() ?? null,
    issued_on: f.issuedOn?.toISOString() ?? null,
    issued_by: f.issuedBy,
    handed_over_at: f.handedOverAt?.toISOString() ?? null,
    handed_by: f.handedBy,
    picked_up_at: f.pickedUpAt?.toISOString() ?? null,
    delivered_on: f.deliveredOn?.toISOString() ?? null,
    expected_delivery_date: f.expectedDeliveryDate?.toISOString() ?? null,
    order_ship_deadline: f.orderShipDeadline?.toISOString() ?? null,
    returned_at: f.returnedAt?.toISOString() ?? null,
    cancelled_on: f.cancelledOn?.toISOString() ?? null,
    closed_at: f.closedAt?.toISOString() ?? null,
    cancel_reason: f.cancelReason,
    created_on: f.createdOn.toISOString(),
    modified_on: f.modifiedOn.toISOString(),
  };
}

export function serializeShippingProvider(p: {
  id: bigint;
  code: string;
  name: string;
  type: string;
  isConnected: boolean;
  servicesConfig: Prisma.JsonValue;
  phone: string | null;
  email: string | null;
  note: string | null;
  isActive: boolean;
}) {
  return {
    id: p.id.toString(),
    code: p.code,
    name: p.name,
    type: p.type,
    is_connected: p.isConnected,
    services_config: p.servicesConfig ?? null,
    phone: p.phone,
    email: p.email,
    note: p.note,
    is_active: p.isActive,
  };
}

export { fulfillmentInclude };
