/**
 * Ảnh hiển thị cho một phiên bản: ảnh riêng của phiên bản, không có thì ảnh đại diện của
 * sản phẩm. Chỉ ~8% phiên bản có ảnh riêng, nên thiếu bước lùi này là hầu hết dòng trống ảnh.
 */
export function variantImageUrl(
  variant?: {
    imageUrl?: string | null;
    product?: { imageUrl?: string | null } | null;
  } | null,
): string | null {
  return variant?.imageUrl ?? variant?.product?.imageUrl ?? null;
}

/** `select` Prisma tương ứng — dùng chung để ba module không lệch trường. */
export const variantImageSelect = {
  imageUrl: true,
  product: { select: { name: true, imageUrl: true } },
} as const;
