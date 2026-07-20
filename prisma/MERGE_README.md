# Schema tổng Warehouse + CQA CRM

Hai backend dùng **cùng một PostgreSQL** qua schema này.

## Schema owner

- **Canonical:** `Multi-warehouse-management_be/prisma/schema.prisma`
- **Mirror:** `CQA_CRM/CQA_BE/prisma/schema.prisma` (copy giống hệt)

Chỉ chạy `prisma migrate` từ **Warehouse BE**.

## User thống nhất

| CQA cũ | Schema mới |
|---|---|
| `fullName` | `name` |
| `password` | `passwordHash` |
| `phoneNumber` | `phone` |
| `role` (string) | `roles` (UserRole[]) |
| `id` Int | `id` BigInt |
| — | `tenantId`, `avatarUrl`, `status`, `updatedAt` |

API CQA vẫn trả `fullName`, `phoneNumber`, `role` qua helper `toPublicUser()`.

## Migrate DB (không mất data CQA)

### Trường hợp A — DB CQA Supabase đang có data

1. Backup database trước.
2. Thêm `DIRECT_URL` (port 5432) vào `.env` cả hai project.
3. Trên Warehouse BE:

```bash
cd Multi-warehouse-management_be
npx prisma migrate deploy
```

Migration `20260710120000_merge_cqa_unified` sẽ:
- Copy `password` → `password_hash`, `full_name` → `name`, v.v.
- Đổi `users.id` INT → BIGINT nếu cần
- Tạo bảng Warehouse chưa có
- Giữ nguyên data CQA (`tenants`, `cskh_*`, `chat_audits`)

### Trường hợp B — DB Warehouse mới (chưa có CQA)

```bash
npx prisma migrate deploy
npx prisma db seed   # nếu cần seed kho
```

### Sau migrate

```bash
# Warehouse BE
npx prisma generate

# CQA BE
cd CQA_CRM/CQA_BE
npx prisma generate
npm run build
```

## Env chung

```env
DATABASE_URL=postgresql://...@...supabase.com:6543/postgres?pgbouncer=true
DIRECT_URL=postgresql://...@...supabase.com:5432/postgres
```

Cả hai BE trỏ cùng `DATABASE_URL`.
