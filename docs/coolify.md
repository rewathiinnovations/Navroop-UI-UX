# Coolify

Create a **Docker Compose** service from this repo’s `docker-compose.yml`. Set environment variables from `.env.example` (names below). Deploy. Git push rebuilds the stack; the app container runs **pre-migrate** (backup + destructive-SQL gate), then `prisma migrate deploy`, then Next.js. No SSH and no manual migrate. Set `ALLOW_DESTRUCTIVE_MIGRATION=true` only when a pending migration contains `DROP TABLE`, `DROP COLUMN`, or `ALTER COLUMN … TYPE`.

Coolify injects env at runtime. Do not bake secrets into the image.

## Required

| Name | Notes |
| --- | --- |
| `POSTGRES_PASSWORD` | Postgres service password |
| `DATABASE_URL` | `postgresql://navroop:<POSTGRES_PASSWORD>@postgres:5432/navroop` (hostname **`postgres`**, port **5432**) |
| `AUTH_SECRET` | Long random string (NextAuth). `NEXTAUTH_SECRET` is an accepted alias |
| `NEXTAUTH_URL` | Public origin, e.g. `https://your-fqdn` |

Optional aliases: `AUTH_URL`, `NEXTAUTH_SECRET`. Optional first-admin: `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` (or `ADMIN_EMAIL` / `ADMIN_PASSWORD`).

## Optional

`POSTGRES_USER`, `POSTGRES_DB` (defaults `navroop`), `PORT` (default `3000`), `NEXT_PUBLIC_WORKSPACE_NAME`, `APP_URL`, `ENCRYPTION_KEY` (≥ 32 bytes), `CRON_SECRET`, `DATA_DIR` (default `/data`), `OBSERVABILITY_CONFIG_PATH` (default `/data/config/observability.json`), `STORAGE_DRIVER`, `ELK_*`, `BACKUP_*`, `S3_PUBLIC_URL`, `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, `GITHUB_OAUTH_CALLBACK_URL`, `FIRECRAWL_API_KEY`, `E2B_API_KEY` (first-boot migrate only; ignored after `SandboxProviderConfig` rows exist), `AI_GATEWAY_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `MORPH_API_KEY`.

Publish integrations (GitHub App, Cloudflare, Coolify) are configured in `/admin/integrations` — not env. Public host `162.35.99.80`. Local agent logins live in gitignored `.cursor/.env.deploy` — do not commit.

Local Postgres on host **5433** is `docker-compose.dev.yml` (`pnpm db:up`).

Coolify / compose healthcheck hits `GET /api/health` (DB + object storage, no auth). Sentry is configured in `/admin/integrations` (not env). The Node process reads a small JSON file at `OBSERVABILITY_CONFIG_PATH` (default `/data/config/observability.json`) because the SDK inits before the database is available. `docker-compose.yml` mounts volume `navroop_data` at `/data` (`DATA_DIR=/data`). The volume must be writable by the app user (uid 1001). If it is not, the app continues degraded and `/admin/health` names the path and likely cause (volume not mounted, or wrong ownership). Connect/disconnect rewrites the file from the Integration row (never file → DB); Sentry starts reporting only after the next application restart. First boot: if no Sentry Integration exists, a leftover `SENTRY_DSN` env value creates "Sentry (migrated)" and is then ignored.

The volume is a cache and bootstrap shortcut — not in the database backup, not replicated, and deleted if the Coolify app is deleted. Everything on it is reconstructible from Postgres or object storage. Full rule and recovery drill: [deployment.md](deployment.md).

## Scheduled tasks

Set `CRON_SECRET`. Add Coolify scheduled tasks (POST + `Authorization: Bearer $CRON_SECRET`):

| Schedule | URL |
| --- | --- |
| Every 10 minutes | `POST /api/cron/reap-sandboxes` |
| Every 2 minutes | `POST /api/cron/check-domains` |
| Every minute | `POST /api/cron/reap-jobs` |
| Daily | `POST /api/cron/thin-checkpoints` |
| Daily | `POST /api/cron/purge-projects` |
| Every 5 minutes | `POST /api/cron/check-sandbox-providers` |
| Daily | `POST /api/cron/check-integrations` |
| Daily 02:00 | `POST /api/cron/backup-db` |
| Weekly | `POST /api/cron/verify-storage` |
| Daily | `POST /api/cron/cleanup-orphans` |
| Hourly | `POST /api/cron/observability-heartbeat` |
| Daily | `POST /api/cron/observability-quota` |
| Every 10 minutes | `POST /api/cron/check-uptime` |
| Daily | `POST /api/cron/check-certs` |
| Daily | `POST /api/cron/system-checks-digest` |
| Hourly | `POST /api/cron/sweep-tmp` |

```bash
curl -X POST https://YOUR_HOST/api/cron/reap-sandboxes \
  -H "Authorization: Bearer $CRON_SECRET"

curl -X POST https://YOUR_HOST/api/cron/check-domains \
  -H "Authorization: Bearer $CRON_SECRET"

curl -X POST https://YOUR_HOST/api/cron/reap-jobs \
  -H "Authorization: Bearer $CRON_SECRET"

curl -X POST https://YOUR_HOST/api/cron/thin-checkpoints \
  -H "Authorization: Bearer $CRON_SECRET"

curl -X POST https://YOUR_HOST/api/cron/purge-projects \
  -H "Authorization: Bearer $CRON_SECRET"

curl -X POST https://YOUR_HOST/api/cron/check-sandbox-providers \
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

Optional env: `SANDBOX_IDLE_MINUTES` (default 5), `CHECKPOINT_RETENTION_DAYS` (default 7), `PURGE_DELETED_DAYS` (default 30).

## Static preview hostname

Generated sites are served from a **different origin** than the app (`/preview-static/{projectId}/…` with a short-lived signed token). After Cloudflare is connected, add a DNS record:

| Type | Name | Target |
| --- | --- | --- |
| CNAME | `preview-static` | the Navroop app hostname |

That becomes `preview-static.{zone}` (for example `preview-static.navroop.app`). Point it at the same Coolify app. Locally the path form on `localhost:3000` is used; CSP still allows framing only by the app origin.

## Deploy drain

Give the app container at least **15 seconds** after SIGTERM before SIGKILL. On SIGTERM the process marks jobs it owns as abandoned (`deploying`) so the workspace recovery panel appears immediately instead of waiting 60 seconds for a stale heartbeat.

Use Coolify **rolling deploy** plus the compose / Dockerfile `HEALTHCHECK` on `GET /api/health`. Do not cut over until health is 200. Boot is fail-closed: `ENCRYPTION_KEY` (≥ 32 bytes), `DATABASE_URL`, and `APP_URL` (or `NEXTAUTH_URL`) are named when missing, then pre-migrate → `prisma migrate deploy` → job reconcile → Next. Tag images with `GIT_SHA`. Roll back the **main Navroop app only** from `/admin/health` or `scripts/rollback.ts` — client site apps are untouched. The database is not auto-reverted; restore from backup. Full runbook: [release.md](release.md).

Staging is a **second Coolify application** with its own database, sandbox provider config, and a small plan budget. Do not share production data casually.

Backup uses a separate ElasticLake bucket (`BACKUP_*`). `BACKUP_BUCKET` must differ from `ELK_BUCKET`. Production refuses a local-filesystem backup driver. Enable versioning + lifecycle on both buckets. Keep `ENCRYPTION_KEY` in a password manager off-server.
