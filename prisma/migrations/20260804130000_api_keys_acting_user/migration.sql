-- Bảng api_keys chưa có dữ liệu thật (mới tạo ở migration trước) nên đổi thẳng, không cần backfill.
ALTER TABLE "api_keys" DROP COLUMN "scopes";
ALTER TABLE "api_keys" DROP COLUMN "location_ids";
ALTER TABLE "api_keys" ADD COLUMN "acting_user_id" BIGINT NOT NULL;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_acting_user_id_fkey" FOREIGN KEY ("acting_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
