import {
  InventoryLevel,
  InventoryMovement,
  Location,
  Product,
  ProductVariant,
} from '@prisma/client';

type OptionValueRef = { value: string; option?: { position?: number } | null };

type LevelWithRelations = InventoryLevel & {
  variant: ProductVariant & {
    product: Product;
    optionValues?: OptionValueRef[];
  };
  location: Location;
};

/** Giá trị thuộc tính theo thứ tự option trên sản phẩm. */
export function optionValueLabels(
  optionValues?: readonly OptionValueRef[] | null,
): string[] {
  if (!optionValues?.length) return [];
  return [...optionValues]
    .sort((a, b) => (a.option?.position ?? 0) - (b.option?.position ?? 0))
    .map((ov) => ov.value);
}

/**
 * Tên phân loại của phiên bản ("Size 35 / Màu Đen") — thứ duy nhất phân biệt
 * được các phiên bản cùng một sản phẩm khi chọn hàng.
 *
 * Sapo đặt `Default Title` cho sản phẩm không có thuộc tính nào (11.474 phiên
 * bản đang có), đưa xuống giao diện thì mọi dòng đều đeo một nhãn vô nghĩa —
 * trả null để bên hiển thị khỏi phải biết quy ước này.
 *
 * SP tạo trong OMS thường để `title` trống, chỉ có `option_values` — ghép
 * chúng khi title không dùng được.
 */
export function variantTitle(
  title: string | null | undefined,
  optionValues?: readonly string[] | null,
): string | null {
  const value = title?.trim();
  if (value && value.toLowerCase() !== 'default title') return value;
  const fromOpts = (optionValues ?? [])
    .map((v) => v.trim())
    .filter(Boolean)
    .join(' / ');
  return fromOpts || null;
}

export function serializeLevel(level: LevelWithRelations) {
  return {
    variant_id: level.variantId.toString(),
    location_id: level.locationId.toString(),
    product_id: level.variant.productId.toString(),
    sku: level.variant.sku,
    product_name: level.variant.product.name,
    variant_title: variantTitle(
      level.variant.title,
      optionValueLabels(level.variant.optionValues),
    ),
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
    price: level.variant.price.toString(),
    // cost: level.variant.cost.toString(),  // nếu muốn giá vốn cũng khớp
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
