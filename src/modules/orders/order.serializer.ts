import { Prisma } from '@prisma/client';
import { serializeFulfillment } from '../fulfillments/fulfillment.serializer';
import { userDisplayName } from '../../common/utils/user-display-name';
import { OrderWithRelations } from './order.repository';

function dec(v: Prisma.Decimal): number {
  return Number(v);
}

export function serializeOrderListItem(
  o: {
    id: bigint;
    name: string;
    status: string;
    confirmedOn: Date | null;
    sourceName: string | null;
    financialStatus: string;
    fulfillmentStatus: string | null;
    returnStatus: string;
    refundStatus: string;
    deliveryMode: string;
    shippingMethod: string | null;
    totalPrice: Prisma.Decimal;
    subtotalLineItemsQuantity: number;
    createdOn: Date;
    deliveredOn: Date | null;
    phone: string | null;
    tags: string[];
    shippingName: string | null;
    shippingFirstName: string | null;
    shippingLastName: string | null;
    shippingPhone: string | null;
    shippingAddress1: string | null;
    shippingWard: string | null;
    shippingDistrict: string | null;
    shippingProvince: string | null;
    customer: {
      firstName: string | null;
      lastName: string | null;
      phone: string | null;
    } | null;
    location: { name: string };
    createdBy: { firstName: string | null; lastName: string | null; email: string };
    items: { sku: string }[];
    fulfillments?: {
      packedStatus: string | null;
      shipmentStatus: string | null;
      provider: { name: string } | null;
    }[];
  },
  stockReady = true,
) {
  const customerName = o.customer
    ? [o.customer.firstName, o.customer.lastName].filter(Boolean).join(' ')
    : null;
  const openFulfillment = o.fulfillments?.[0] ?? null;
  const recipientName =
    o.shippingName?.trim() ||
    [o.shippingFirstName, o.shippingLastName].filter(Boolean).join(' ').trim() ||
    customerName ||
    '';
  const recipientPhone =
    o.shippingPhone?.trim() || o.phone?.trim() || o.customer?.phone?.trim() || '';
  const carrierShipReady =
    !!recipientName &&
    !!recipientPhone &&
    !!o.shippingAddress1?.trim() &&
    !!o.shippingWard?.trim() &&
    !!o.shippingDistrict?.trim() &&
    !!o.shippingProvince?.trim();
  return {
    id: o.id.toString(),
    name: o.name,
    status: o.status,
    confirmed_on: o.confirmedOn?.toISOString() ?? null,
    source_name: o.sourceName,
    financial_status: o.financialStatus,
    fulfillment_status: o.fulfillmentStatus,
    return_status: o.returnStatus,
    refund_status: o.refundStatus,
    delivery_mode: o.deliveryMode,
    shipping_method: o.shippingMethod,
    packed_status: openFulfillment?.packedStatus ?? null,
    shipment_status: openFulfillment?.shipmentStatus ?? null,
    provider_name: openFulfillment?.provider?.name ?? null,
    location_name: o.location.name,
    created_by_name: userDisplayName(o.createdBy) ?? o.createdBy.email,
    total_price: dec(o.totalPrice),
    subtotal_line_items_quantity: o.subtotalLineItemsQuantity,
    created_on: o.createdOn.toISOString(),
    delivered_on: o.deliveredOn?.toISOString() ?? null,
    phone: o.phone,
    customer_name: customerName,
    tags: o.tags,
    sku_summary: o.items
      .slice(0, 8)
      .map((i) => i.sku)
      .join(', '),
    stock_ready: stockReady,
    carrier_ship_ready: carrierShipReady,
  };
}

export function serializeOrderDetail(o: OrderWithRelations) {
  return {
    id: o.id.toString(),
    name: o.name,
    status: o.status,
    source_name: o.sourceName,
    financial_status: o.financialStatus,
    fulfillment_status: o.fulfillmentStatus,
    return_status: o.returnStatus,
    refund_status: o.refundStatus,
    issue_status: o.issueStatus,
    restock_status: o.restockStatus,
    cancel_reason: o.cancelReason,
    cancelled_on: o.cancelledOn?.toISOString() ?? null,
    closed_on: o.closedOn?.toISOString() ?? null,
    confirmed_on: o.confirmedOn?.toISOString() ?? null,
    completed_on: o.completedOn?.toISOString() ?? null,
    paid_on: o.paidOn?.toISOString() ?? null,
    location_id: o.locationId.toString(),
    location: o.location,
    location_name: o.location.name,
    customer_id: o.customerId?.toString() ?? null,
    customer: o.customer
      ? {
          id: o.customer.id.toString(),
          first_name: o.customer.firstName,
          last_name: o.customer.lastName,
          phone: o.customer.phone,
          email: o.customer.email,
        }
      : null,
    assigned_to: o.assignedToId?.toString() ?? null,
    assigned_user: o.assignedTo
      ? {
          id: o.assignedTo.id.toString(),
          name: userDisplayName(o.assignedTo),
          email: o.assignedTo.email,
        }
      : null,
    created_by: o.createdById.toString(),
    created_by_name: userDisplayName(o.createdBy) ?? o.createdBy.email,
    email: o.email,
    phone: o.phone,
    sub_total_price: dec(o.subTotalPrice),
    total_discounts: dec(o.totalDiscounts),
    total_tax: dec(o.totalTax),
    total_shipping_price: dec(o.totalShippingPrice),
    shipping_method: o.shippingMethod,
    total_price: dec(o.totalPrice),
    subtotal_line_items_quantity: o.subtotalLineItemsQuantity,
    total_received: dec(o.totalReceived),
    currency: o.currency,
    gateway: o.gateway,
    total_weight: o.totalWeight,
    net_payment: o.netPayment != null ? dec(o.netPayment) : null,
    unpaid_amount: o.unpaidAmount != null ? dec(o.unpaidAmount) : null,
    total_outstanding: o.totalOutstanding != null ? dec(o.totalOutstanding) : null,
    total_refunded: o.totalRefunded != null ? dec(o.totalRefunded) : null,
    number: o.number,
    order_number: o.orderNumber,
    note: o.note,
    tags: o.tags,
    created_on: o.createdOn.toISOString(),
    expected_delivery_date: o.expectedDeliveryDate?.toISOString() ?? null,
    delivered_on: o.deliveredOn?.toISOString() ?? null,
    processed_on: o.processedOn?.toISOString() ?? null,
    settled_on: o.settledOn?.toISOString() ?? null,
    issued_on: o.issuedOn?.toISOString() ?? null,
    delivery_mode: o.deliveryMode,
    shipping_address: {
      name: o.shippingName,
      first_name: o.shippingFirstName,
      last_name: o.shippingLastName,
      phone: o.shippingPhone,
      address1: o.shippingAddress1,
      address2: o.shippingAddress2,
      ward: o.shippingWard,
      ward_code: o.shippingWardCode,
      district: o.shippingDistrict,
      district_code: o.shippingDistrictCode,
      province: o.shippingProvince,
      province_code: o.shippingProvinceCode,
      city: o.shippingCity,
      country: o.shippingCountry,
      country_code: o.shippingCountryCode,
      zip: o.shippingZip,
      company: o.shippingCompany,
      latitude: o.shippingLatitude != null ? dec(o.shippingLatitude) : null,
      longitude: o.shippingLongitude != null ? dec(o.shippingLongitude) : null,
    },
    billing_address: {
      name: o.billingName,
      phone: o.billingPhone,
      address1: o.billingAddress1,
      ward: o.billingWard,
      district: o.billingDistrict,
      province: o.billingProvince,
      country: o.billingCountry,
      zip: o.billingZip,
    },
    delivery_cod_amount: o.deliveryCodAmount != null ? dec(o.deliveryCodAmount) : null,
    delivery_weight_grams: o.deliveryWeightGrams,
    delivery_length_cm: o.deliveryLengthCm,
    delivery_width_cm: o.deliveryWidthCm,
    delivery_height_cm: o.deliveryHeightCm,
    delivery_requirement: o.deliveryRequirement,
    delivery_note: o.deliveryNote,
    invoice_tax_code: o.invoiceTaxCode,
    invoice_company_name: o.invoiceCompanyName,
    invoice_address: o.invoiceAddress,
    invoice_buyer_name: o.invoiceBuyerName,
    invoice_id_card: o.invoiceIdCard,
    invoice_budget_code: o.invoiceBudgetCode,
    invoice_phone: o.invoicePhone,
    invoice_email: o.invoiceEmail,
    invoice_sell_to_consumer: o.invoiceSellToConsumer,
    items: o.items.map((i) => ({
      id: i.id.toString(),
      variant_id: i.variantId.toString(),
      product_id: i.productId?.toString() ?? i.variant?.productId.toString() ?? null,
      inventory_item_id: i.inventoryItemId?.toString() ?? null,
      name: i.name,
      variant_title: i.variantTitle,
      sku: i.sku,
      image_url: i.variant?.imageUrl ?? null,
      unit: i.variant?.unit ?? null,
      quantity: i.quantity,
      price: dec(i.price),
      total_discount: dec(i.totalDiscount),
      discounted_total: dec(i.discountedTotal),
      original_total: i.originalTotal != null ? dec(i.originalTotal) : null,
      fulfillable_quantity: i.fulfillableQuantity,
      current_quantity: i.currentQuantity,
      non_fulfillable_quantity: i.nonFulfillableQuantity,
      refundable_quantity: i.refundableQuantity,
      grams: i.grams,
      taxable: i.taxable,
      requires_shipping: i.requiresShipping,
      restockable: i.restockable,
    })),
    fulfillments: o.fulfillments.map(serializeFulfillment),
    modified_on: o.modifiedOn.toISOString(),
  };
}
