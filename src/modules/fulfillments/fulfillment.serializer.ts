import { Prisma } from '@prisma/client';

const fulfillmentInclude = {
  packer: { select: { id: true, name: true, email: true } },
  provider: { select: { id: true, code: true, name: true, type: true } },
  fromBranch: { select: { id: true, code: true, name: true } },
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
    code: f.code,
    order_id: f.orderId.toString(),
    packing_status: f.packingStatus,
    packer_id: f.packerId?.toString() ?? null,
    packer_name: f.packer ? (f.packer.name ?? f.packer.email) : null,
    packed_at: f.packedAt?.toISOString() ?? null,
    delivery_note_printed_at: f.deliveryNotePrintedAt?.toISOString() ?? null,
    shipment_status: f.shipmentStatus,
    shipping_type: f.shippingType,
    provider_id: f.providerId?.toString() ?? null,
    provider_name: f.provider?.name ?? null,
    provider_code: f.provider?.code ?? null,
    service_code: f.serviceCode,
    service_name: f.serviceName,
    tracking_code: f.trackingCode,
    shipping_fee: dec(f.shippingFee),
    fee_payer: f.feePayer,
    cod_amount: dec(f.codAmount),
    weight_grams: f.weightGrams,
    length_cm: f.lengthCm,
    width_cm: f.widthCm,
    height_cm: f.heightCm,
    delivery_requirement: f.deliveryRequirement,
    note: f.note,
    to_name: f.toName,
    to_phone: f.toPhone,
    to_address: f.toAddress,
    to_ward: f.toWard,
    to_district: f.toDistrict,
    to_province: f.toProvince,
    from_branch_id: f.fromBranchId?.toString() ?? null,
    from_branch_name: f.fromBranch?.name ?? null,
    from_name: f.fromName,
    from_phone: f.fromPhone,
    from_address: f.fromAddress,
    pushed_at: f.pushedAt?.toISOString() ?? null,
    picked_up_at: f.pickedUpAt?.toISOString() ?? null,
    delivered_at: f.deliveredAt?.toISOString() ?? null,
    returned_at: f.returnedAt?.toISOString() ?? null,
    cancelled_at: f.cancelledAt?.toISOString() ?? null,
    closed_at: f.closedAt?.toISOString() ?? null,
    cancel_reason: f.cancelReason,
    created_at: f.createdAt.toISOString(),
    updated_at: f.updatedAt.toISOString(),
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
