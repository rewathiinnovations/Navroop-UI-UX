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

Four more variables steer that bootstrap, and none of them had appeared in any document or in
`.env.example`. All are **runtime**, for the setup scripts only — never set them in Coolify:

| Name                      | Read by                     | Default                                          | What it does                                                                                                                           |
| ------------------------- | --------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `TEST_DATABASE_ADMIN_URL` | `scripts/ensure-test-db.ts` | `TEST_DATABASE_URL` with the `postgres` database | The connection the `CREATE DATABASE` statements run on, when the test role cannot create databases itself                              |
| `TEST_DATABASE_NAME`      | `scripts/ensure-test-db.ts` | `openlovable_test`                               | Renames the test database. `db:test:migrate` still refuses any name but `openlovable_test`, so changing this disables the migrate step |
| `SHADOW_DATABASE_NAME`    | `scripts/ensure-test-db.ts` | `openlovable_shadow`                             | Renames the disposable schema-drift database                                                                                           |
| `POSTGRES_CONTAINER`      | `lib/verify/ensure-db.ts`   | `open-lovable-db`                                | Which Docker container `verify` starts/waits on when Postgres is not already up                                                        |

## Commands

| Script                               | What                                                                                                                                                                                                             |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm run verify`                    | Pre-push gate (stop on first fatal failure). **pnpm only** — never `npm run verify`; npm resolves `node_modules` differently in a pnpm workspace and writes `package-lock.json`                                  |
| `pnpm run verify:full`               | Everything, with one `playwright test` over **every** project replacing the two per-project Playwright steps                                                                                                     |
| `pnpm run verify:bypass -- "reason"` | Log a hook bypass, then `git push --no-verify`                                                                                                                                                                   |
| `pnpm db:test`                       | Create `openlovable_test` / `openlovable_shadow`, then migrate the test DB                                                                                                                                       |
| `pnpm db:test:migrate`               | `prisma migrate deploy` on `TEST_DATABASE_URL` (guarded to `openlovable_test`)                                                                                                                                   |
| `pnpm test`                          | Vitest unit + integration                                                                                                                                                                                        |
| `pnpm test:e2e:critical`             | Playwright project `critical` (journey 1, plus the scaffolded journey 4). The signed-in journeys live in the `authenticated` project: `node ./node_modules/@playwright/test/cli.js test --project=authenticated` |
| `pnpm smoke`                         | Live smoke (`SMOKE_URL`, optional `SMOKE_CLIENT_URL`)                                                                                                                                                            |
| `pnpm rollback`                      | Coolify rollback of the **main Navroop app** only                                                                                                                                                                |

`verify` order — the **only** enumeration of this gate in the repository. `AGENTS.md`, `CLAUDE.md`
and `.cursor/README.md` point here instead of keeping their own copies, because the copies they did
keep each dropped a fatal step. Each entry names its `VERIFY_STEPS` id from
`lib/verify/orchestrator.ts`; `tests/unit/docs-accuracy.test.ts` fails when this list and that array
disagree in length or in ids. Fatal unless the row says otherwise:

1. `tsc` — `tsc --noEmit` (excludes generated `.next` / `next-env.d.ts` route types; `types/next-env.d.ts` keeps `next` refs)
2. `eslint` — `eslint . --max-warnings 0`
3. `secret-scan` — `scripts/secret-scan.ts --tracked`; the in-repo PEM / AWS / provider-key rules over every file git has under version control. **This is the only re-scan a bypassed commit ever gets** (F-785): `pre-commit` scans the _index_, and `pnpm run verify:bypass` is a documented escape hatch, so `--no-verify` skipped that scan and nothing looked again. Exit **2** means the scan could not run and is red by exit code; a zero exit that reports no scanned file is red too (`requireSecretsScanned`). `--tracked` rather than the default whole-tree mode because the tree mode reads ignored files on purpose — a developer's own `.env.local` would hold the gate permanently red, and its _staged_ copy is still blocked by the hook
4. `public-routes` — public API allowlist (`scripts/check-public-routes.ts`)
5. `prisma-validate` — `prisma validate`
6. `schema-drift` — `prisma migrate diff --from-migrations` vs committed schema (`--shadow-database-url`, dedicated `openlovable_shadow` — never the app or test DB)
7. `destructive` — destructive-migration detector (`ALLOW_DESTRUCTIVE_MIGRATION=true` required for DROP TABLE/COLUMN / ALTER TYPE)
8. `vitest` — `vitest run --coverage`
9. `next-build` — `next build`
10. `playwright-critical` — `playwright test --project=critical`
11. `playwright-authenticated` — `playwright test --project=authenticated`; the `setup` project seeds the E2E account and signs in first as a declared dependency, so this is the step that proves a real signed-in user can reach the dashboard and create a project. Separate from `critical` on purpose: merged into one command, a silently empty `authenticated` project would hide behind `critical`'s passing count
12. `depcheck` — **fatal** since 2026-08-21 (F-645). It was report-only with no config, printing the same ten entries on every run and blocking nothing. `.depcheckrc.yml` declares those ten — split into "used, but not via an import depcheck can see" (`autoprefixer`, `postcss-import`, `postcss-nesting`, `depcheck`, `knip`, `@vitest/coverage-v8`, `prettier`) and "unused, pending removal with a lockfile regeneration" (`@eslint/eslintrc`, `msw`, `semver`) — so a clean tree exits 0 and a _newly_ unused dependency is a red gate
13. `knip` — **report only**, non-fatal, but the tick is now truthful (`--no-exit-code` was removed)
14. `audit` — `pnpm audit --audit-level=high`; high severity blocks

**No repo-wide `prettier --check` step, deliberately** (the other half of F-785, scoped out 2026-08-21). `.prettierrc.json` exists and `lint-staged` formats staged files, but the tree it has been applied to is not the whole repository: `prettier . --check` reports **809 files** with style differences as of `345a0a8`. Adding the step means a reformat of 809 files in one commit — a diff that conflicts with every branch in flight and buries real changes in whitespace for a year of `git blame`. The gate would also be red for the entire window between adding the step and landing that reformat. The honest sequence is: reformat first, in its own commit, on a quiet tree; add the step second. Neither belongs in a finding whose subject is the missing secret scan.

Every step runs a vendored binary (`node ./node_modules/…`) except `pnpm audit`, which resolves the lockfile itself and has no binary equivalent. That is not cosmetic: `verify` runs from `.husky/pre-push`, and `pnpm run` / `pnpm exec` first run a dependency-status check that can purge `node_modules` mid-push on a TTY. The hook avoided the shim; until 2026-08-19 every step it ran put it straight back.

High/critical findings are forced via the top-level **`overrides` block in `pnpm-workspace.yaml`** (21 entries, same-major patches; `deepmerge-ts` to `^8` without a Prisma major). **Not `pnpm.overrides` in `package.json`** — `package.json` has no `pnpm` key at all, and pnpm 11 reads overrides from the workspace file, so a fixer patching a new advisory in `package.json` changes nothing, watches the audit stay red, and reaches for dropping the step. The same file also holds `allowBuilds` and `minimumReleaseAgeExclude`, so it is one place to look. Isolated copies under eslint-config-next inflate path counts; unique packages are the real list. Overrides do not apply until `pnpm install` runs with this checkout's own dev server stopped (see the port table in `.cursor/rules/single-dev-server.mdc` — not necessarily `:3000`). Do not drop this step.

On failure the summary prints the exact command to reproduce.

### A step that runs nothing is not a pass

`playwright test` exits **0** for a project whose tests are all `.fixme()` or all `test.skip(cond)` — verified: `playwright test --project=critical --grep "publish is a job"` prints `1 skipped` and returns 0. (A filter that collects _nothing_ is already fatal by itself: `Error: No tests found`, exit 1.) Both Playwright steps therefore carry `assertExecuted: requirePassingTests` (`lib/verify/orchestrator.ts`): a zero exit code with no `N passed` in the reporter output turns the step red with `exited 0 but reported no passing test`, and — being fatal — stops the run. Before that, the summary printed a ✓ beside a fatal gate step that had executed no assertion at all.

### The Playwright server

Which server the suite validates is decided by `resolvePlaywrightServer` (`lib/verify/playwright-env.ts`), not by probing "whatever answers on :3000". Two worktrees run two dev servers on the reference machine, and a probe cannot tell which checkout it reached — reuse-by-probe let both fatal Playwright steps validate a different branch's code. `playwright.config.ts` always declares the `webServer` (`node ./node_modules/next/dist/bin/next dev`, env via `playwrightWebServerEnv` with a test-only `ENCRYPTION_KEY` fallback):

- `PLAYWRIGHT_BASE_URL` set (runtime) → the suite targets it with `reuseExistingServer: true`; the operator has vouched that whatever answers there is this checkout.
- otherwise → `reuseExistingServer: false` and the suite boots its own `next dev` from this checkout: in CI on the `APP_URL` port (nothing listens there, so behaviour is unchanged), locally on `PLAYWRIGHT_PORT` (runtime) or `APP_URL`'s port + 100 so it cannot collide with either worktree's live dev server. The child binds the derived port via `PORT` and its `APP_URL` / `NEXT_PUBLIC_APP_URL` / `NEXTAUTH_URL` / `AUTH_URL` are pinned to the served origin.

A shell that exports `CI` next to a live server on the APP_URL port now goes red with `is already used` instead of silently validating that server — set `PLAYWRIGHT_BASE_URL` to reuse it deliberately, or `PLAYWRIGHT_PORT` to spawn elsewhere.

`PLAYWRIGHT_NO_SERVER=1` (runtime) drops the `webServer` entirely, for when you want an unreachable base URL to go red rather than have a server appear under the run.

### ESLint warnings

`verify` uses `--max-warnings 0`. `react-hooks/exhaustive-deps`, `react-hooks/set-state-in-effect`, and `prefer-const` fire across the whole repo on fetch-on-mount and similar patterns. They are **off** so the gate can pass without a multi-thousand-line cleanup. That is documented, not silent. New code should still avoid those issues. `.cursor/**` is ignored (vendored skill scripts).

### Coverage floors

The floors are a **ratchet set just under what is actually measured**, not an aspiration.

**`vitest.config.ts` (`thresholds`) is the only place the numbers live.** Do not restate them here or
in `AGENTS.md` or `.cursor/README.md`. This section used to, and so did those two, and all three
disagreed with the config and with each other: this file said 41/68/58/41 and backed it with a
measurement table taken before the sandbox subsystem was deleted, while the other two said
49/70/65/49 against a config that had been recalibrated below both. A contributor following the
instruction all three gave — "raise, never lower" — was raising a number the config did not hold,
and the run failed for a reason none of the documents could explain. A ratchet needs exactly one
recorded value. `tests/unit/docs-accuracy.test.ts` now fails any document that states a floor the
config does not set.

What to know without a number in front of you:

- Each threshold in `vitest.config.ts` carries its measurement date and the reading it was derived from in a comment directly above it. Read those before touching a floor; the current global ones were recalibrated on 2026-08-19, when deleting ~20k lines of heavily tested sandbox code lowered the ratio without a single test being lost.
- Raise a floor when a run reports more. Never lower one so a change fits.
- **The functions column is the volatile one and keeps the widest margin.** v8 enumerates every function in a module the moment something imports it, so the figure moves several points inside an hour purely because a suite landed elsewhere — with no test getting better or worse. A floor one point under the high goes red for reasons unrelated to test quality, and a gate that flaps gets switched off.
- The per-glob floors (`lib/verify/**`, `lib/publish/**`, `lib/generation/parse-files.ts`, `lib/secret-scan.ts`, `lib/deploy/release.ts`, `lib/deploy/rollback.ts`) are stricter than the global ones and still count towards them. They carry their own dated comments for the same reason.
- A failing run normally prints **no** coverage table at all (`coverage.reportOnFailure` defaults to false) — pass `--coverage.reportOnFailure` to measure while something else is red. Readings taken that way can only understate coverage, so they are a lower bound.
- Untested bulk, for context on why the globals sit where they do: `lib/generation/generation-runtime.ts` (excluded — huge stream parser), the Coolify and import drivers, and UI-adjacent `lib/`.

### The test suite may not write the repository

A test once stamped a fixture Sentry project id over the dev server's live `.data/config/observability.json`, and `/api/health` then reported the file as disagreeing with the CONNECTED Integration row — a convincing incident manufactured entirely by the suite. `tests/setup/data-dir-guard.ts` closes that route by repointing `DATA_DIR` at a temp directory, and `tests/setup/storage-dir-guard.ts` closes the object-storage one the same way by repointing `STORAGE_LOCAL_DIR`. Backups still fall back to `tmp/backups`, which nothing redirects.

`tests/setup/repo-write-guard.global.ts` runs as `globalSetup`: it walks the tree before and after the whole suite (about 2,500 files, roughly 5 seconds a pass) and fails the run if anything changed that the suite does not own. **`git status` is useless for this** — all four paths are gitignored, which is exactly why the pollution went unnoticed. Skipped directories: `node_modules`, `.git`, `.next`, `coverage`, `.turbo`, `generated`, `playwright-report`, `test-results`, `dist`, `build`, `out`, `.vercel`.

Four rules, because several agents may be editing the checkout while the suite runs and the dev server is writing it:

| What changed | Where                                                                                          | Verdict |
| ------------ | ---------------------------------------------------------------------------------------------- | ------- |
| Anything     | a **fenced** state path (`public/uploads` while `STORAGE_LOCAL_DIR` points outside the repo)   | ignored |
| Modified or removed | state paths only (`.data`, `tmp/backups`, and `DATA_DIR` when it points inside the repo) | fail    |
| Added        | state paths                                                                                    | fail    |
| Added        | anywhere else, and git ignores it                                                              | fail    |
| Added        | anywhere else, and git can see it                                                              | ignored |
| Modified     | anywhere else                                                                                  | ignored |

The first row is attribution, not tolerance, and it is the only row that is _earned_ rather than assumed. A before/after tree diff cannot say **who** wrote a file, and a dev server runs from this checkout by design: on 2026-08-27 it wrote a preview build and a checkpoint snapshot into `public/uploads` nine seconds into a run in which all 4,421 tests passed, and the guard reported them as the suite's pollution. Allowlisting the path would have deleted the check. Instead `storage-dir-guard.ts` points every process that could be the suite — the `globalSetup` process before the pool forks, and each worker again after `env.ts` has loaded `.env.local` — at a throwaway directory, so a write under `public/uploads` is provably somebody else's. Nothing is subtracted that the fence does not already prevent, and `resolveFencedPrefixes` returns nothing at all if the storage root is ever back inside the repository, which restores every verdict above.

The last two rows are what keeps it usable in a live checkout. A source edit changes a file that **already exists**, so a repo-wide content comparison would fail on somebody else's save; and a new _visible_ file is somebody adding source, which `git status` already shows — the guard's first real run failed on precisely that, another agent creating `tests/integration/publish-compensate-resume.test.ts` mid-suite. Git is used only to **classify** a candidate path, never to detect the change; detection is the mtime and size comparison, because git cannot see the paths that matter. When git cannot answer (no repository, no binary) the guard says so on stderr and checks the state paths only, rather than silently narrowing.

`globalSetup` runs in its own process, so it cannot see the temp `DATA_DIR` the worker processes get from `data-dir-guard.ts`, and does not need to — the point is to notice writes that land in the repository. `STORAGE_LOCAL_DIR` is the exception, and it is why the fence is applied from `globalSetup` as well: env set there **is** inherited by the worker pool, so this one variable holds the same value on both sides and the guard can read it to decide what it is still entitled to accuse.

The guard is itself tested (`tests/setup/repo-write-guard.test.ts`, reached because `tests/setup/**/*.test.ts` is in `include`): a guard nobody exercises is indistinguishable from one that cannot fail. Proven end to end both ways — a throwaway suite writing `tmp/backups/` fails the run with every test passing, and a throwaway suite creating a normal source file does not. The fence has its own worker-side proof in `tests/unit/storage-fence.test.ts`, which fails if the redirect stops reaching the code under test; without it, dropping the import would silently leave `lib/storage` on its `public/uploads` fallback **and** stop the guard watching that directory, which is worse than either half alone.

If a path is genuinely the harness's own output, add it to `DEFAULT_ALLOWLIST` in `tests/setup/repo-write-guard.ts` **with the reason**. A test being observed to leave something behind is the finding, not grounds for an exception.

### EXPLAIN / seq scans

The EXPLAIN check is a **soft skip** on a small test DB. It is not meaningful until tables are large. Re-run by hand against a copy of production data if you need index proof.

### Previous-schema migrate

A full previous-schema fixture is not checked in. Subset: empty DB + `prisma migrate deploy` on `TEST_DATABASE_URL`, plus the destructive detector on committed SQL. For a real upgrade, restore a backup of the previous production schema into a scratch database and migrate there first.

**What is and is not automated (F-603).** `tests/integration/seed-migrate.test.ts` used to carry a case named "documents previous-schema migrate as a subset" whose whole body was `expect(true).toBe(true)`. It now asserts what can be asserted without provisioning a second database: every folder under `prisma/migrations` has a non-rolled-back row in `_prisma_migrations`, every such row has a folder, and the timestamp-prefixed names are in deploy order. That catches a migration deleted or renamed after release — the first thing a previous-schema deploy trips over.

Two things are still covered by nothing, deliberately recorded here rather than implied by a green tick:

- **The deploy itself.** Migrating an empty database to the second-newest migration and then `migrate deploy`-ing to head needs a scratch database the test harness cannot create.
- **Checksum drift on an already-applied migration.** If a committed `migration.sql` is edited after a database has applied it, `prisma migrate deploy` against that database fails (`P3006`, "migration modified after it was applied") — a fresh CI database never sees it, so `verify` is green while a production upgrade is broken. Measured 2026-08-21 against `openlovable_test`: 44 of 46 recorded checksums match their file, and **two do not** — `20260819010000_drop_sandbox_columns` and `20260819020000_template_stack_no_default`, both amended during the sandbox-subsystem removal. Before the next production deploy, confirm whether either migration had already been applied to production; if so, the edit has to be reverted and the change re-issued as a new migration. Not asserted in the suite because the result depends on the age of the local test database, not on the repository.

## Git hooks

Husky + lint-staged:

- **pre-commit** (<10s): ESLint + Prettier on staged files; in-repo secret scanner over the **index** (PEM / AWS / GitHub PAT). Install `gitleaks` for a second pass on the local full-tree audit (`node ./node_modules/tsx/dist/cli.mjs scripts/secret-scan.ts`).
- **pre-push**: `verify` (`node ./node_modules/tsx/dist/cli.mjs scripts/verify.ts`), whose `secret-scan` step re-runs the same rules over every **tracked** file — see below.

### Hooks call binaries directly, never `pnpm exec` / `pnpm run`

Both hooks `cd "$(git rev-parse --show-toplevel)"` and then run `node ./node_modules/<tool>/…`, and so does every step `verify` itself runs (`lib/verify/orchestrator.ts`) — the hook rule was worthless while every step under it went through `pnpm exec`. They must never go through `pnpm exec` or `pnpm run`: pnpm runs a dependency-status check first, decides `node_modules` is stale, and tries to **purge it** before running anything. An agent shell survives that only because it has no TTY — a real `git commit` has one, so the purge would happen mid-commit and take the nested `minimatch@10` under `test-exclude/node_modules` with it (`.cursor/lessons-learned.md`). Never set `CI=true` or `confirmModulesPurge=false` to get past the abort; both arm the deletion. Each hook checks the binary exists first and exits 1 with "run pnpm install" if it does not. `.husky/.gitattributes` pins `eol=lf` so the hooks stay POSIX-runnable on Windows. The one deliberate exception is `pnpm audit`, which is not a script runner and has no vendored binary.

### Secret scan exit codes

`scripts/secret-scan.ts` fails **closed**: a scan that cannot enumerate its input or cannot read a file it was asked to check never reports a pass.

| Exit | Meaning                                                                                                                                                                        |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0    | Scanned clean, or genuinely nothing staged (the message says which, and never claims "passed" with 0 files scanned)                                                            |
| 1    | A credential pattern matched — a real finding to fix                                                                                                                           |
| 2    | The scan could not complete (git could not list the staged or tracked files, a blob or file was unreadable, or an installed `gitleaks` crashed) — a broken gate, not a finding |

Diagnostics go to stderr because that is what a git hook shows. Three input sets, and the difference matters:

| Mode        | Input                                                  | Used by                                                                                    |
| ----------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `--staged`  | the index blobs of the staged paths (`git show :path`) | `pre-commit` — a partially staged file is scanned as it will be committed                  |
| `--tracked` | every file under version control (`git ls-files`)      | the `secret-scan` `verify` step — ignored paths absent, so `.env.local` cannot hold it red |
| (default)   | the whole working tree, ignored files included         | a local audit, run by hand; it reports the real keys in `.env.local` on purpose            |

`--tracked` is the answer to "who scans a bypassed commit". `--no-verify` skips `pre-commit`, so a secret committed that way was never examined by anything until the next `verify` — which, before 2026-08-21, had no scan step at all (F-785). Because `verify` reads the tracked set rather than the diff, the finding surfaces on the next push whoever makes it. The gitleaks second pass stays on the default mode only: `detect --no-git --source <cwd>` reads ignored files, so under `--tracked` it would put a permanent red on any machine that has gitleaks installed and a populated `.env.local`. A missing `gitleaks` (`ENOENT`) is still a skip; any other `gitleaks` failure is exit 2.

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
node ./node_modules/tsx/dist/cli.mjs scripts/rollback.ts
# or from /admin/health → Roll back to previous release (type "roll back")
```

Direct binary, matching `.husky/pre-commit` and every `verify` step — **never `pnpm exec <tool>`**,
which is what this block used to print. Two sections above forbid that form because pnpm's
dependency-status check can purge `node_modules` before the command runs; an agent shell survives it
only for want of a TTY, and a human terminal has one. That would be a `node_modules` purge during a
rollback, i.e. with production already broken.

This redeploys the previous **git sha** image for the main app (`COOLIFY_APP_UUID`). The sha the app
reports is resolved in order `GIT_SHA` → `SOURCE_COMMIT` → `COOLIFY_CONTAINER_NAME` → `unknown`
(`currentRelease`, `lib/deploy/release.ts`; `/api/health` uses the same first two —
`lib/health/check.ts`). Only `GIT_SHA` was documented, so a deployment that sets `SOURCE_COMMIT`
instead reports a release from a variable this runbook did not name — which matters here, because
comparing shas is how you confirm a rollback landed. Both are **runtime**; `SOURCE_COMMIT` and
`COOLIFY_CONTAINER_NAME` are typically injected by the platform. **The database is not
auto-reverted.** If the release included a migration, restore from backup:
`node ./node_modules/tsx/dist/cli.mjs scripts/restore-db.ts --key …` into `RESTORE_DATABASE_URL`
(which must differ from `DATABASE_URL`). One restore command, in the hooks' direct-binary form —
this line used to give the script path with no runner and `AGENTS.md` said `npx tsx`, so neither
was copy-pasteable in the one situation where it is read.

### Staging

Create a **second Coolify application** (not a second client site):

- Own Postgres
- Own object storage bucket (`ELK_*`) and backup bucket (`BACKUP_*`)
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
| `authenticated`                  | **Yes — fatal `verify` step 11, and in CI since 2026-08-19** | The signed-in journeys: dashboard render (journey 0), create-project-from-a-prompt (2), the plan/build toggle (3), and the workflow journeys that need a session. Paid routes are stubbed; nothing here calls a provider                           |
| `critical`                       | **Yes — fatal `verify` step 10**                             | Signed-out sign-in screen, English copy, no serious axe findings (journey 1). An unreachable base URL is red unless `PLAYWRIGHT_ALLOW_NO_SERVER=1`, and the config now reuses or boots a server, so unreachable means something is genuinely wrong |
| `NEXTJS` … `SVELTE` (six stacks) | `verify:full` only                                           | Per-stack create/plan-build. Skipped with a stated prerequisite: the stack projects have no `storageState`, and there is no credential-free per-stack journey. No CI matrix any more (see CI above)                                                |
| `full`                           | `verify:full` only                                           | Signed-out surfaces reachable without a session (domains, recovery copy, invite gating, templates)                                                                                                                                                 |

## i18n

There is no translation catalog. Tests assert user-facing `app/` + `components/` + `lib/` strings contain no Hindi and no “klarco”. Both rules, and why `klarco` is banned, are documented in `lib/i18n/user-copy.ts`; the ban is also asserted over the built-in template rows (`tests/templates.test.ts`) and the rendered sign-in page (`e2e/journeys-critical.spec.ts`).
