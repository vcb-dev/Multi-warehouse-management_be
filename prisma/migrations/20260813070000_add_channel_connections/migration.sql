-- Kết nối OAuth trực tiếp tới kênh bán (Shopee/TikTok Shop), bypass Sapo.
-- Mỗi gian hàng (shop) trên kênh ứng với 1 dòng riêng.
CREATE TABLE "channel_connections" (
    "id" BIGSERIAL NOT NULL,
    "channel" "OrderSource" NOT NULL,
    "shop_id" TEXT NOT NULL,
    "shop_name" TEXT,
    "access_token" TEXT NOT NULL,
    "access_token_expires_at" TIMESTAMP(3) NOT NULL,
    "refresh_token" TEXT NOT NULL,
    "refresh_token_expires_at" TIMESTAMP(3) NOT NULL,
    "granted_scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "location_id" BIGINT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channel_connections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "channel_connections_channel_shop_id_key" ON "channel_connections"("channel", "shop_id");

-- AddForeignKey
ALTER TABLE "channel_connections" ADD CONSTRAINT "channel_connections_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
