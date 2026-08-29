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

`POSTGRES_USER`, `POSTGRES_DB` (defaults `navroop`), `PORT` (default `3000`), `NEXT_PUBLIC_WORKSPACE_NAME`, `APP_URL`, `ENCRYPTION_KEY` (≥ 32 bytes), `CRON_SECRET`, `DATA_DIR` (default `/data`), `OBSERVABILITY_CONFIG_PATH` (default `/data/config/observability.json`), `STORAGE_DRIVER`, `ELK_*`, `BACKUP_*`, `S3_PUBLIC_URL`, `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, `GITHUB_OAUTH_CALLBACK_URL`, `FIRECRAWL_API_KEY`, `DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GIT_SHA` / `SOURCE_COMMIT`, `NEXT_PUBLIC_SENTRY_DSN` (**build-time**, see below).

`.env.example` is the authoritative list and carries a build-time/runtime label per variable; this section is the deployment-shaped subset. Two corrections it took a while to make: `AI_GATEWAY_API_KEY`, `ANTHROPIC_API_KEY`, `GROQ_API_KEY` and `MORPH_API_KEY` used to be listed here and no code reads them — `GROQ_API_KEY` and `AI_GATEWAY_API_KEY` survive only in one diagnostic log line (`app/api/generate-ai-code-stream/route.ts`), Morph Fast Apply was deleted — while `DEEPSEEK_API_KEY`, the only key planning and building need, was missing, so a service with every listed variable set still failed with "DeepSeek is not configured". `GIT_SHA` is the release sha `/admin/health` and the rollback runbook compare against (runtime; Coolify sets it per deploy) and `SOURCE_COMMIT` is the fallback name read when `GIT_SHA` is absent (`lib/deploy/release.ts`, `lib/health/check.ts`) — a deployment that sets only `SOURCE_COMMIT` still reports a version, which is worth knowing before a rollback.

Most of those are also editable in `/admin/config` (runtime), where a saved value wins over the env variable — `APP_URL`, `CRON_SECRET`, `STORAGE_DRIVER`, `ELK_*`, `BACKUP_*`, `S3_PUBLIC_URL`, `GITHUB_OAUTH_*`, `FIRECRAWL_API_KEY` and `DEEPSEEK_API_KEY`. That page renders entirely from `lib/settings/registry.ts`, so a variable with no registry entry has no field on it. Container-level values (`POSTGRES_*`, `PORT`, `DATA_DIR`, `OBSERVABILITY_CONFIG_PATH`, `ENCRYPTION_KEY`, `NEXT_PUBLIC_WORKSPACE_NAME`) are env only.

**There are two credential stores and this section used to describe them as one.** `/admin/config` is the settings registry (`AppSetting` rows). The image keys are the other store: `OPENAI_API_KEY` and `GEMINI_API_KEY` resolve per request as personal `ApiKey` row → team `OrgApiKey` row → environment (`getEffectiveApiKey`, `lib/api-keys.ts`), and `/settings/api-keys` offers Firecrawl alone (`SETTINGS_API_KEY_PROVIDERS`), so on a deployment those two are set here, on the service. The sentence this replaces said "and the AI keys" were editable in `/admin/config`, which sent operators looking for fields that do not exist, and it documented an `E2B_API_KEY` feeding a `tooling` E2B setting — no registry entry defines that setting and no file under `lib/`, `app/`, `config/` or `scripts/` reads that variable. Generated code no longer runs in a sandbox VM, so neither the variable nor the setting is real. `tests/unit/docs-accuracy.test.ts` fails this file if it names a setting the registry does not define.

Publish integrations (GitHub App, Cloudflare, Coolify) are configured in `/admin/integrations` — not env. Public host `162.35.99.80`. Local agent logins live in gitignored `.cursor/.env.deploy` — do not commit.

Local Postgres on host **5433** is `docker-compose.dev.yml` (`pnpm db:up`).

Coolify / compose healthcheck hits `GET /api/health` (DB + object storage, no auth). Sentry is configured in `/admin/integrations` (not env). The Node process reads a small JSON file at `OBSERVABILITY_CONFIG_PATH` (default `/data/config/observability.json`) because the SDK inits before the database is available. `docker-compose.yml` mounts volume `navroop_data` at `/data` (`DATA_DIR=/data`). The volume must be writable by the app user (uid 1001). If it is not, the app continues degraded and `/admin/health` names the path and likely cause (volume not mounted, or wrong ownership). Connect/disconnect rewrites the file from the Integration row (never file → DB); Sentry starts reporting only after the next application restart. First boot: if no Sentry Integration exists, a leftover `SENTRY_DSN` env value creates "Sentry (migrated)" and is then ignored.

**The edge runtime is not covered by that file.** `middleware`/`proxy.ts` — the auth gate in front of every `/api` and `/preview-static` request — runs in an edge isolate with no filesystem, so it cannot read `OBSERVABILITY_CONFIG_PATH` and cannot reach the database. The only DSN it can carry is one inlined when the image is built: `NEXT_PUBLIC_SENTRY_DSN` (**build-time** — pass it as a build argument and rebuild; setting it at runtime does nothing for the edge bundle). Pass it and edge/middleware errors are captured; leave it and they are not, and a throw in the auth gate is reported nowhere. `/admin/health` → Error tracking → **Edge and middleware** says which of the two you have, in either direction. The same variable is also the client bundle's fallback DSN for statically prerendered pages, so one build argument covers both.

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

Every task above except `system-checks-digest` is monitored by `CRON_STALE_MS`, so /admin/health and the daily digest name it if it stops running. `system-checks-digest` is the sender and cannot report its own silence: if it is never scheduled, or its task is deleted, nothing in the product notices and total silence looks identical to everything being healthy.

**External dead-man's-switch (do this, or nothing watches the watcher).** Every digest run calls one outbound URL, and a _missing_ call is the alert. The monitor is yours to own; the product only pings it.

1. Create a heartbeat/push check on any monitor that alerts on a missed ping — Healthchecks.io ("ping URL"), Better Stack heartbeats, Uptime Kuma push monitor, Cronitor.
2. Set its expected period to **one day** with a grace of a few hours, matching the digest's daily schedule above. A shorter period alerts on every normal day; a longer one delays the alert past the point of usefulness.
3. Paste the ping URL into **Admin → Configuration → Application → Monitoring heartbeat URL** (runtime; no rebuild, no restart — it is read per run). Leave it blank and no ping is made and nothing complains, which is the pre-existing blind spot.
4. Confirm it once by firing `POST /api/cron/system-checks-digest` by hand (see below) and checking the monitor recorded a ping.

The digest calls the URL on every run, including the quiet run where nothing is stale — that quiet run is the common case, so a ping only on bad news would prove nothing. A ping that does not leave the building (DNS failure, non-2xx answer, malformed URL) makes the digest run itself fail, so it appears in Coolify's task history and on /admin/health rather than being swallowed. Nothing is retried: one missed ping on a daily schedule is what the monitor's grace period is for.

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

## Unreferenced objects in the bucket

`verify-storage` (weekly, above) does three things: it HEADs a page of checkpoint snapshots and reads the newest one back, it diffs every prefix this product writes against the rows that reference it, and it recomputes `Workspace.storageBytes` from those rows — which is also what repairs the ledger if a purge died halfway.

The snapshot check is **paged**: `VERIFY_CHECKPOINT_LIMIT` snapshots per run, resuming from an `AppSetting` cursor (`backup.verifyCursor`) and wrapping to the start when it reaches the end. So a large installation verifies its whole bucket over several weeks rather than timing out every week. The run reports `checked`, `totalSnapshots` and `nextCursor`.

The diff covers `snapshots/`, `previews/`, `projects/`, `users/` and `templates/`. An object under one of those prefixes that no row points at is **orphaned** — abandoned by a failed upload, a delete that half-completed, or a prune whose object delete failed. Two settings in **Admin → Configuration → Storage** control what happens (both runtime; no rebuild, no restart):

| Setting                             | Default     | Meaning                                                                                                                                                                    |
| ----------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Orphaned object grace period (days) | 14          | An orphan younger than this is never touched. Uploads happen seconds before the row that references them, so a short window would flag files that are about to be claimed. |
| Orphaned objects                    | Report only | `Report only` counts them on /admin/backups. `Delete after the grace period` also removes them, at most a few hundred per run.                                             |

**Start on Report only.** Read the counts on /admin/backups for a week or two and confirm they look like abandoned uploads and not your live files, then switch to Delete. The classifier is only as good as its list of prefixes, so reporting a false orphan has to stay the cheap mistake. When orphans grow past a tenth of the storage the installation is billed for, the run adds a warning naming the bytes and what switching the setting would reclaim.

## Static preview hostname

Generated sites are served from a **different origin** than the app (`/preview-static/{projectId}/…` with a short-lived signed token). After Cloudflare is connected, add a DNS record:

| Type  | Name             | Target                   |
| ----- | ---------------- | ------------------------ |
| CNAME | `preview-static` | the Navroop app hostname |

That becomes `preview-static.{zone}` (for example `preview-static.navroop.app`). Point it at the same Coolify app — **and add the same `https://preview-static.{zone}` to the Coolify application's domains** (for a compose app, on the `app` service). A DNS record alone gives Traefik no router for that Host, which answers `503 no available server` for every preview. Locally none of this is needed: a loopback app serves its own previews from the sibling origin `preview-static.localhost:<port>` (`lib/preview/url.ts`), which the proxy's `preview-static.*` host rewrite already routes; CSP still allows framing only by the app origin.

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
