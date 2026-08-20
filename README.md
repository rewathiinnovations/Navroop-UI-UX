# Open Lovable

Chat with AI to build React apps instantly. An example app made by the [Firecrawl](https://firecrawl.dev/?ref=open-lovable-github) team. For a complete cloud solution, check out [Lovable.dev](https://lovable.dev/) ❤️.

<img src="https://media1.giphy.com/media/v1.Y2lkPTc5MGI3NjExbmZtaHFleGRsMTNlaWNydGdianI4NGQ4dHhyZjB0d2VkcjRyeXBucCZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/ZFVLWMa6dVskQX0qu1/giphy.gif" alt="Open Lovable Demo" width="100%"/>

## Setup

1. **Clone & Install**

```bash
git clone https://github.com/firecrawl/open-lovable.git
cd open-lovable
pnpm install
```

**pnpm only — not `npm install`, not `yarn install`.** This repo pins `packageManager: pnpm@11.21.0`
and uses a pnpm workspace; `pnpm-workspace.yaml` carries the security `overrides` the verify gate's
`pnpm audit` step depends on, plus `verifyDepsBeforeRun: false`. Another package manager resolves
modules differently, writes a `package-lock.json` that makes editors switch manager, and can rewrite
that file. The same applies to every script below: `pnpm dev`, never `npm run dev` / `yarn dev` /
`npx next dev`.

2. **Add `.env.local`**

```env
# =================================================================
# REQUIRED
# =================================================================
FIRECRAWL_API_KEY=your_firecrawl_api_key    # https://firecrawl.dev

# =================================================================
# GENERATION — DeepSeek, and nothing else (lib/ai/providers.ts)
# =================================================================
DEEPSEEK_API_KEY=your_deepseek_api_key      # https://platform.deepseek.com

# =================================================================
# IMAGES (optional) — generation and alt text only, never generation of code
# =================================================================
OPENAI_API_KEY=                             # tried first for images
GEMINI_API_KEY=                             # Imagen fallback
```

`.env.example` is the full list and the authority; it splits **required Coolify env** from
**optional, admin-managed** values. Two things this block used to get wrong: `ANTHROPIC_API_KEY`,
`GROQ_API_KEY`, `AI_GATEWAY_API_KEY` and `MORPH_API_KEY` are read by nothing that generates code
(Morph Fast Apply was deleted; the first three survive only in a log line), and `DEEPSEEK_API_KEY` —
the one key planning and building actually need — was absent, so a fully filled-in file still gave
"No AI provider is configured" on the first project.

Most of these are also editable in **Admin → Configuration**, which is the primary control and
overrides the env value. The two image keys are not: they resolve per user through
**Settings → API Keys** (`ApiKey` / `OrgApiKey` rows), then env — a different store from the admin
settings registry.

3. **Run**

```bash
pnpm dev
```

Open the port this checkout is assigned. **Two working trees, two ports:** the
`ai-genration-improvements` checkout serves [http://localhost:3001](http://localhost:3001) and the
`main` worktree under `.worktrees/main` serves [http://localhost:3000](http://localhost:3000). One
dev server per checkout, and only the dedicated dev-server agent starts or restarts it — the
allocation table is in `.cursor/rules/single-dev-server.mdc`.

## Verify

```bash
pnpm run verify        # pre-push gate
pnpm run verify:full   # same gate, every Playwright project (stack and full journeys are .fixme(); locally this also runs the authenticated dashboard journey)
```

Tests use `TEST_DATABASE_URL` (recommended: `openlovable_test` on local Postgres 5433). It must differ from `DATABASE_URL`. Schema drift uses a disposable `openlovable_shadow` (`SHADOW_DATABASE_URL`; never the app or test DB). Create both with `pnpm db:test` after `pnpm db:up`.

To skip hooks: `pnpm run verify:bypass -- "reason"` then `git push --no-verify` (appends `docs/verify-bypasses.log`). Rollback: `pnpm rollback` or **Roll back to previous release** on `/admin/health` (type `roll back`). Database is not auto-reverted. Details: [docs/release.md](docs/release.md).

## Coolify

Create a Coolify **Docker Compose** service from `docker-compose.yml`, set env from `.env.example`, deploy. Details: [docs/coolify.md](docs/coolify.md).

Sentry is configured in **Admin → Integrations** (not `SENTRY_DSN`). The app reads `OBSERVABILITY_CONFIG_PATH` (compose default `/data/config/observability.json` on volume `navroop_data` at `/data`). First boot migrates a leftover `SENTRY_DSN` env value to "Sentry (migrated)" and then ignores it.

### Persistent volume (governing rule)

A container filesystem is replaced on every deploy. A mounted volume survives but is **not** backed up by the database backup and is **not** replicated. Anything written to `/data` must be reconstructible from Postgres or object storage. The volume is a cache and bootstrap shortcut — if it is deleted, the next boot recovers fully with no data loss. Details: [docs/deployment.md](docs/deployment.md).

### Scheduled tasks

Set `CRON_SECRET` on the app service. In Coolify, add scheduled tasks (HTTP POST, `Authorization: Bearer $CRON_SECRET`). Replace `https://YOUR_HOST` with the public origin.

**Check custom domains — every 2 minutes**

```bash
curl -X POST https://YOUR_HOST/api/cron/check-domains \
  -H "Authorization: Bearer $CRON_SECRET"
```

**Reap abandoned generation jobs — every minute**

```bash
curl -X POST https://YOUR_HOST/api/cron/reap-jobs \
  -H "Authorization: Bearer $CRON_SECRET"
```

**Thin old checkpoint snapshots — daily**

```bash
curl -X POST https://YOUR_HOST/api/cron/thin-checkpoints \
  -H "Authorization: Bearer $CRON_SECRET"
```

**Purge soft-deleted projects — daily**

```bash
curl -X POST https://YOUR_HOST/api/cron/purge-projects \
  -H "Authorization: Bearer $CRON_SECRET"
```

**Integration health — daily**

```bash
curl -X POST https://YOUR_HOST/api/cron/check-integrations \
  -H "Authorization: Bearer $CRON_SECRET"
```

**Sweep orphaned publish resources — daily**

```bash
curl -X POST https://YOUR_HOST/api/cron/cleanup-orphans \
  -H "Authorization: Bearer $CRON_SECRET"
```

**Database backup — daily 02:00**

```bash
curl -X POST https://YOUR_HOST/api/cron/backup-db \
  -H "Authorization: Bearer $CRON_SECRET"
```

**Storage verify — weekly**

```bash
curl -X POST https://YOUR_HOST/api/cron/verify-storage \
  -H "Authorization: Bearer $CRON_SECRET"
```

**Error-tracking heartbeat — hourly**

```bash
curl -X POST https://YOUR_HOST/api/cron/observability-heartbeat \
  -H "Authorization: Bearer $CRON_SECRET"
```

**Sentry quota — daily**

```bash
curl -X POST https://YOUR_HOST/api/cron/observability-quota \
  -H "Authorization: Bearer $CRON_SECRET"
```

**System-check digest — daily**

```bash
curl -X POST https://YOUR_HOST/api/cron/system-checks-digest \
  -H "Authorization: Bearer $CRON_SECRET"
```

The digest is the sender of the system-check email and cannot report its own silence — point an
external dead-man's-switch (an uptime monitor expecting a scheduled ping) at this task. Full
schedule table and monitoring notes: [docs/coolify.md](docs/coolify.md).

**Site uptime — every 10 minutes**

```bash
curl -X POST https://YOUR_HOST/api/cron/check-uptime \
  -H "Authorization: Bearer $CRON_SECRET"
```

**Certificate check — daily**

```bash
curl -X POST https://YOUR_HOST/api/cron/check-certs \
  -H "Authorization: Bearer $CRON_SECRET"
```

**Sweep `/data/tmp` — hourly**

```bash
curl -X POST https://YOUR_HOST/api/cron/sweep-tmp \
  -H "Authorization: Bearer $CRON_SECRET"
```

`CHECKPOINT_RETENTION_DAYS` defaults to 7. `PURGE_DELETED_DAYS` defaults to 30. Static previews are served at `/preview-static/{projectId}` (signed token). In production add a DNS record for `preview-static.{your-cloudflare-zone}` pointing at the app.

### Rollback the app

`pnpm rollback` or `/admin/health` → **Roll back to previous release**. This only moves the main Navroop Coolify app to the previous `GIT_SHA` image. Client sites stay up. If the release migrated the schema, restore the database from backup (below) — rollback does not revert Postgres.

### Recover from backup

Quote the object key printed by `scripts/pre-migrate.ts` or `/admin/backups`. Restore into a **scratch** database first, verify row counts, then promote.

1. Provision a scratch Postgres (must not be the live `DATABASE_URL`).
2. Set `RESTORE_DATABASE_URL` to that scratch URL. It must differ from `DATABASE_URL` (the script refuses a same-URL restore).
3. Set the original `ENCRYPTION_KEY` from your password manager (keep the key off the server). Losing it means reconnecting every integration and API key by hand.
4. List dumps: `node ./node_modules/tsx/dist/cli.mjs scripts/restore-db.ts`
5. Restore the named dump: `node ./node_modules/tsx/dist/cli.mjs scripts/restore-db.ts --key backups/db/db-YYYY-MM-DD-xxxxxx.dump`
6. Verify the printed table counts. Spot-check an admin login against the scratch DB if needed.
7. Promote: stop the app, point `DATABASE_URL` at the verified restore (or swap the volume), then start. Point object storage at the same ElasticLake app bucket (`ELK_*`).
8. Redeploy.

Production start always runs pre-migrate then `prisma migrate deploy` then the app. Production refuses a local-filesystem backup driver. `prisma db push` and `prisma migrate reset` are refused outside development.

## License

MIT
