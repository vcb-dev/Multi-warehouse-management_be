-- CreateEnum
CREATE TYPE "PackingStatus" AS ENUM ('cho_dong_goi', 'cho_dan_phieu', 'da_dong_goi');

-- CreateEnum
CREATE TYPE "ShipmentStatus" AS ENUM ('cho_lay_hang', 'dang_giao', 'da_giao', 'giao_loi', 'da_hoan', 'huy');

-- CreateEnum
CREATE TYPE "ShippingProviderType" AS ENUM ('tich_hop', 'tu_lien_he');

-- CreateEnum
CREATE TYPE "ShippingFeePayer" AS ENUM ('shop_tra', 'khach_tra');

-- AlterTable
ALTER TABLE "branches" ADD COLUMN     "address" TEXT,
ADD COLUMN     "district" TEXT,
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "province" TEXT,
ADD COLUMN     "ward" TEXT;

-- CreateTable
CREATE TABLE "shipping_providers" (
    "id" BIGSERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "ShippingProviderType" NOT NULL,
    "is_connected" BOOLEAN NOT NULL DEFAULT false,
    "connection_config" JSONB,
    "services_config" JSONB,
    "phone" TEXT,
    "email" TEXT,
    "note" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shipping_providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fulfillments" (
    "id" BIGSERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "order_id" BIGINT NOT NULL,
    "packing_status" "PackingStatus",
    "packer_id" BIGINT,
    "packed_at" TIMESTAMP(3),
    "delivery_note_printed_at" TIMESTAMP(3),
    "shipment_status" "ShipmentStatus",
    "shipping_type" "ShippingProviderType",
    "provider_id" BIGINT,
    "service_code" TEXT,
    "service_name" TEXT,
    "tracking_code" TEXT,
    "shipping_fee" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "fee_payer" "ShippingFeePayer" NOT NULL DEFAULT 'shop_tra',
    "cod_amount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "weight_grams" INTEGER,
    "length_cm" INTEGER,
    "width_cm" INTEGER,
    "height_cm" INTEGER,
    "delivery_requirement" TEXT,
    "note" TEXT,
    "to_name" TEXT,
    "to_phone" TEXT,
    "to_address" TEXT,
    "to_ward" TEXT,
    "to_district" TEXT,
    "to_province" TEXT,
    "from_branch_id" BIGINT,
    "from_name" TEXT,
    "from_phone" TEXT,
    "from_address" TEXT,
    "pushed_at" TIMESTAMP(3),
    "picked_up_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "returned_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "cancel_reason" TEXT,
    "created_by" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fulfillments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shipping_providers_code_key" ON "shipping_providers"("code");

-- CreateIndex
CREATE UNIQUE INDEX "fulfillments_code_key" ON "fulfillments"("code");

-- CreateIndex
CREATE INDEX "fulfillments_order_id_idx" ON "fulfillments"("order_id");

-- CreateIndex
CREATE INDEX "fulfillments_shipment_status_idx" ON "fulfillments"("shipment_status");

-- AddForeignKey
ALTER TABLE "fulfillments" ADD CONSTRAINT "fulfillments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fulfillments" ADD CONSTRAINT "fulfillments_packer_id_fkey" FOREIGN KEY ("packer_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fulfillments" ADD CONSTRAINT "fulfillments_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "shipping_providers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fulfillments" ADD CONSTRAINT "fulfillments_from_branch_id_fkey" FOREIGN KEY ("from_branch_id") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fulfillments" ADD CONSTRAINT "fulfillments_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Mỗi đơn hàng chỉ có tối đa một fulfillment đang mở
CREATE UNIQUE INDEX "fulfillments_one_open_per_order" ON "fulfillments"("order_id") WHERE "closed_at" IS NULL;

