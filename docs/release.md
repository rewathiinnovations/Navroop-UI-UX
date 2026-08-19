# Release and verify

Failures should be caught before users see them. Production should be revertible in minutes. This is not a zero-bug promise.

## Local test database

Never point Vitest at the development database.

|              | URL                                                                                            |
| ------------ | ---------------------------------------------------------------------------------------------- |
| App          | `DATABASE_URL` — typically `…/openlovable` on host **5433**                                    |
| Tests        | `TEST_DATABASE_URL` — typically `…/openlovable_test` on the same Postgres                      |
| Schema drift | `SHADOW_DATABASE_URL` — optional; default `…/openlovable_shadow` on the same host. Disposable. |

Same host/port is fine. The **database name must differ**. Startup asserts `TEST_DATABASE_URL !== DATABASE_URL` and exits if not.

```bash
pnpm db:up
pnpm db:test          # CREATEs openlovable_test + openlovable_shadow, then migrates the test DB
pnpm db:test:migrate  # migrations only, when the schema moved after setup
```

`pnpm db:test` now chains `scripts/migrate-test-db.ts` after `scripts/ensure-test-db.ts`. It used to create the databases and stop, which left `openlovable_test` behind the committed schema — raw SQL in the integration suites was then grammar-checked against tables that did not exist and the suites passed while proving nothing. `db:test:migrate` runs `prisma migrate deploy` with `DATABASE_URL` set to `TEST_DATABASE_URL` and **refuses to run unless the target database is named exactly `openlovable_test`**, so it can never migrate the application database. It never runs `prisma generate`.

Add `TEST_DATABASE_URL` to `.env.local` (see `.env.example`). Do not commit it.

## Commands

| Script                               | What                                                                                                                                                                                                             |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm run verify` / `npm run verify` | Pre-push gate (stop on first fatal failure)                                                                                                                                                                      |
| `pnpm run verify:full`               | Everything, with one `playwright test` over **every** project replacing the two per-project Playwright steps                                                                                                     |
| `pnpm run verify:bypass -- "reason"` | Log a hook bypass, then `git push --no-verify`                                                                                                                                                                   |
| `pnpm db:test`                       | Create `openlovable_test` / `openlovable_shadow`, then migrate the test DB                                                                                                                                       |
| `pnpm db:test:migrate`               | `prisma migrate deploy` on `TEST_DATABASE_URL` (guarded to `openlovable_test`)                                                                                                                                   |
| `pnpm test`                          | Vitest unit + integration                                                                                                                                                                                        |
| `pnpm test:e2e:critical`             | Playwright project `critical` (journey 1, plus the scaffolded journey 4). The signed-in journeys live in the `authenticated` project: `node ./node_modules/@playwright/test/cli.js test --project=authenticated` |
| `pnpm smoke`                         | Live smoke (`SMOKE_URL`, optional `SMOKE_CLIENT_URL`)                                                                                                                                                            |
| `pnpm rollback`                      | Coolify rollback of the **main Navroop app** only                                                                                                                                                                |

`verify` order (fatal unless noted):

1. `tsc --noEmit` (excludes generated `.next` / `next-env.d.ts` route types; `types/next-env.d.ts` keeps `next` refs)
2. `eslint . --max-warnings 0`
3. Public API allowlist (`scripts/check-public-routes.ts`)
4. `prisma validate`
5. `prisma migrate diff --from-migrations` vs committed schema (`--shadow-database-url`, dedicated `openlovable_shadow` — never the app or test DB)
6. Destructive-migration detector (`ALLOW_DESTRUCTIVE_MIGRATION=true` required for DROP TABLE/COLUMN / ALTER TYPE)
7. `vitest run --coverage`
8. `next build`
9. `playwright test --project=critical`
10. `playwright test --project=authenticated` — the `setup` project seeds the E2E account and signs in first, so this is the step that proves a real signed-in user can reach the dashboard and create a project
11. depcheck and knip — **report only** (non-fatal, but the tick is now truthful: knip's `--no-exit-code` was removed)
12. `pnpm audit --audit-level=high` — high severity blocks

Every step runs a vendored binary (`node ./node_modules/…`) except `pnpm audit`, which resolves the lockfile itself and has no binary equivalent. That is not cosmetic: `verify` runs from `.husky/pre-push`, and `pnpm run` / `pnpm exec` first run a dependency-status check that can purge `node_modules` mid-push on a TTY. The hook avoided the shim; until 2026-08-19 every step it ran put it straight back.

High/critical findings are forced via `pnpm.overrides` in `package.json` (same-major patches; `deepmerge-ts` to `^8` without a Prisma major). Isolated copies under eslint-config-next inflate path counts; unique packages are the real list. Overrides do not apply until `pnpm install` after `:3000` is stopped. Do not drop this step.

On failure the summary prints the exact command to reproduce.

### A step that runs nothing is not a pass

`playwright test` exits **0** for a project whose tests are all `.fixme()` or all `test.skip(cond)` — verified: `playwright test --project=critical --grep "publish is a job"` prints `1 skipped` and returns 0. (A filter that collects _nothing_ is already fatal by itself: `Error: No tests found`, exit 1.) Both Playwright steps therefore carry `assertExecuted: requirePassingTests` (`lib/verify/orchestrator.ts`): a zero exit code with no `N passed` in the reporter output turns the step red with `exited 0 but reported no passing test`, and — being fatal — stops the run. Before that, the summary printed a ✓ beside a fatal gate step that had executed no assertion at all.

### The Playwright server

Whether a server is booted is decided by probing the base URL, not by `CI`. `playwright.config.ts` always declares the `webServer` (`node ./node_modules/next/dist/bin/next start`, env via `lib/verify/playwright-env.ts` with a test-only `ENCRYPTION_KEY` fallback) with `reuseExistingServer: true`:

- a developer with a dev server on `:3000` gets that server reused;
- a CI runner has nothing listening, so `next start` is spawned against the `next build` from step 8.

It used to be `CI && !PLAYWRIGHT_NO_SERVER` with `reuseExistingServer: false`. Playwright probes the URL before spawning and throws `http://localhost:3000 is already used`, so **any** shell that exported `CI` (agent shells do) could not finish `verify` at all: step 9 died for an environmental reason and, because the orchestrator returns on the first fatal failure, depcheck, knip and the fatal dependency audit never ran.

`PLAYWRIGHT_NO_SERVER=1` (runtime) drops the `webServer` entirely, for when you want an unreachable base URL to go red rather than have a server appear under the run.

### ESLint warnings

`verify` uses `--max-warnings 0`. `react-hooks/exhaustive-deps`, `react-hooks/set-state-in-effect`, and `prefer-const` fire across the whole repo on fetch-on-mount and similar patterns. They are **off** so the gate can pass without a multi-thousand-line cleanup. That is documented, not silent. New code should still avoid those issues. `.cursor/**` is ignored (vendored skill scripts).

### Coverage floors

The floors in `vitest.config.ts` are a **ratchet set just under what is actually measured**, not an aspiration. Global floors across `lib/**`: **41% statements, 68% branches, 58% functions, 41% lines**. Raise the floors when a run reports more; never lower them so a change fits.

Measured 2026-08-18 across three runs an hour apart — 42.70 / 69.64 / 59.08 / 42.70, then 43.51 / 69.07 / 59.80 / 43.51, then 43.61 / 69.31 / 60.00 / 43.61 (statements / branches / functions / lines). Statements and lines had climbed from 36.88, so the old floors of 36 carried 6+ points of slack and no longer gated anything.

**Functions is the volatile column and needs the wider margin.** It read 57.13, 57.32, 59.08, 59.80 and 60.00 inside one hour, purely because modules were imported and the publish suite landed — v8 enumerates every function in a module the moment something imports it, so the number moves without any test getting better or worse. A floor one point under the high would go red for reasons unrelated to test quality, and a gate that flaps gets switched off, so 58 sits under the whole observed range. It still bites: set to 60 against a measured 59.80, the run fails with `ERROR: Coverage for functions (59.8%) does not meet global threshold (60%)`.

Every reading was taken with unrelated test files failing, which can only understate coverage, so the floors are a lower bound on the truth. Note that a failing run normally prints **no** coverage table at all (`coverage.reportOnFailure` defaults to false) — pass `--coverage.reportOnFailure` to measure while something else is red.

Per-tree, as measured (statements / branches / functions) — these trees have **no** 85% floor and are nowhere near one:

| Tree                | Stmts | Branch | Funcs |
| ------------------- | ----- | ------ | ----- |
| `lib/verify`        | 100   | 96     | 100   |
| `lib/security`      | 80.18 | 71.84  | 95    |
| `lib/deploy`        | 74.11 | 94.28  | 87.5  |
| `lib/jobs`          | 61.41 | 71.38  | 71.59 |
| `lib/plans`         | 45.98 | 73.33  | 78.37 |
| `lib/publish`       | 44.1  | 79.88  | 34.37 |
| `lib/` (root files) | 22.62 | 83.83  | 47.94 |

Stricter per-module floors are enforced on the pipeline modules (`lib/verify`, `lib/publish`, `lib/generation/parse-files.ts`, `lib/secret-scan.ts`, `lib/deploy`); files matching those globs still count towards the global numbers. Untested bulk: `lib/generation/generation-runtime.ts` (excluded — huge stream parser), Coolify/import/sandbox drivers, and UI-adjacent lib.

### The test suite may not write the repository

A test once stamped a fixture Sentry project id over the dev server's live `.data/config/observability.json`, and `/api/health` then reported the file as disagreeing with the CONNECTED Integration row — a convincing incident manufactured entirely by the suite. `tests/setup/data-dir-guard.ts` closes that route by repointing `DATA_DIR` at a temp directory, but local object storage still falls back to `public/uploads` and backups to `tmp/backups`.

`tests/setup/repo-write-guard.global.ts` runs as `globalSetup`: it walks the tree before and after the whole suite (about 2,500 files, roughly 5 seconds a pass) and fails the run if anything changed that the suite does not own. **`git status` is useless for this** — all four paths are gitignored, which is exactly why the pollution went unnoticed. Skipped directories: `node_modules`, `.git`, `.next`, `coverage`, `.turbo`, `generated`, `playwright-report`, `test-results`, `dist`, `build`, `out`, `.vercel`.

Three rules, because several agents may be editing the checkout while the suite runs:

| What changed        | Where                                                                                                      | Verdict |
| ------------------- | ---------------------------------------------------------------------------------------------------------- | ------- |
| Modified or removed | state paths only (`.data`, `public/uploads`, `tmp/backups`, and `DATA_DIR` when it points inside the repo) | fail    |
| Added               | state paths                                                                                                | fail    |
| Added               | anywhere else, and git ignores it                                                                          | fail    |
| Added               | anywhere else, and git can see it                                                                          | ignored |
| Modified            | anywhere else                                                                                              | ignored |

The last two rows are what keeps it usable in a live checkout. A source edit changes a file that **already exists**, so a repo-wide content comparison would fail on somebody else's save; and a new _visible_ file is somebody adding source, which `git status` already shows — the guard's first real run failed on precisely that, another agent creating `tests/integration/publish-compensate-resume.test.ts` mid-suite. Git is used only to **classify** a candidate path, never to detect the change; detection is the mtime and size comparison, because git cannot see the paths that matter. When git cannot answer (no repository, no binary) the guard says so on stderr and checks the state paths only, rather than silently narrowing.

`globalSetup` runs in its own process, so it cannot see the temp `DATA_DIR` the worker processes get from `data-dir-guard.ts`, and does not need to — the point is to notice writes that land in the repository.

The guard is itself tested (`tests/setup/repo-write-guard.test.ts`, reached because `tests/setup/**/*.test.ts` is in `include`): a guard nobody exercises is indistinguishable from one that cannot fail. Proven end to end both ways — a throwaway suite writing `tmp/backups/` fails the run with every test passing, and a throwaway suite creating a normal source file does not.

If a path is genuinely the harness's own output, add it to `DEFAULT_ALLOWLIST` in `tests/setup/repo-write-guard.ts` **with the reason**. A test being observed to leave something behind is the finding, not grounds for an exception.

### EXPLAIN / seq scans

The EXPLAIN check is a **soft skip** on a small test DB. It is not meaningful until tables are large. Re-run by hand against a copy of production data if you need index proof.

### Previous-schema migrate

A full previous-schema fixture is not checked in. Subset: empty DB + `prisma migrate deploy` on `TEST_DATABASE_URL`, plus the destructive detector on committed SQL. For a real upgrade, restore a backup of the previous production schema into a scratch database and migrate there first.

## Git hooks

Husky + lint-staged:

- **pre-commit** (<10s): ESLint + Prettier on staged files; in-repo secret scanner (PEM / AWS / GitHub PAT). Install `gitleaks` for a second pass on full-tree scans (`node ./node_modules/tsx/dist/cli.mjs scripts/secret-scan.ts`).
- **pre-push**: `verify` (`node ./node_modules/tsx/dist/cli.mjs scripts/verify.ts`)

### Hooks call binaries directly, never `pnpm exec` / `pnpm run`

Both hooks `cd "$(git rev-parse --show-toplevel)"` and then run `node ./node_modules/<tool>/…`, and so does every step `verify` itself runs (`lib/verify/orchestrator.ts`) — the hook rule was worthless while the twelve steps under it were all `pnpm exec`. They must never go through `pnpm exec` or `pnpm run`: pnpm runs a dependency-status check first, decides `node_modules` is stale, and tries to **purge it** before running anything. An agent shell survives that only because it has no TTY — a real `git commit` has one, so the purge would happen mid-commit and take the nested `minimatch@10` under `test-exclude/node_modules` with it (`.cursor/lessons-learned.md`). Never set `CI=true` or `confirmModulesPurge=false` to get past the abort; both arm the deletion. Each hook checks the binary exists first and exits 1 with "run pnpm install" if it does not. `.husky/.gitattributes` pins `eol=lf` so the hooks stay POSIX-runnable on Windows. The one deliberate exception is `pnpm audit`, which is not a script runner and has no vendored binary.

### Secret scan exit codes

`scripts/secret-scan.ts` fails **closed**: a scan that cannot enumerate its input or cannot read a file it was asked to check never reports a pass.

| Exit | Meaning                                                                                                                                                                    |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Scanned clean, or genuinely nothing staged (the message says which, and never claims "passed" with 0 files scanned)                                                        |
| 1    | A credential pattern matched — a real finding to fix                                                                                                                       |
| 2    | The scan could not complete (git could not list the staged files, a staged blob or file was unreadable, or an installed `gitleaks` crashed) — a broken gate, not a finding |

Diagnostics go to stderr because that is what a git hook shows. In `--staged` mode the content comes from the **index** (`git show :path`) for any path whose worktree copy differs, so a partially staged file is scanned as it will be committed. A missing `gitleaks` (`ENOENT`) is still a skip; any other `gitleaks` failure is exit 2.

### `--no-verify` escape hatch

`git push --no-verify` skips hooks. That is invisible unless you log it:

```bash
pnpm run verify:bypass -- "hotfix: describe why"
# commit docs/verify-bypasses.log with the change
git push --no-verify
```

Bypasses are appended to the committed file `docs/verify-bypasses.log`.

## CI

`.github/workflows/verify.yml` — push and pull request, one `verify` job. Postgres service for **both** databases: the container creates `openlovable` (the application database) and `pnpm run db:test` creates `openlovable_test` / `openlovable_shadow` beside it, then `prisma migrate deploy` migrates the application one. Caches pnpm and Playwright browsers. Uploads traces/screenshots/videos on failure.

The six-way `stacks` matrix (`NEXTJS` … `SVELTE`) was **deleted on 2026-08-18**: no test in `e2e/journeys-stacks.spec.ts` ever took the `page` fixture, so six jobs installed Chromium to report eighteen skips. **There is no six-stack E2E in CI any more.** The specs stay as the intent; reinstate the matrix when they drive a browser.

**The authenticated Playwright journey runs everywhere, as of 2026-08-19.** It was previously local-only in theory and nowhere in practice: `playwright.config.ts` dropped the `setup` and `authenticated` projects whenever `CI` was set (neither workflow set the `PLAYWRIGHT_AUTH_JOURNEY=1` that would have kept them), and locally `verify` filtered to `--project=critical`, which excludes them. So sign-in, the dashboard and project creation — the only e2e tests that exercise a signed-in user — were asserted by no automated run on any machine or workflow. The stated blocker was real (the journey seeds an account through Prisma into the application database, which CI did not create), so CI now creates it; `PLAYWRIGHT_AUTH_JOURNEY` is gone, and `playwright test --project=authenticated` is a fatal `verify` step.

`.github/workflows/nightly.yml` — `verify:full` plus higher fast-check iterations (`FC_NUM_RUNS`). Same two databases as `verify.yml`, because `verify:full` runs every Playwright project including the authenticated ones.

### Branch protection (cannot enable via API without admin)

On GitHub: Settings → Branches → Branch protection for `main`:

- Require a pull request
- Require status checks to pass: **Verify / verify**
- Do not allow bypassing without logging (`docs/verify-bypasses.log`)

## Coolify deploy safety (main Navroop app only)

Client site deploys are separate Coolify applications. Smoke tests must keep asserting a known live client URL (`SMOKE_CLIENT_URL`). Rolling back Navroop must not touch those apps.

### Image and boot

- Multi-stage Dockerfile, Next **standalone**, non-root `nextjs`, PostgreSQL client for dumps, pinned Node 20.
- Build-arg / env `GIT_SHA` tags the image. Keep the last ten shas in `AppSetting` `deploy.history`.
- `HEALTHCHECK` hits `GET /api/health`.
- Boot (fail closed, names the missing var): `ENCRYPTION_KEY` ≥ 32 bytes, `DATABASE_URL`, `APP_URL` (or `NEXTAUTH_URL` / `AUTH_URL`) → pre-migrate → `prisma migrate deploy` → job reconcile → `node server.js`.
- SIGTERM is forwarded to Next. Give Coolify **≥ 15 seconds** grace before SIGKILL so owned jobs are marked `deploying`.
- Use Coolify **rolling deploy** + the compose healthcheck. Do not cut over until `/api/health` is 200.

### Backward-compatible migrations

1. Expand (add columns/tables, nullable or with defaults).
2. Deploy the app that writes both old and new shapes if needed.
3. Backfill.
4. Contract (DROP) only with `ALLOW_DESTRUCTIVE_MIGRATION=true` after a backup. The detector blocks DROP TABLE / DROP COLUMN / ALTER TYPE without that flag.

Review checklist: backup object key quoted; no DROP without flag; `ENCRYPTION_KEY` unchanged; client sites still respond; `/admin/health` shows the new sha.

### Rollback

```bash
pnpm exec tsx scripts/rollback.ts
# or from /admin/health → Roll back to previous release (type "roll back")
```

This redeploys the previous **git sha** image for the main app (`COOLIFY_APP_UUID`). **The database is not auto-reverted.** If the release included a migration, restore from backup (`scripts/restore-db.ts --key …` into `RESTORE_DATABASE_URL`).

### Staging

Create a **second Coolify application** (not a second client site):

- Own Postgres
- Own `SandboxProviderConfig` (small budget, free_first)
- Own `APP_URL` / zone labels
- Same image pipeline, smaller `Plan` limits

Do not share the production `ENCRYPTION_KEY` with a long-lived staging dump that leaves the building.

### Smoke

```bash
SMOKE_URL=https://navroop.example \
SMOKE_CLIENT_URL=https://known-client.example \
SMOKE_EMAIL=… SMOKE_PASSWORD=… \
pnpm smoke
```

Checks: `/api/health` (Postgres and object storage reachable — the failing dependency is named, not just the status code — plus the data-directory state, observability.json vs Integration when Sentry is connected, free space above the warning threshold), the unauthenticated route probe, optional sign-in + dashboard, **known live client site still responds**. A silent lost volume (id changed but not reported) fails smoke. Trivial generation + checkpoint + delete is a follow-up when a dedicated smoke account exists.

There is deliberately **no separate "integration health" check**. It used to fetch `/api/health` a second time, so it could not fail unless the health check had already failed — a green line that verified nothing. Integration status (GitHub / Cloudflare / Coolify / Sentry) lives behind ADMIN endpoints (`GET /api/admin/integrations`, `POST /api/admin/integrations/check`) and is not reachable unauthenticated, so there was nothing independent for it to assert. Its only real signal — which dependency is down — now comes from the health body on the 503 path.

Exit 1 means the deployment is broken. The persistent-volume assertions are **warnings** when the target is local (`localhost`, `127.0.0.1`, `*.localhost`, …), because a dev box has no `/data` mount and failing there would bury the real findings; they are hard failures against any other host. `SMOKE_EXPECT_DATA_VOLUME=on` requires the volume anywhere (probing a container through a port forward), `=off` never requires it. The reason is always printed either way.

The volume line reads `dataDir.state` from the health body rather than inferring from `writable`, so the three answers stay distinct — `not_checked` is unknown, not broken, and is never described as a missing volume:

```text
ok  persistent volume /data
warn persistent volume /data — unverified: the boot probe has not run in the process that served this request, so writability is unknown. This is not evidence of a missing volume, but a deployment that should have probed at boot has not. (warning only: …)
warn persistent volume /data — unwritable: <the reason from the health body, e.g. the uid that cannot write> (warning only: …)
```

For `unwritable` the smoke line quotes `dataDir.message`, which carries the actual cause. For `not_checked` it does not: that message ends "This is not a failure", which is right on `/admin/health` and contradictory inside a release gate, so the reason is stated locally instead.

Severity is unchanged by reading `state`: `unwritable` and `not_checked` keep the local-warn / remote-fail split they had under the boolean, so no run changes outcome. A deployment older than `dataDir.state` falls back to the `writable` boolean. `state: 'ok'` with no volume id fails outright — `ensureDataDir` always stamps one, so its absence means the health shape changed.

The final line accounts for warnings **and skips**: `smoke passed with 1 warning, 2 checks skipped`. A run with `SMOKE_EMAIL` / `SMOKE_PASSWORD` / `SMOKE_CLIENT_URL` unset never touches sign-in, the dashboard, or the live client site, so a bare "smoke passed" would claim coverage it did not have. An inconclusive observability comparison (`matchesIntegration: null` — no Integration row, or the read threw) is a counted skip rather than a silent pass.

The route probe prints all three reconciling counts, so a walker that quietly stopped finding routes cannot look like a pass:

```text
ok  unauthenticated route probe (199 endpoints discovered = 29 allowlisted in PUBLIC_API_ROUTES + 170 gated, all 170 returned 401)
```

Two known limits of the output, so nobody reads more into a green run than is there. **The cron bearer check probes `/api/cron/reap-jobs` only** — it is one route standing in for the allowlisted `/api/cron/*` family, so a sibling cron that forgot `authorizeCron` would not be caught. Widening it is not free: a broken gate is exactly what would then let a smoke run start a real backup or reap. **An origin that refuses the connection is fatal, not a per-check failure** — `[smoke] <base> did not answer GET /api/health — the connection failed` and exit 1, because nothing else can be probed. Individual fetches later in the run are not wrapped, so a connection dropped mid-probe still surfaces as a Node stack rather than a `[smoke]` line.

### Persistent volume recovery drill

The `/data` volume is a cache and bootstrap shortcut. It is not in the database backup.

1. Stop the app container.
2. Delete the Coolify / compose volume mounted at `/data`.
3. Start the app again.

Expect: `config` / `cache` / `tmp` recreated, `observability.json` rebuilt from the Sentry Integration, a **new** volume id (Admin → Health reports the change), Sentry reporting after the next restart, and **no user data lost** (projects, checkpoints, uploads, secrets stay in Postgres or object storage). See [deployment.md](deployment.md).

## Playwright honesty

The gate runs **projects**, so read this per project; `node ./node_modules/@playwright/test/cli.js test --list` is the authoritative inventory and takes a second. `critical` and `authenticated` each have their own `verify` step, so either one going all-skip turns that step red (see "A step that runs nothing is not a pass"). The `verify:full` projects share the single `playwright-all` step, so one of them going all-skip is **not** caught individually — `--list` is what tells you.

| Project                          | In the gate                                                  | What it proves                                                                                                                                                                                                                                     |
| -------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setup`                          | Yes, as a dependency of `authenticated`                      | Seeds the E2E account through Prisma and signs it in through the real credentials form, then saves the session. Not a journey; a prerequisite that fails loudly                                                                                    |
| `authenticated`                  | **Yes — fatal `verify` step 10, and in CI since 2026-08-19** | The signed-in journeys: dashboard render (journey 0), create-project-from-a-prompt (2), the plan/build toggle (3), and the workflow journeys that need a session. Paid routes are stubbed; nothing here calls a provider                           |
| `critical`                       | **Yes — fatal `verify` step 9**                              | Signed-out sign-in screen, English copy, no serious axe findings (journey 1). An unreachable base URL is red unless `PLAYWRIGHT_ALLOW_NO_SERVER=1`, and the config now reuses or boots a server, so unreachable means something is genuinely wrong |
| `NEXTJS` … `SVELTE` (six stacks) | `verify:full` only                                           | Per-stack create/plan-build. Skipped with a stated prerequisite: the stack projects have no `storageState`, and there is no credential-free per-stack journey. No CI matrix any more (see CI above)                                                |
| `full`                           | `verify:full` only                                           | Signed-out surfaces reachable without a session (domains, recovery copy, invite gating, templates)                                                                                                                                                 |

## i18n

There is no translation catalog. Tests assert user-facing `app/` + `components/` strings contain no Hindi and no “klarco”.
