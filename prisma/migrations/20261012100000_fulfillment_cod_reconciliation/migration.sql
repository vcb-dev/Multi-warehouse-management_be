-- Đối soát COD trên vận đơn (Sapo "Trạng thái đối soát"). NULL = chưa đối soát.
-- Hai cột nullable, không DEFAULT: Postgres chỉ sửa metadata, không ghi lại bảng
-- fulfillments. IF NOT EXISTS để chạy lại được.
ALTER TABLE "fulfillments"
  ADD COLUMN IF NOT EXISTS "cod_reconciled_on" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "cod_reconciled_by" BIGINT;
