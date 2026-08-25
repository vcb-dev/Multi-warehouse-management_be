-- Vá lệch default có từ 20260713100000_stn_draft_pending_status: migration đó thêm
-- 'nhap'/'cho_chuyen' bằng ADD VALUE nên Postgres không cho SET DEFAULT sang giá trị
-- vừa thêm trong cùng transaction, và default cột kẹt lại ở 'dang_chuyen' (nay là
-- 'transferring') trong khi schema.prisma khai @default(draft).
--
-- Prisma client luôn tự điền default nên lệch này không lộ qua app, nhưng INSERT bằng
-- SQL thô sẽ tạo phiếu chuyển kho thẳng vào trạng thái "đang chuyển". Giá trị 'draft'
-- giờ đã tồn tại sẵn nên SET DEFAULT chạy được bình thường.
ALTER TABLE "stock_transfers" ALTER COLUMN "status" SET DEFAULT 'draft';
