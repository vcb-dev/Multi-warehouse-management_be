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

# Prefer migrate ở CI (DIRECT_URL = db.*.supabase.co). Nếu Railway có DIRECT_URL hợp lệ thì migrate lại khi start (idempotent).
CMD ["sh", "-c", "if [ -n \"$DIRECT_URL\" ] && echo \"$DIRECT_URL\" | grep -vq pooler.supabase.com; then ./node_modules/.bin/prisma migrate deploy; else echo 'Skip start migrate: set DIRECT_URL to Supabase Direct (db.*.supabase.co) or rely on CI migrate'; fi; exec node dist/src/main"]
