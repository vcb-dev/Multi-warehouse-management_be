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
COPY --from=builder /app/scripts/migrate-deploy.cjs ./scripts/migrate-deploy.cjs

RUN mkdir -p uploads

EXPOSE 3001

# Prefer migrate ở CI. Script ép default_transaction_read_only=off (Supabase đôi khi bật read-only).
CMD ["sh", "-c", "node scripts/migrate-deploy.cjs; exec node dist/src/main"]
