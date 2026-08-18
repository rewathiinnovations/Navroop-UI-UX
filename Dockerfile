# Navroop production image for Coolify Docker Compose.
# Build: prisma generate + Next.js standalone.
# Start: pre-migrate (backup + destructive gate), then prisma migrate deploy, then server.

FROM node:20-bookworm-slim AS base
# Pin the Node major used in production. Bump deliberately.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ENV PNPM_HOME="/pnpm"
ENV PATH="${PNPM_HOME}:${PATH}"
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile --ignore-scripts

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ARG GIT_SHA=unknown
ENV GIT_SHA=${GIT_SHA}
ENV NEXT_TELEMETRY_DISABLED=1
# Placeholder only — prisma generate reads the schema URL, it is not used at runtime.
ENV DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build"
RUN pnpm exec prisma generate
RUN pnpm build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ARG GIT_SHA=unknown
ENV GIT_SHA=${GIT_SHA}
RUN apt-get update \
  && apt-get install -y --no-install-recommends postgresql-client \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g prisma@6.19.3 tsx \
  && groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs nextjs \
  && mkdir -p /data/config /data/cache /data/tmp \
  && chown -R nextjs:nodejs /data

ENV DATA_DIR=/data
ENV OBSERVABILITY_CONFIG_PATH=/data/config/observability.json

COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=builder --chown=nextjs:nodejs /app/generated ./generated
COPY --from=builder --chown=nextjs:nodejs /app/scripts ./scripts
COPY --from=builder --chown=nextjs:nodejs /app/lib ./lib
COPY --from=builder --chown=nextjs:nodejs /app/tsconfig.json ./tsconfig.json
COPY --chown=nextjs:nodejs docker-entrypoint.mjs ./docker-entrypoint.mjs

USER nextjs
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "docker-entrypoint.mjs"]
