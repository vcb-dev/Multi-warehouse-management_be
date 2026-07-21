# NestJS + Prisma — deploy Railway (hoặc bất kỳ container runtime nào)
FROM node:22-bookworm-slim AS base

RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN ./node_modules/.bin/prisma generate
RUN ./node_modules/.bin/nest build

FROM base AS runner
ENV NODE_ENV=production

COPY package.json pnpm-lock.yaml ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma

RUN mkdir -p uploads

EXPOSE 3001

# Auto-migrate khi start (idempotent; Prisma advisory lock nếu nhiều replica).
# CI/CD cũng chạy migrate deploy trước khi redeploy — xem docs/RAILWAY_CICD.md
CMD ["sh", "-c", "./node_modules/.bin/prisma migrate deploy && node dist/src/main"]
