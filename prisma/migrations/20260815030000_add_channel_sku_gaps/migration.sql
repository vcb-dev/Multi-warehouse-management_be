-- SKU xuất hiện trên đơn của kênh bán nhưng KHÔNG khớp `product_variants.sku`.
--
-- Vì sao cần bảng riêng: khi đồng bộ đơn TikTok, dòng hàng có SKU lạ bị bỏ (không thể
-- chèn `order_items` vì `variant_id` là FK bắt buộc). Nếu chỉ log ra console thì thông
-- tin mất hẳn — bảng này giữ lại để hiển thị lên màn Kênh bán cho người dùng tự đối
-- chiếu và sửa SKU, đồng thời cho biết đang bỏ sót bao nhiêu doanh số.
CREATE TABLE "channel_sku_gaps" (
    "id" BIGSERIAL NOT NULL,
    "channel" "OrderSource" NOT NULL,
    "sku" TEXT NOT NULL,
    -- Tên sản phẩm/phiên bản do kênh trả về, để người dùng nhận ra hàng nào
    "product_name" TEXT,
    "variant_name" TEXT,
    -- Cộng dồn qua các lần đồng bộ: số dòng hàng và tổng số lượng đã bị bỏ
    "line_count" INTEGER NOT NULL DEFAULT 0,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    -- Tổng tiền của các dòng bị bỏ — đây là phần doanh số không quy được về sản phẩm
    "amount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "first_seen_at" TIMESTAMP(3) NOT NULL,
    "last_seen_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channel_sku_gaps_pkey" PRIMARY KEY ("id")
);

-- Mỗi (kênh, SKU) chỉ một dòng — lần đồng bộ sau cộng dồn vào đúng dòng đó
CREATE UNIQUE INDEX "channel_sku_gaps_channel_sku_key" ON "channel_sku_gaps"("channel", "sku");
