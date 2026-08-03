ALTER TABLE "draft_orders"
  ADD COLUMN IF NOT EXISTS "expected_delivery_at" TIMESTAMP(3);
