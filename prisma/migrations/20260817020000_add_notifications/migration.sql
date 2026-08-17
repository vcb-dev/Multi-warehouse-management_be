-- Thông báo in-app (notification center).
--
-- Viết TAY chứ không sinh bằng `prisma migrate dev`: DB thật đang lệch nặng so với
-- migration history (bảng "ma" branches/warehouses, index/FK thừa), nên diff tự động
-- sinh ra hàng loạt DROP CONSTRAINT / DROP INDEX vào các bảng đang chạy thật.
-- File này chỉ chứa đúng phần notification, không đụng gì khác.

-- Giá trị enum dùng ĐÚNG topic webhook Sapo (`/admin/webhooks.json`) để sau này bật
-- webhook thật thì không phải đổi tên sự kiện hay migrate dữ liệu cũ.
CREATE TYPE "NotificationTopic" AS ENUM (
    'orders/create',
    'orders/paid',
    'orders/cancelled',
    'orders/fulfilled',
    'fulfillments/create',
    'fulfillments/update',
    'refunds/create',
    'customers/create'
);

-- Một dòng = MỘT sự kiện, không gắn user (người nhận nằm ở notification_recipients).
CREATE TABLE "notifications" (
    "id" BIGSERIAL NOT NULL,
    "topic" "NotificationTopic" NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" BIGINT NOT NULL,
    "location_id" BIGINT,
    "title" TEXT NOT NULL,
    "payload" JSONB,
    "created_on" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- Fan-out + trạng thái đã đọc.
CREATE TABLE "notification_recipients" (
    "notification_id" BIGINT NOT NULL,
    "user_id" BIGINT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'app',
    "read_on" TIMESTAMP(3),

    CONSTRAINT "notification_recipients_pkey" PRIMARY KEY ("notification_id", "user_id", "channel")
);

-- Cấu hình theo topic — nguồn dữ liệu trang /cau-hinh/thong-bao.
CREATE TABLE "notification_settings" (
    "id" BIGSERIAL NOT NULL,
    "topic" "NotificationTopic" NOT NULL,
    "app_enabled" BOOLEAN NOT NULL DEFAULT true,
    "email_enabled" BOOLEAN NOT NULL DEFAULT false,
    "recipient_permissions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "created_on" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "modified_on" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notifications_subject_type_subject_id_idx" ON "notifications"("subject_type", "subject_id");

-- CreateIndex
CREATE INDEX "notifications_created_on_idx" ON "notifications"("created_on");

-- Index chủ lực: đếm badge chưa đọc + phân trang keyset theo user (mới nhất trước).
-- CreateIndex
CREATE INDEX "notification_recipients_user_id_read_on_notification_id_idx" ON "notification_recipients"("user_id", "read_on", "notification_id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "notification_settings_topic_key" ON "notification_settings"("topic");

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_recipients" ADD CONSTRAINT "notification_recipients_notification_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "notifications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_recipients" ADD CONSTRAINT "notification_recipients_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
