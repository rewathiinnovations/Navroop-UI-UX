# Navroop production image for Coolify Docker Compose.
# Build: prisma generate + Next.js standalone.
# Start: pre-migrate (backup + destructive gate), then prisma migrate deploy, then server.

# The Chromium the Quality tab's accessibility pass and Lighthouse run drive
# (lib/audit/headless-browser.ts). Global so the builder can assert it against the
# lockfile and the runner can install exactly it: a browser build only works with the
# playwright-core revision that expects it, so a pin that drifts from `package.json`
# would silently ship a browser the app cannot launch. Keep the two in step — the
# builder fails the build when they part.
ARG PLAYWRIGHT_VERSION=1.62.1

FROM node:22-bookworm-slim AS base
# Pin the Node major used in production. Bump deliberately. 22, not 20: the declared
# pnpm (11.21.0) requires Node >= 22.13 and imports `node:sqlite`, which does not exist
# on Node 20 — so on node:20 every pnpm 11 executable crashed at startup no matter how
# it was installed (ERR_UNKNOWN_BUILTIN_MODULE, deploy 2026-08-29). CI already runs the
# full verify on Node 22 (.github/workflows/verify.yml), so this also closes a
# build-runtime-vs-CI version split.
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
# No corepack at all. Four deploys died in this stage before the picture was
# complete: the node:20 image's bundled corepack predates npm's 2025 signing-key
# rotation ("Cannot find matching keyid"), corepack@latest refused Node 20,
# corepack@0.31.0 crashed on Node 20.20 with ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING —
# and then the npm-installed pnpm crashed too (ERR_UNKNOWN_BUILTIN_MODULE:
# node:sqlite), which exposed the real constraint: pnpm 11.21 simply cannot run
# below Node 22.13, hence the node:22 base above. The npm install is kept anyway:
# the version is still read from package.json "packageManager", so the single
# source of truth stands, npm verifies its own registry signatures, and the build
# does not depend on whichever corepack a base image happens to bundle.

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
# Fails the build rather than installing under a pnpm that cannot read this lockfile.
# String concatenation, not template literals: Docker substitutes ${...} in a RUN line with
# build args and would blank them out.
RUN npm install -g pnpm@"$(node -p "require('./package.json').packageManager.split('@')[1]")" \
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
# The runner installs the browser from a pinned `playwright@$PLAYWRIGHT_VERSION` rather
# than from this tree, because `.next/standalone` traces the library and not its CLI. That
# pin is only correct while it names the version the lockfile actually resolved: a browser
# build is matched to one playwright-core revision, and a mismatch surfaces at runtime as
# a launch failure on every scan, not at build time. String concatenation and
# `process.env`, never `${...}`, for the reason given above the pnpm assertion.
ARG PLAYWRIGHT_VERSION
RUN node -e "const want=process.env.PLAYWRIGHT_VERSION;const got=require('playwright/package.json').version;if(got!==want){console.error('playwright '+got+' is installed but the Dockerfile pins PLAYWRIGHT_VERSION='+want+' for the runtime browser; update the ARG to match package.json');process.exit(1)}console.log('playwright '+got)"
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

# A real Chromium, because without one the Quality tab's two most valuable checks cannot
# run at all in production: `pnpm install --ignore-scripts` above deliberately skips
# Playwright's postinstall download (supply-chain posture, kept), and nothing else here
# fetched a browser — so `chromium.launch()` threw "Executable does not exist" on every
# axe pass and every Lighthouse run. With no build runner in this deployment, the axe pass
# is the only check in the code audit that actually inspects the rendered site, so the
# alternative is a Scan button that can never do its main job.
#
# The cost is real and paid here on purpose: roughly 400 MB (a chromium build plus the
# ~100 apt packages `--with-deps` pulls in) and a couple of minutes of build time. It buys
# nothing on a deployment with no preview origin configured, because `auditPreviewUrl`
# mints no URL there and neither check is reached — but the failure it removes is the one
# that files a permanent tool failure against every project of a deployment that *is*
# configured. Automatic post-build scans no longer touch the browser at all
# (`runAutoCodeAudit` / `runAutoSeoAudit` run the static half), so this serves the Scan
# button only, one browser at a time, bounded and always closed by `withHeadlessBrowser`.
#
# It rides the same `npm install -g` the runtime already uses for prisma and tsx rather
# than a second pattern: a pinned global CLI this stage needs, next to the other two.
# `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` stops that install's postinstall fetching firefox and
# webkit as well — about a gigabyte for two engines nothing here launches — and
# `install --with-deps chromium` then fetches the one that is used, along with its system
# libraries. `chmod a+rX` because the download runs as root and the app runs as `nextjs`.
# An operator who does not want a browser in this image can drop the `playwright@…`
# argument and the two `playwright install` / `chmod` clauses: `isBrowserUnavailableError`
# (lib/audit/a11y.ts) then reports both checks as unavailable on this deployment instead
# of as a defect in the user's site.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ARG PLAYWRIGHT_VERSION
RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install -g prisma@6.19.3 tsx playwright@${PLAYWRIGHT_VERSION} \
  && playwright install --with-deps chromium \
  && chmod -R a+rX /ms-playwright \
  && rm -rf /var/lib/apt/lists/* \
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
