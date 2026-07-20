# CI/CD Deploy Warehouse BE (Docker Hub → Railway)

Railway chạy image **`viejhaf/warehouse-be:latest`** (không build từ GitHub).

```text
push main
  → GitHub Actions: docker build (linux/amd64) → push Docker Hub
  → railway redeploy API  (kéo lại :latest)
```

## GitHub Secrets (bắt buộc)

Repo → **Settings → Secrets and variables → Actions**

| Secret | Giá trị |
|--------|---------|
| `RAILWAY_TOKEN` | Project Token (Railway → Project → Settings → Tokens) |
| `RAILWAY_SERVICE_API` | Service ID của warehouse-be trên Railway |
| `DOCKERHUB_USERNAME` | Username Docker Hub (vd `viejhaf`) |
| `DOCKERHUB_TOKEN` | Access Token Docker Hub (Account Settings → Security) |

## Workflows

| File | Khi chạy |
|------|----------|
| `ci.yml` | PR / push `main` — pnpm install + prisma generate + build |
| `deploy-railway.yml` | Push `main` hoặc **Actions → Deploy Railway → Run workflow** |

### Test thủ công
1. Actions → **Deploy Railway** → **Run workflow**
2. `skip_docker_push` = `false` (full) hoặc `true` (chỉ redeploy Railway)

## Railway (không cần connect nhánh GitHub)

1. Tạo service mới → **Deploy from Docker Image**
2. Image: `viejhaf/warehouse-be:latest`
3. Healthcheck Path: `/api/health`
4. Variables (xem `.env.railway.example`):
   - `DATABASE_URL`, `DIRECT_URL`
   - `JWT_SECRET`, `JWT_EXPIRES_IN`
   - `CORS_ORIGIN`, `APP_PUBLIC_URL`, `PUBLIC_UPLOAD_URL`
5. Container start đã chạy `prisma migrate deploy` rồi `node dist/src/main`

## Local Docker (tuỳ chọn)

```bash
# Tag local trùng tên production
docker build -t viejhaf/warehouse-be:latest .
docker push viejhaf/warehouse-be:latest
```
