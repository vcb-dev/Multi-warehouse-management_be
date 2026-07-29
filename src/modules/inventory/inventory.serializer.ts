import {
  InventoryLevel,
  InventoryMovement,
  Product,
  ProductVariant,
  Location,
} from '@prisma/client';

type LevelWithRelations = InventoryLevel & {
  variant: ProductVariant & { product: Product };
  location: Location;
};

export function serializeLevel(level: LevelWithRelations) {
  return {
    variant_id: level.variantId.toString(),
    location_id: level.locationId.toString(),
    product_id: level.variant.productId.toString(),
    sku: level.variant.sku,
    product_name: level.variant.product.name,
    image_url: level.variant.imageUrl ?? level.variant.product.imageUrl ?? null,
    unit: level.variant.unit ?? null,
    location_code: level.location.code,
    location_name: level.location.name,
    on_hand: level.onHand,
    committed: level.committed,
    packed: level.packed,
    unavailable: level.unavailable,
    incoming: level.incoming,
    available: level.available,
    price: level.price.toString(),
    cost: level.cost.toString(),
    updated_at: level.updatedAt.toISOString(),
  };
}

export function serializeMovement(m: InventoryMovement) {
  return {
    id: m.id.toString(),
    variant_id: m.variantId.toString(),
    location_id: m.locationId.toString(),
    bucket: m.bucket,
    change: m.change,
    type: m.type,
    reference_type: m.referenceType,
    reference_id: m.referenceId?.toString() ?? null,
    created_at: m.createdAt.toISOString(),
  };
}
