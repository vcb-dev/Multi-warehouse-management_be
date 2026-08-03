-- Tích hợp GHN: phiếu hỗ trợ (ticket) mở với hãng vận chuyển.
--
-- Sapo KHÔNG có khái niệm ticket với ĐTVC (đã đối chiếu docs/sapo-schema-mapping.md Phase 6:
-- fulfillments chỉ có `abnormal`/`picking_issues` là ghi chú bất thường, không phải luồng
-- trao đổi hai chiều). Vì vậy đây là 2 bảng riêng của dự án, đặt tên theo vốn từ của GHN
-- (`ticket/create`, `ticket/reply`, `ticket/index`, callback ticket).
--
-- Phần VẬN ĐƠN của tích hợp GHN không cần migration: mọi trường GHN trả về đã có cột Sapo
-- sẵn trên `fulfillments` (tracking_number/tracking_url/carrier/carrier_name/
-- expected_delivery_date/shipping_fee/weight_grams/cod_amount/abnormal) — trước đây chưa
-- có code nào ghi vào chúng. Mã district_id/ward_code riêng của GHN không lưu, resolve từ
-- tên ngay lúc gọi API.

-- 1) Enum: giá trị GHN trả về dạng chuỗi tiếng Việt, chuẩn hoá thành enum như các bảng khác
CREATE TYPE "CarrierTicketStatus" AS ENUM ('dang_xu_ly', 'cho_phan_hoi', 'hoan_thanh');
CREATE TYPE "CarrierTicketCategory" AS ENUM (
  'tu_van',
  'hoi_giao_lay_tra_hang',
  'thay_doi_thong_tin',
  'khieu_nai'
);

-- 2) carrier_tickets
CREATE TABLE "carrier_tickets" (
  "id"                  BIGSERIAL NOT NULL,
  "provider_id"         BIGINT NOT NULL,
  "fulfillment_id"      BIGINT,
  "order_id"            BIGINT,
  "external_id"         TEXT NOT NULL,
  "order_code"          TEXT NOT NULL,
  "category"            "CarrierTicketCategory" NOT NULL,
  "status"              "CarrierTicketStatus" NOT NULL DEFAULT 'dang_xu_ly',
  "status_raw"          TEXT,
  "description"         TEXT NOT NULL,
  "attachments"         JSONB,
  "contact_name"        TEXT,
  "contact_email"       TEXT,
  "contact_phone"       TEXT,
  "created_by"          BIGINT,
  "external_created_at" TIMESTAMP(3),
  "external_updated_at" TIMESTAMP(3),
  "synced_at"           TIMESTAMP(3),
  "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Prisma @updatedAt là application-level nên KHÔNG có default; INSERT bằng raw SQL
  -- phải truyền tay (bài học Phase 1 trong docs/sapo-schema-mapping.md)
  "updated_at"          TIMESTAMP(3) NOT NULL,

  CONSTRAINT "carrier_tickets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "carrier_tickets_external_id_key" ON "carrier_tickets"("external_id");
CREATE INDEX "carrier_tickets_order_code_idx" ON "carrier_tickets"("order_code");
CREATE INDEX "carrier_tickets_status_idx" ON "carrier_tickets"("status");
CREATE INDEX "carrier_tickets_fulfillment_id_idx" ON "carrier_tickets"("fulfillment_id");

ALTER TABLE "carrier_tickets"
  ADD CONSTRAINT "carrier_tickets_provider_id_fkey"
  FOREIGN KEY ("provider_id") REFERENCES "shipping_providers"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "carrier_tickets"
  ADD CONSTRAINT "carrier_tickets_fulfillment_id_fkey"
  FOREIGN KEY ("fulfillment_id") REFERENCES "fulfillments"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "carrier_tickets"
  ADD CONSTRAINT "carrier_tickets_order_id_fkey"
  FOREIGN KEY ("order_id") REFERENCES "orders"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "carrier_tickets"
  ADD CONSTRAINT "carrier_tickets_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- 3) carrier_ticket_messages <-> GHN `ticket.conversations[]`
CREATE TABLE "carrier_ticket_messages" (
  "id"                  BIGSERIAL NOT NULL,
  "ticket_id"           BIGINT NOT NULL,
  "sender_type"         TEXT NOT NULL,
  "from_email"          TEXT,
  "body"                TEXT NOT NULL,
  "attachments"         JSONB,
  "external_created_at" TIMESTAMP(3),
  "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "carrier_ticket_messages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "carrier_ticket_messages_ticket_id_external_created_at_idx"
  ON "carrier_ticket_messages"("ticket_id", "external_created_at");

ALTER TABLE "carrier_ticket_messages"
  ADD CONSTRAINT "carrier_ticket_messages_ticket_id_fkey"
  FOREIGN KEY ("ticket_id") REFERENCES "carrier_tickets"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
