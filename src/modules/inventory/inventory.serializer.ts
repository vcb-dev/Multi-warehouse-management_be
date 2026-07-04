import { InventoryLevel, InventoryMovement, Product, ProductVariant, Warehouse } from '@prisma/client';

type LevelWithRelations = InventoryLevel & {
  variant: ProductVariant & { product: Product };
  warehouse: Warehouse;
};

export function serializeLevel(level: LevelWithRelations) {
  return {
    variant_id: level.variantId.toString(),
    warehouse_id: level.warehouseId.toString(),
    sku: level.variant.sku,
    product_name: level.variant.product.name,
    warehouse_code: level.warehouse.code,
    warehouse_name: level.warehouse.name,
    on_hand: level.onHand,
    committed: level.committed,
    packing: level.packing,
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
    warehouse_id: m.warehouseId.toString(),
    bucket: m.bucket,
    change: m.change,
    type: m.type,
    reference_type: m.referenceType,
    reference_id: m.referenceId?.toString() ?? null,
    created_at: m.createdAt.toISOString(),
  };
}
