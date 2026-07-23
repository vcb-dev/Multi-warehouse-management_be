import { Prisma } from '@prisma/client';
import { serializeFulfillment } from '../fulfillments/fulfillment.serializer';
import { OrderWithRelations } from './order.repository';

function dec(v: Prisma.Decimal): number {
  return Number(v);
}

export function serializeOrderListItem(o: {
  id: bigint;
  code: string;
  status: string;
  source: string;
  paymentStatus: string;
  shippingMethod: string | null;
  totalAmount: Prisma.Decimal;
  totalQuantity: number;
  orderedAt: Date;
  shippedAt: Date | null;
  phone: string | null;
  tags: string[];
  customer: { firstName: string | null; lastName: string | null } | null;
  branch: { name: string };
  createdBy: { name: string | null; email: string };
  items: { sku: string }[];
  fulfillments?: {
    packingStatus: string | null;
    shipmentStatus: string | null;
    provider: { name: string } | null;
  }[];
}) {
  const customerName = o.customer
    ? [o.customer.firstName, o.customer.lastName].filter(Boolean).join(' ')
    : null;
  const openFulfillment = o.fulfillments?.[0] ?? null;
  return {
    id: o.id.toString(),
    code: o.code,
    status: o.status,
    source: o.source,
    payment_status: o.paymentStatus,
    shipping_method: o.shippingMethod,
    packing_status: openFulfillment?.packingStatus ?? null,
    shipment_status: openFulfillment?.shipmentStatus ?? null,
    provider_name: openFulfillment?.provider?.name ?? null,
    branch_name: o.branch.name,
    created_by_name: o.createdBy.name ?? o.createdBy.email,
    total_amount: dec(o.totalAmount),
    total_quantity: o.totalQuantity,
    ordered_at: o.orderedAt.toISOString(),
    shipped_at: o.shippedAt?.toISOString() ?? null,
    phone: o.phone,
    customer_name: customerName,
    tags: o.tags,
    sku_summary: o.items.map((i) => i.sku).join(', '),
  };
}

export function serializeOrderDetail(o: OrderWithRelations) {
  return {
    id: o.id.toString(),
    code: o.code,
    status: o.status,
    source: o.source,
    branch_id: o.branchId.toString(),
    branch: o.branch,
    branch_name: o.branch.name,
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
          name: o.assignedTo.name,
          email: o.assignedTo.email,
        }
      : null,
    created_by: o.createdById.toString(),
    created_by_name: o.createdBy.name ?? o.createdBy.email,
    email: o.email,
    phone: o.phone,
    subtotal: dec(o.subtotal),
    discount_total: dec(o.discountTotal),
    tax_total: dec(o.taxTotal),
    shipping_fee: dec(o.shippingFee),
    shipping_method: o.shippingMethod,
    total_amount: dec(o.totalAmount),
    total_quantity: o.totalQuantity,
    payment_status: o.paymentStatus,
    paid_amount: dec(o.paidAmount),
    note: o.note,
    tags: o.tags,
    ordered_at: o.orderedAt.toISOString(),
    expected_delivery_at: o.expectedDeliveryAt?.toISOString() ?? null,
    shipped_at: o.shippedAt?.toISOString() ?? null,
    items: o.items.map((i) => ({
      id: i.id.toString(),
      variant_id: i.variantId.toString(),
      warehouse_id: i.warehouseId.toString(),
      product_id: i.variant?.productId.toString() ?? null,
      product_name: i.productName,
      sku: i.sku,
      image_url: i.variant?.imageUrl ?? null,
      unit: i.variant?.unit ?? null,
      quantity: i.quantity,
      price: dec(i.price),
      discount: dec(i.discount),
      total: dec(i.total),
    })),
    fulfillments: o.fulfillments.map(serializeFulfillment),
    created_at: o.createdAt.toISOString(),
    updated_at: o.updatedAt.toISOString(),
  };
}
