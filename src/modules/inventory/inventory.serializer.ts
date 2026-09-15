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

/**
 * Tên phân loại của phiên bản ("Size 35 / Màu Đen") — thứ duy nhất phân biệt
 * được các phiên bản cùng một sản phẩm khi chọn hàng.
 *
 * Sapo đặt `Default Title` cho sản phẩm không có thuộc tính nào (11.474 phiên
 * bản đang có), đưa xuống giao diện thì mọi dòng đều đeo một nhãn vô nghĩa —
 * trả null để bên hiển thị khỏi phải biết quy ước này.
 */
export function variantTitle(title: string | null): string | null {
  const value = title?.trim();
  if (!value || value.toLowerCase() === 'default title') return null;
  return value;
}

export function serializeLevel(level: LevelWithRelations) {
  return {
    variant_id: level.variantId.toString(),
    location_id: level.locationId.toString(),
    product_id: level.variant.productId.toString(),
    sku: level.variant.sku,
    product_name: level.variant.product.name,
    variant_title: variantTitle(level.variant.title),
    // Ảnh riêng của phiên bản mới nói lên phân loại; chỉ 16% phiên bản của
    // sản phẩm nhiều phân loại có ảnh riêng nên vẫn phải lùi về ảnh sản phẩm.
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
