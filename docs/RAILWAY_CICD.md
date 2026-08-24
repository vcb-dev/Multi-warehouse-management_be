# CI/CD Deploy Warehouse BE (Docker Hub → Railway)

Railway chạy image **`viejhaf/warehouse-be:latest`** (không build từ GitHub).

```text
push main
  → GitHub Actions: prisma migrate deploy  (áp dụng migration mới)
  → docker build (linux/amd64) → push Docker Hub
  → railway redeploy API  (kéo lại :latest)
  → container start: prisma migrate deploy lần nữa (idempotent) rồi start API
```

## GitHub Secrets (bắt buộc)

Repo → **Settings → Secrets and variables → Actions**

| Secret | Giá trị |
|--------|---------|
| `DATABASE_URL` | Postgres URL — giống Railway (migrate cũng dùng URL này) |
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
2. `skip_docker_push` = `false` (full) hoặc `true` (chỉ redeploy Railway; vẫn chạy migrate)

## Railway (không cần connect nhánh GitHub)

1. Tạo service mới → **Deploy from Docker Image**
2. Image: `viejhaf/warehouse-be:latest`
3. Healthcheck Path: `/api/health`
4. Variables:
   - `DATABASE_URL` (bắt buộc)
   - Nếu schema còn `directUrl`: set thêm `DIRECT_URL` = cùng giá trị `DATABASE_URL` (hoặc bỏ dòng `directUrl` trong schema)
   - `JWT_SECRET`, `CORS_ORIGIN` (bắt buộc — xem mục dưới)
   - `APP_PUBLIC_URL`, `PUBLIC_UPLOAD_URL`
5. Container start: `prisma migrate deploy && node dist/src/main`

## Biến môi trường của luồng đăng nhập

Hai biến này KHÔNG có giá trị mặc định trên production — thiếu là app chết ngay lúc khởi
động. Cố ý: cả hai đều hỏng theo kiểu im lặng, và triệu chứng của chúng đều trông giống
"lỗi đăng nhập" chứ không giống lỗi cấu hình, nên rơi về mặc định chỉ tổ tốn hàng giờ dò.

| Biến | Bắt buộc | Ghi chú |
|---|---|---|
| `JWT_SECRET` | ✅ | `openssl rand -base64 32`. Tối thiểu 32 ký tự, không nhận giá trị mẫu. **Đổi nó là đăng xuất toàn bộ người dùng.** |
| `CORS_ORIGIN` | ✅ | Origin của FE, phân tách bằng dấu phẩy. Không kèm dấu `/` cuối, không dùng `*` (cookie sẽ bị trình duyệt bỏ lại). Dùng chung cho cả CORS lẫn `CsrfGuard`. |
| `AUTH_COOKIE_SAMESITE` | ⚠️ | Mặc định `lax`. Đặt `none` **bắt buộc** khi FE và BE nằm hai tên miền gốc khác nhau — đọc kỹ mục Safari bên dưới trước khi dùng. |
| `AUTH_COOKIE_SECURE` | — | Tự bật khi `NODE_ENV=production` hoặc `SameSite=none`. Thường không cần khai. |
| `AUTH_COOKIE_DOMAIN` | — | Chỉ khai khi muốn chia cookie giữa các subdomain. Sai domain = cookie im lặng không được gửi. |
| `JWT_ACCESS_TTL_MINUTES` | — | Mặc định 15. |
| `JWT_REFRESH_TTL_DAYS` | — | Mặc định 7 — mốc người dùng phải gõ lại mật khẩu. |

### Chọn `AUTH_COOKIE_SAMESITE`

- **Cùng tên miền gốc** (`app.vienchibao.vn` + `api.vienchibao.vn`) → để trống. Mặc định
  `lax` chạy tốt: nó chặn POST/`fetch` từ site khác (vector CSRF chính), còn `fetch` từ
  trang FE sang API vẫn là same-site nên cookie vẫn được gửi bình thường.

  Muốn chặt hơn thì đặt `strict` — nó chặn thêm cả điều hướng GET từ site khác. Đổi lại,
  link trong email trỏ THẲNG vào một endpoint API sẽ không mang được cookie phiên. Mặc
  định để `lax` chính là để không khoá trước cánh cửa đó.
- **Khác tên miền gốc** (FE trên `*.vercel.app`, BE trên `*.up.railway.app`) → bắt buộc
  `AUTH_COOKIE_SAMESITE=none`, nếu không trình duyệt không gửi cookie đi và mọi request
  401 ngay sau khi đăng nhập thành công. **Nhưng cấu hình này không chạy trên Safari** —
  xem mục dưới.

Mất `SameSite=lax/strict` là mất một lớp chống CSRF, nên `CsrfGuard` gánh phần đó ở cả hai
cấu hình: mọi lệnh ghi đi kèm cookie phiên phải có header `X-Requested-With` và `Origin`
nằm trong `CORS_ORIGIN`. Client nào gọi API bằng cookie mà không qua FE thì phải tự gắn
header đó; đường `x-api-key` và `Bearer` không bị ảnh hưởng.

### ⚠️ Safari không chạy được khi FE/BE khác tên miền gốc

Safari chặn cookie bên thứ ba mặc định (Full Third-Party Cookie Blocking, từ 13.1), và nó
phân loại "bên thứ ba" theo **tên miền đăng ký được (eTLD+1)**, không theo origin.

| Cấu hình | Chrome / Firefox | Safari |
|---|---|---|
| `app.vienchibao.vn` + `api.vienchibao.vn` | ✅ | ✅ cùng site `vienchibao.vn` |
| `x.vercel.app` + `y.up.railway.app` | ✅ với `SameSite=none` | ❌ chặn thẳng |

**`SameSite=None; Secure` không cứu được.** Đó là hai lớp khác nhau: `SameSite` là chính
sách mình khai, còn chặn cookie bên thứ ba là lớp riêng của Safari đứng trên nó. Khai đúng
hết mọi thứ, Chrome chạy hoàn hảo, Safari vẫn không lưu cookie.

Triệu chứng: `POST /api/auth/login` trả 200, không có lỗi nào trong console, nhưng request
kế tiếp 401 — và **chỉ trên Safari**. Rất dễ chẩn đoán nhầm thành lỗi backend.

Thêm một điểm: `vercel.app` và `up.railway.app` nằm trong Public Suffix List, nên kể cả
`app.vercel.app` + `api.vercel.app` cũng là hai site khác nhau, và không thể đặt
`AUTH_COOKIE_DOMAIN=.vercel.app`.

**Cách thoát duy nhất là đưa hai bên về cùng một tên miền gốc** — gắn custom domain
`app.vienchibao.vn` cho FE và `api.vienchibao.vn` cho BE. Vercel/Railway vẫn dùng được,
chỉ là không dùng tên miền mặc định của họ. Sau đó bỏ `AUTH_COOKIE_SAMESITE` để về `lax`.

Chừng nào chưa làm được, hãy coi **Safari (macOS + iOS) là không được hỗ trợ** và nói rõ
với người dùng, thay vì để họ tự gặp màn hình đăng nhập lặp vô tận. iOS không có ngoại lệ:
mọi trình duyệt trên iOS đều chạy trên WebKit, nên Chrome/Firefox trên iPhone cũng hỏng y
như Safari.

Sau khi có tên miền thật, mở thử một lượt trên Safari macOS và iOS trước khi mở cho người
dùng — đây là loại lỗi mà test tự động không bắt được.

> `JWT_EXPIRES_IN` là biến của mô hình phiên cũ, code hiện tại không đọc nữa — có set cũng
> không có tác dụng. Dùng `JWT_ACCESS_TTL_MINUTES` / `JWT_REFRESH_TTL_DAYS`.

### Chạy nhiều replica

`AuthCacheService` là cache trong RAM của từng process. Với nhiều hơn một replica, thu hồi
phiên (đăng xuất, khoá tài khoản, đổi role) có hiệu lực **ngay** trên instance nhận request
đó, còn các instance khác trễ tối đa 30 giây theo TTL — nguồn sự thật vẫn nằm ở database
nên không có chuyện quyền sai lệch lâu dài. Chấp nhận được thì giữ nguyên; muốn thu hồi
tức thì trên mọi instance thì phải chuyển cache sang Redis.

## Khi thêm bảng / đổi schema

```bash
pnpm exec prisma migrate dev --name ten_migration
git add prisma/migrations prisma/schema.prisma
git commit -m "Add migration ..."
git push origin main
```

CI/CD sẽ tự `migrate deploy` — không cần chạy tay trên production.
