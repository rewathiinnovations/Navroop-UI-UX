# Coolify

Create a **Docker Compose** service from this repo’s `docker-compose.yml`. Set environment variables from `.env.example` (names below). Deploy. Git push rebuilds the stack; the app container runs **pre-migrate** (backup + destructive-SQL gate), then `prisma migrate deploy`, then Next.js. No SSH and no manual migrate. Set `ALLOW_DESTRUCTIVE_MIGRATION=true` only when a pending migration contains `DROP TABLE`, `DROP COLUMN`, or `ALTER COLUMN … TYPE`.

Coolify injects env at runtime. Do not bake secrets into the image.

## Required

| Name                | Notes                                                                                                     |
| ------------------- | --------------------------------------------------------------------------------------------------------- |
| `POSTGRES_PASSWORD` | Postgres service password                                                                                 |
| `DATABASE_URL`      | `postgresql://navroop:<POSTGRES_PASSWORD>@postgres:5432/navroop` (hostname **`postgres`**, port **5432**) |
| `AUTH_SECRET`       | Long random string (NextAuth). `NEXTAUTH_SECRET` is an accepted alias                                     |
| `NEXTAUTH_URL`      | Public origin, e.g. `https://your-fqdn`                                                                   |

Optional aliases: `AUTH_URL`, `NEXTAUTH_SECRET`. Optional first-admin: `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` (or `ADMIN_EMAIL` / `ADMIN_PASSWORD`).

## Optional

`POSTGRES_USER`, `POSTGRES_DB` (defaults `navroop`), `PORT` (default `3000`), `NEXT_PUBLIC_WORKSPACE_NAME`, `APP_URL`, `ENCRYPTION_KEY` (≥ 32 bytes), `CRON_SECRET`, `DATA_DIR` (default `/data`), `OBSERVABILITY_CONFIG_PATH` (default `/data/config/observability.json`), `STORAGE_DRIVER`, `ELK_*`, `BACKUP_*`, `S3_PUBLIC_URL`, `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, `GITHUB_OAUTH_CALLBACK_URL`, `FIRECRAWL_API_KEY`, `AI_GATEWAY_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `MORPH_API_KEY`.

Most of those are also editable in `/admin/config` (runtime), where a saved value wins over the env variable — `APP_URL`, `CRON_SECRET`, `STORAGE_DRIVER`, `ELK_*`, `BACKUP_*`, `S3_PUBLIC_URL`, `GITHUB_OAUTH_*`, `FIRECRAWL_API_KEY`, `MORPH_API_KEY` and the AI keys. Container-level values (`POSTGRES_*`, `PORT`, `DATA_DIR`, `OBSERVABILITY_CONFIG_PATH`, `ENCRYPTION_KEY`, `NEXT_PUBLIC_WORKSPACE_NAME`) are env only. `E2B_API_KEY` is still read into the `tooling.e2b.apiKey` setting but nothing consumes it: generated code no longer runs in a sandbox VM.

Publish integrations (GitHub App, Cloudflare, Coolify) are configured in `/admin/integrations` — not env. Public host `162.35.99.80`. Local agent logins live in gitignored `.cursor/.env.deploy` — do not commit.

Local Postgres on host **5433** is `docker-compose.dev.yml` (`pnpm db:up`).

Coolify / compose healthcheck hits `GET /api/health` (DB + object storage, no auth). Sentry is configured in `/admin/integrations` (not env). The Node process reads a small JSON file at `OBSERVABILITY_CONFIG_PATH` (default `/data/config/observability.json`) because the SDK inits before the database is available. `docker-compose.yml` mounts volume `navroop_data` at `/data` (`DATA_DIR=/data`). The volume must be writable by the app user (uid 1001). If it is not, the app continues degraded and `/admin/health` names the path and likely cause (volume not mounted, or wrong ownership). Connect/disconnect rewrites the file from the Integration row (never file → DB); Sentry starts reporting only after the next application restart. First boot: if no Sentry Integration exists, a leftover `SENTRY_DSN` env value creates "Sentry (migrated)" and is then ignored.

The volume is a cache and bootstrap shortcut — not in the database backup, not replicated, and deleted if the Coolify app is deleted. Everything on it is reconstructible from Postgres or object storage. Full rule and recovery drill: [deployment.md](deployment.md).

## Scheduled tasks

Set `CRON_SECRET`. Add Coolify scheduled tasks (POST + `Authorization: Bearer $CRON_SECRET`):

| Schedule         | URL                                      |
| ---------------- | ---------------------------------------- |
| Every 2 minutes  | `POST /api/cron/check-domains`           |
| Every minute     | `POST /api/cron/reap-jobs`               |
| Daily            | `POST /api/cron/thin-checkpoints`        |
| Daily            | `POST /api/cron/purge-projects`          |
| Daily            | `POST /api/cron/check-integrations`      |
| Daily 02:00      | `POST /api/cron/backup-db`               |
| Weekly           | `POST /api/cron/verify-storage`          |
| Daily            | `POST /api/cron/cleanup-orphans`         |
| Hourly           | `POST /api/cron/observability-heartbeat` |
| Daily            | `POST /api/cron/observability-quota`     |
| Every 10 minutes | `POST /api/cron/check-uptime`            |
| Daily            | `POST /api/cron/check-certs`             |
| Daily            | `POST /api/cron/system-checks-digest`    |
| Hourly           | `POST /api/cron/sweep-tmp`               |

**A `409` from a cron endpoint is not a failure.** Each run claims an in-flight marker first (`AppSetting` key `cron.inflight.<name>`), so a second invocation of the same task while the first is still working answers `409` with code `CRON_ALREADY_RUNNING` instead of doubling the work — do not alert on it, and do not retry it. Only the run holding the claim writes a `CronRun` row, so a refused request never records a red run against the wrong invocation. A claim is considered abandoned after the per-cron budget in `lib/cron/claim.ts` (`CRON_CLAIM_STALE_MS`: 5 minutes for the minute-tick tasks, 30 for the daily maintenance ones, 60 for the dump and object-store ones, 15 by default) — this is an in-flight budget, deliberately not `CRON_STALE_MS`, whose 48-hour entries answer a different question (a task that stopped being scheduled at all). The next invocation after an abandoned claim takes it over and writes the failed `CronRun` row the killed run never got to.

Every task above except `system-checks-digest` is monitored by `CRON_STALE_MS`, so /admin/health and the daily digest name it if it stops running. `system-checks-digest` is the sender and cannot report its own silence: if it is never scheduled, or its task is deleted, nothing in the product notices and total silence looks identical to everything being healthy. Point an external dead-man's-switch (an uptime monitor with an expected-ping schedule) at that task so the digest going dark is itself an alert.

```bash
curl -X POST https://YOUR_HOST/api/cron/check-domains \
  -H "Authorization: Bearer $CRON_SECRET"

curl -X POST https://YOUR_HOST/api/cron/reap-jobs \
  -H "Authorization: Bearer $CRON_SECRET"

curl -X POST https://YOUR_HOST/api/cron/thin-checkpoints \
  -H "Authorization: Bearer $CRON_SECRET"

curl -X POST https://YOUR_HOST/api/cron/purge-projects \
  -H "Authorization: Bearer $CRON_SECRET"

curl -X POST https://YOUR_HOST/api/cron/check-integrations \
  -H "Authorization: Bearer $CRON_SECRET"

curl -X POST https://YOUR_HOST/api/cron/backup-db \
  -H "Authorization: Bearer $CRON_SECRET"

curl -X POST https://YOUR_HOST/api/cron/verify-storage \
  -H "Authorization: Bearer $CRON_SECRET"

curl -X POST https://YOUR_HOST/api/cron/cleanup-orphans \
  -H "Authorization: Bearer $CRON_SECRET"

curl -X POST https://YOUR_HOST/api/cron/observability-heartbeat \
  -H "Authorization: Bearer $CRON_SECRET"

curl -X POST https://YOUR_HOST/api/cron/observability-quota \
  -H "Authorization: Bearer $CRON_SECRET"

curl -X POST https://YOUR_HOST/api/cron/check-uptime \
  -H "Authorization: Bearer $CRON_SECRET"

curl -X POST https://YOUR_HOST/api/cron/check-certs \
  -H "Authorization: Bearer $CRON_SECRET"

curl -X POST https://YOUR_HOST/api/cron/system-checks-digest \
  -H "Authorization: Bearer $CRON_SECRET"

curl -X POST https://YOUR_HOST/api/cron/sweep-tmp \
  -H "Authorization: Bearer $CRON_SECRET"
```

Optional env: `CHECKPOINT_RETENTION_DAYS` (default 7), `PURGE_DELETED_DAYS` (default 30). Both are also editable in `/admin/config` (runtime), where a saved value wins over the env variable.

## Static preview hostname

Generated sites are served from a **different origin** than the app (`/preview-static/{projectId}/…` with a short-lived signed token). After Cloudflare is connected, add a DNS record:

| Type  | Name             | Target                   |
| ----- | ---------------- | ------------------------ |
| CNAME | `preview-static` | the Navroop app hostname |

That becomes `preview-static.{zone}` (for example `preview-static.navroop.app`). Point it at the same Coolify app. Locally the path form on `localhost:3000` is used; CSP still allows framing only by the app origin.

## Password-protected client previews

A published **preview** can be gated behind HTTP Basic Auth from the workspace Publish sheet. This adds no environment variable to _this_ application — it writes one onto the **client site's** Coolify application:

| Name               | Where                                                                                                   | Label                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `PREVIEW_PASSWORD` | the generated site's Coolify application, written by `updatePreviewPassword` (`lib/publish/publish.ts`) | Runtime (of the deployed site) — **set by Navroop; do not edit or delete** |

Node (Next.js) previews compare it in a `middleware.ts` that Navroop injects into the deploy repo (`lib/publish/preview-inject.ts`), and fail closed: no `PREVIEW_PASSWORD` means every request gets 401, never an open preview. Static previews use Coolify's own Traefik basic auth instead (`is_http_basic_auth_enabled`, username `preview`) and get no injected file.

The bcrypt hash lives on `Deployment.passwordHash` in Navroop's database; the plaintext exists only as that env var, because middleware cannot verify a hash. Deleting or editing the variable by hand therefore changes a client preview's access posture and nothing in the product notices. Setting a password writes the hash, then the env var, then re-publishes, so the middleware and the value it compares against land in the same build. Known open defects: F-231 (a failed re-publish leaves the new plaintext on the application) and F-232 (the password change runs a full publish inline) — see the Publish bullet in `AGENTS.md`.

## Deploy drain

Give the app container at least **15 seconds** after SIGTERM before SIGKILL. On SIGTERM — and on SIGINT, so a local Ctrl-C behaves the same — the process marks jobs it owns as abandoned (`deploying`) so the workspace recovery panel appears immediately instead of waiting 60 seconds for a stale heartbeat.

That drain is bounded at **5 seconds** and then the process exits regardless. If Postgres is the reason for the restart, an unbounded drain would leave the container alive until SIGKILL, which is a stuck deploy; the jobs it did not get to are recovered by `reap-jobs` within the minute instead.

Use Coolify **rolling deploy** plus the compose / Dockerfile `HEALTHCHECK` on `GET /api/health`. Do not cut over until health is 200. Boot is fail-closed: `ENCRYPTION_KEY` (≥ 32 bytes), `DATABASE_URL`, and `APP_URL` (or `NEXTAUTH_URL`) are named when missing, then pre-migrate → `prisma migrate deploy` → job reconcile → Next. Tag images with `GIT_SHA`. Roll back the **main Navroop app only** from `/admin/health` or `scripts/rollback.ts` — client site apps are untouched. The database is not auto-reverted; restore from backup. Full runbook: [release.md](release.md).

Staging is a **second Coolify application** with its own database and a small plan budget. Do not share production data casually.

Backup uses a separate ElasticLake bucket (`BACKUP_*`). `BACKUP_BUCKET` must differ from `ELK_BUCKET`. Production refuses a local-filesystem backup driver. Enable versioning + lifecycle on both buckets. Keep `ENCRYPTION_KEY` in a password manager off-server.
