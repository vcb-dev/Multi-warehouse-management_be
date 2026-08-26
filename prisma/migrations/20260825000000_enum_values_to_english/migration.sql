-- Đổi các enum còn giá trị tiếng Việt sang snake_case tiếng Anh, cho khớp
-- convention của những enum đã dựng theo Sapo (OrderStatus, ShipmentStatus,
-- OrderFinancialStatus...). Sapo không dùng giá trị tiếng Việt trong API —
-- tiếng Việt chỉ nằm ở label hiển thị (xem *_STATUS_LABELS ở BE/FE).
--
-- ALTER TYPE ... RENAME VALUE giữ nguyên dữ liệu: Postgres lưu enum theo OID
-- của label nên mọi hàng hiện có và mọi column DEFAULT tự động theo tên mới,
-- không cần backfill.

-- PoStatus: đơn đặt hàng nhập
ALTER TYPE "PoStatus" RENAME VALUE 'don_nhap' TO 'draft';
ALTER TYPE "PoStatus" RENAME VALUE 'cho_nhap' TO 'pending';
ALTER TYPE "PoStatus" RENAME VALUE 'da_nhap' TO 'received';
ALTER TYPE "PoStatus" RENAME VALUE 'huy' TO 'cancelled';

-- GoodsReceiptStatus: phiếu nhập hàng
ALTER TYPE "GoodsReceiptStatus" RENAME VALUE 'chua_nhap' TO 'pending';
ALTER TYPE "GoodsReceiptStatus" RENAME VALUE 'da_nhap' TO 'received';
ALTER TYPE "GoodsReceiptStatus" RENAME VALUE 'huy' TO 'cancelled';

-- PaymentStatus: thanh toán cho NCC trên phiếu nhập
ALTER TYPE "PaymentStatus" RENAME VALUE 'chua_thanh_toan' TO 'unpaid';
ALTER TYPE "PaymentStatus" RENAME VALUE 'mot_phan' TO 'partially_paid';
ALTER TYPE "PaymentStatus" RENAME VALUE 'da_thanh_toan' TO 'paid';

-- StockTransferStatus: phiếu chuyển kho
ALTER TYPE "StockTransferStatus" RENAME VALUE 'nhap' TO 'draft';
ALTER TYPE "StockTransferStatus" RENAME VALUE 'cho_chuyen' TO 'pending';
ALTER TYPE "StockTransferStatus" RENAME VALUE 'dang_chuyen' TO 'transferring';
ALTER TYPE "StockTransferStatus" RENAME VALUE 'da_nhan' TO 'received';
ALTER TYPE "StockTransferStatus" RENAME VALUE 'huy' TO 'cancelled';

-- RefundStatus: hoàn tiền của phiếu trả hàng nhập
ALTER TYPE "RefundStatus" RENAME VALUE 'chua_hoan_tien' TO 'no_refund';
ALTER TYPE "RefundStatus" RENAME VALUE 'da_hoan_tien' TO 'refunded';
