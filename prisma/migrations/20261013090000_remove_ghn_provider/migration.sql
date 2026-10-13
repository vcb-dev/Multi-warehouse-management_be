-- Gỡ hãng GHN khỏi hệ thống (adapter và webhook đã xoá khỏi code).
-- Xoá hẳn dòng hãng khi không còn gì tham chiếu; còn vận đơn/ticket cũ thì giữ dòng để
-- lịch sử vẫn hiện tên hãng, chỉ ngắt kết nối, xoá token và ẩn khỏi danh sách chọn.
-- Chạy lại được: lần hai không còn dòng nào khớp.
DELETE FROM "shipping_providers" p
WHERE p."code" = 'ghn'
  AND NOT EXISTS (SELECT 1 FROM "fulfillments" f WHERE f."provider_id" = p."id")
  AND NOT EXISTS (SELECT 1 FROM "carrier_tickets" t WHERE t."provider_id" = p."id");

UPDATE "shipping_providers"
SET "is_connected" = false,
    "connection_config" = NULL,
    "is_active" = false
WHERE "code" = 'ghn';
