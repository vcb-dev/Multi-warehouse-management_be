# CI/CD Deploy Warehouse BE (Docker Hub → Railway)

Railway chạy image **`viejhaf/warehouse-be:latest`** (không build từ GitHub).

```text
push main
  → GitHub Actions: prisma migrate deploy  (qua DIRECT_URL — Direct connection)
  → docker build (linux/amd64) → push Docker Hub
  → railway redeploy API  (kéo lại :latest)
  → container start: prisma migrate deploy lần nữa (idempotent) rồi start API
```

## GitHub Secrets (bắt buộc)

Repo → **Settings → Secrets and variables → Actions**

| Secret | Giá trị |
|--------|---------|
| `DATABASE_URL` | Transaction pooler (port **6543**, `?pgbouncer=true`) — app runtime |
| `DIRECT_URL` | **Session mode** pooler port **5432** (khuyến nghị cho GitHub Actions / IPv4) — migrate |
| `RAILWAY_TOKEN` | Project Token (Railway → Project → Settings → Tokens) |
| `RAILWAY_SERVICE_API` | Service ID của warehouse-be trên Railway |
| `DOCKERHUB_USERNAME` | Username Docker Hub (vd `viejhaf`) |
| `DOCKERHUB_TOKEN` | Access Token Docker Hub (Account Settings → Security) |

### Lấy DIRECT_URL (quan trọng)

Supabase Dashboard → **Connect**:

| Dùng cho | Mode | Port |
|----------|------|------|
| App (`DATABASE_URL`) | Transaction pooler | **6543** |
| Migrate CI (`DIRECT_URL`) | **Session mode** pooler | **5432** |

> `db.*.supabase.co` (Direct) thường IPv6 — GitHub Actions hay lỗi `Can't reach database server`. Dùng Session pooler `:5432` cho CI.

Nếu dùng Transaction `:6543` cho migrate sẽ gặp `read-only transaction` / prepared statement errors.

Trên Railway: set `DIRECT_URL` = Session `:5432` nếu muốn migrate lúc start container.
## Workflows

| File | Khi chạy |
|------|----------|
| `ci.yml` | PR / push `main` — pnpm install + prisma generate + build |
| `deploy-railway.yml` | Push `main` hoặc **Actions → Deploy Railway → Run workflow** |

### Test thủ công
1. Actions → **Deploy Railway** → **Run workflow**
2. `skip_docker_push` = `false` (full) hoặc `true` (chỉ redeploy Railway; vẫn chạy migrate)

## Chỉ chủ repo được merge `main`

1. **Settings → Rules → Branch rules** (rule cho `main`)
2. Bật **Require a pull request before merging**
3. **Show additional settings**:
   - **Required approvals** = `1`
   - Bật **Require review from Code Owners**
4. File `.github/CODEOWNERS` trong repo (đã có) — sửa `@truqhieu` thành username chủ repo nếu cần
5. Collaborator khác: role **Triage** (tạo PR được, **không** merge được). Chỉ Owner/Maintain mới merge sau khi Code Owner approve

## Railway

1. Service → **Deploy from Docker Image**: `viejhaf/warehouse-be:latest`
2. Healthcheck Path: `/api/health`
3. Variables: `DATABASE_URL` (pooler) + `DIRECT_URL` (direct) + JWT/CORS…
4. Container start: `prisma migrate deploy && node dist/src/main`

## Khi thêm bảng / đổi schema

```bash
pnpm exec prisma migrate dev --name ten_migration
git add prisma/migrations prisma/schema.prisma
git commit -m "Add migration ..."
# push nhánh → PR → chủ repo approve → merge main
```

CI/CD sẽ tự `migrate deploy` bằng Direct URL — không cần migrate tay trên production.
