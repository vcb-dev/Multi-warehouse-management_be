-- Bổ sung hai bucket của Sapo vào enum InventoryBucket.
-- Tách riêng khỏi migration gộp locations: `ALTER TYPE ... ADD VALUE` buộc Postgres
-- chạy từng lệnh ngoài transaction, nếu để chung sẽ mất tính nguyên tử của migration kia.
ALTER TYPE "InventoryBucket" ADD VALUE IF NOT EXISTS 'available';
ALTER TYPE "InventoryBucket" ADD VALUE IF NOT EXISTS 'reserved';
