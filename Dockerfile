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
# No version here on purpose. `package.json` "packageManager" is the single source of truth,
# and corepack's shims resolve it from the nearest package.json at invocation. The Dockerfile
# used to `corepack prepare pnpm@9.15.9 --activate` beside a repo declaring pnpm 11: either
# corepack fetched 11 anyway and the pin was a lie, or pnpm 9 read a v9 lockfile plus
# `pnpm-workspace.yaml` keys it does not understand (`allowBuilds`,
# `minimumReleaseAgeExclude`, `verifyDepsBeforeRun`) and silently dropped the `overrides`
# that pin the tar and deepmerge-ts advisories — shipping the vulnerable transitives while
# `pnpm audit` on a developer machine reported clean (F-716).
RUN corepack enable
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
# Fails the build rather than installing under a pnpm that cannot read this lockfile.
# String concatenation, not template literals: Docker substitutes ${...} in a RUN line with
# build args and would blank them out.
RUN corepack install \
  && node -e "const want=require('./package.json').packageManager.split('@')[1];const got=require('node:child_process').execSync('pnpm --version').toString().trim();if(got!==want){console.error('pnpm '+got+' is not the declared packageManager '+want);process.exit(1)}console.log('pnpm '+got)"
RUN pnpm install --frozen-lockfile --ignore-scripts

# FROM deps, not base: the builder then inherits both node_modules and the corepack-installed
# pnpm, so `pnpm build` cannot resolve a different version than the one deps asserted.
FROM deps AS builder
WORKDIR /app
COPY . .
ARG GIT_SHA=unknown
ENV GIT_SHA=${GIT_SHA}
ENV NEXT_TELEMETRY_DISABLED=1
# Placeholder only — prisma generate reads the schema URL, it is not used at runtime.
ENV DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build"
# BUILD-TIME ONLY. `next build` inlines every `NEXT_PUBLIC_*` read into the client chunks, so
# these must arrive as build args (docker-compose.yml `app.build.args`). Listing them under
# compose `environment:` reaches the runtime process and never the browser bundle, which is how
# the shipped bundle carried `undefined` for NEXT_PUBLIC_APP_URL while `assertInternalOrigin()`
# certified the runtime copy at boot (F-725). Changing one needs a rebuild, not a restart.
ARG NEXT_PUBLIC_APP_URL
ENV NEXT_PUBLIC_APP_URL=${NEXT_PUBLIC_APP_URL}
ARG NEXT_PUBLIC_WORKSPACE_NAME=Navroop
ENV NEXT_PUBLIC_WORKSPACE_NAME=${NEXT_PUBLIC_WORKSPACE_NAME}
# Fallback DSN for statically prerendered pages only; live pages read the <meta> tag that
# lib/sentry/config-meta.tsx renders from the runtime config on the volume.
ARG NEXT_PUBLIC_SENTRY_DSN
ENV NEXT_PUBLIC_SENTRY_DSN=${NEXT_PUBLIC_SENTRY_DSN}
# Fail here rather than shipping a bundle whose own origin is the string "undefined". There is
# no runtime recovery: the value is a literal in the client chunks by the time the app boots.
RUN node -e "if(!(process.env.NEXT_PUBLIC_APP_URL||'').trim()){console.error('NEXT_PUBLIC_APP_URL must be passed as a build arg: it is inlined into the client bundle and cannot be supplied at runtime');process.exit(1)}console.log('NEXT_PUBLIC_APP_URL ok')"
# Direct binary, never `pnpm exec`: .cursor/lessons-learned.md bans combining pnpm with a
# tool that owns locked native engines, and lib/verify/orchestrator.ts already calls it this way.
RUN node ./node_modules/prisma/build/index.js generate
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
