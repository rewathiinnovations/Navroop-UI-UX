# Lessons Learned — Navroop
Read by the AI before every task. Every mistake is logged here so it
never repeats.
---
(newest entries on top)

### [2026-08-18] — a SUCCEEDED job with filesWritten is not a site if persist never ran
- **What happened:** Stream complete plus job `filesWritten` looked like a finished build. The job settled SUCCEEDED and phase went COMPLETE while `lastCode` and checkpoints were empty.
- **Root cause:** Streamed `<file>` blocks are progress, not persist. Persist never ran when the sandbox was FAILED or DEAD.
- **Rule going forward:** A SUCCEEDED job with `filesWritten` is not a site if persist never ran. `settleStreamedGeneration` fails `sandbox_unavailable`; phase uses `resumablePhaseFromEvidence` (`lastCode` / checkpoint only).

### [2026-08-18] — AI SDK `textStream` swallows provider errors unless `onError` is captured
- **What happened:** A Gemini identity / unregistered-caller rejection arrived on `streamText().onError` while `textStream` yielded nothing. The run looked like an empty completion and chat asked the user to describe the change in more detail.
- **Root cause:** AI SDK `textStream` drops error parts. The default `onError` only `console.error`s them. Without capturing that callback, `surfaceStreamFailure` never sees the provider error.
- **Rule going forward:** Bind `onError` with `bindStreamErrorCapture` (`lib/ai/empty-completion.ts`) before consuming `textStream`. Classify a captured identity/auth rejection as a credential failure, not `no_files_generated`.

### [2026-08-18] — `printf %s ${JSON.stringify(content)}` writes literal `\\n`
- **What happened:** Modal `package.json` (and other files) landed with visible `\n` sequences instead of real newlines (`{\n  "name": "sandbox...`).
- **Root cause:** `JSON.stringify` already escapes newlines as the two characters `\` and `n`. `printf %s` then wrote those characters literally. The shell never decoded them back.
- **Rule going forward:** Modal writes use `filesystem.writeText` (modal@0.9.0) with `absoluteSandboxPath`. Daytona's unused-shell fallback is `base64DecodeWriteCommand`. Do not `printf` a `JSON.stringify`'d file body.

### [2026-08-18] — a client import of a Node builtin 500s the page as a Turbopack panic
- **What happened:** `/admin/sandbox-providers` and `/project/[id]` returned HTTP 500 on cold compile ("An unexpected Turbopack error occurred"), then 200 on retry. The Next panic log said the browser chunking context does not support `node:async_hooks` / `node:dns`.
- **Root cause:** Client components imported copy helpers from modules that also imported Prisma/logger teardown (`lib/sandbox/test-run`) or DNS SSRF (`lib/security/url-guard` via `lib/jobs/copy` and `lib/import/errors`). Turbopack then tried to put those Node builtins in the client graph.
- **Rule going forward:** Keep Node-only work behind a server-only file. Client/admin chrome imports `lib/sandbox/provider-check-copy` and `lib/security/url-guard-messages` only. Do not `import type` a payload from a file that imports Prisma (`load-admin`). A warm 200 after a 500 is not proof the page is fixed.

### [2026-08-18] — a write must not assume it won because the end state looks like its own
- **What happened:** `commitActiveJob` returned the current row on a zero-row UPDATE. A lost abandon saw ABANDONED and re-ran publish compensation — on a first-time publish that deletes the Coolify app, the DNS record, and the deploy repo.
- **Root cause:** Treating "the row is already in the status I wanted" as "I wrote this." Losing to SUCCEEDED was safe (status mismatch skipped side effects); losing to another abandon was not.
- **Rule going forward:** Win is the UPDATE row count (`wrote` / `commitActiveJob` returning null). Re-read status only to log. Side effects (`ensureJobSettled`, the reaper, `abandonInstanceJobs`) run only when `wrote` is true. Tests that call `reconcileAbandonedJobs` pass `projectIds`.

### [2026-08-18] — a message must not promise what the code cannot prove
- **What happened:** Docs (and some create/install English) said a VM whose `create()` threw was "terminated so it is not billed", or that a failed `npm install` would "stop the VM". `teardownProvider` never throws; the result is `stopped` | `already_gone` | `could_not_stop`. A leak stays on `sandbox.teardownLeaks` and keeps `sandboxId` so the reaper can retry — it is still being billed.
- **Root cause:** Treating "we called terminate" as "the provider confirmed the VM is gone". The same mistake writes "not billed" into new copy that an agent then trusts.
- **Rule going forward:** "asked to stop" when we tried and do not know. "stopped so it is not billed" only on proven `stopped` / `already_gone`. "could not be shut down and may still be billed" on `could_not_stop`. Reconnect never tried to stop — "is still running and may still be billed". Do not write the billed-stopped sentence into AGENTS.md or UI copy unless the `TeardownResult` is in hand.

### [2026-08-18] — composed `Prisma.sql` becomes `$1` inside the Next bundle
- **What happened:** Job heartbeats died with Postgres 42601 (`SET $1`). Vitest against the same helper was green.
- **Root cause:** A composed `Prisma.sql` / `Prisma.join` / `Prisma.raw` fragment interpolated into a `` prisma.$queryRaw`…` `` / `` $executeRaw`…` `` tagged template is inlined under plain Node, but the bundled Next server binds the whole fragment as one parameter.
- **Rule going forward:** Build the SQL text and number the placeholders yourself, then `$queryRawUnsafe` / `$executeRawUnsafe`. Column names from source literals only; values always bound. Guard: `tests/unit/raw-sql-composition.test.ts`. Do not treat a passing Vitest raw-SQL suite as proof the Next path works.

### [2026-08-18] — a scratch `.ts` at the repo root breaks `tsc`
- **What happened:** `tsc --noEmit` failed TS6053 (or typechecked throwaway agent files as app code) after someone dropped a debug/scratch `.ts` in the repo root.
- **Root cause:** `tsconfig` `include` is `**/*.ts`. A file at `.` is in the app check. `exclude` does not save you once the file exists.
- **Rule going forward:** Never create throwaway `.ts` / `.tsx` at the repo root. Put scratch under a gitignored dir, or delete it before leaving. Do not "just compile this one file" next to `app/` / `lib/`.

### [2026-08-18] — two `vitest --coverage` runs in one checkout
- **What happened:** A second `vitest --coverage` while another was in flight produced a garbage coverage table or a mysterious floor miss. `coverage/.tmp` is shared per checkout.
- **Root cause:** v8 coverage writes staging files under `coverage/.tmp`. Concurrent runs interleave those files. The later process (or the verify step) then reads a mix.
- **Rule going forward:** Only one `vitest --coverage` in this checkout. If verify or another agent already started one, wait. Do not start a second to "go faster".

### [2026-08-18] — [] / {} / false is not "nothing happened"
- **What happened:** Publish skipped an unreadable file, treated a failed READY listing as an empty tree and shipped the last checkpoint, E2B `listFiles` `JSON.parse` returned `[]`, and Daytona reconnect returned `false` on any SDK error. Test/probe accepted `https://undefined` because it was truthy.
- **Root cause:** A caught error became an innocent empty value. `no-empty` stops `catch {}` but not `catch { return [] }`.
- **Rule going forward:** A listed publishable file that cannot be read fails collect. A failed listing on a READY sandbox fails collect — only "no live sandbox" / reconnect-said-gone uses the checkpoint. Unparseable `listFiles` output throws. Reconnect `false` needs positive gone evidence (404/410/NotFound); uncertain throws. Preview URLs must parse as http(s) with a real hostname, and Test still does not fetch.

### [2026-08-18] — one fact, one sentence; a truthy URL is not a URL
- **What happened:** apply-ai-code-stream already closed with `applyOutcome`, but the generation page then added "Applied N files successfully!". E2B built `https://${getHost()}` so a missing host became `https://undefined`, which passed the probe's truthy-URL check.
- **Root cause:** A second vocabulary for the same apply result, and string interpolation treated as proof a preview host existed.
- **Rule going forward:** Chat/log after apply must call `applyPageCopy` / `applyOutcome` — do not compose a success line from `filesCreated.length`. Never interpolate a host/tunnel into a URL until it is a non-empty hostname that is not the literal `undefined`/`null`. `https://undefined` is not a preview URL.

### [2026-08-18] — unit tests must not fetch localhost by default
- **What happened:** The test network guard allowlisted `localhost` / `127.0.0.1`. The github-oauth suite used to `fetch` `http://localhost:3000`; locally that hit the live app and passed because someone was watching `:3000`. In CI nothing listens, so the same calls used to skip inside `catch {}` and the suite still exited 0.
- **Root cause:** Loopback was treated as "safe" instead of "the running product". A green unit test then meant "the dev server happened to be up".
- **Rule going forward:** `tests/setup/network-guard.ts` blocks loopback unless the test calls `allowLocalhost('reason')`. Prefer calling `proxy` / the handler directly. Do not skip when the server is absent. Do not put `localhost` back on the default allowlist.

### [2026-08-18] — do not tighten shared `declare global` types
- **What happened:** Typing `global.sandboxData` in `restart-dev.ts` as a narrow object made `tsc` fail in `install-packages.ts`, `kill-sandbox`, and `sandbox-status` (`TS2403` subsequent variable declarations).
- **Root cause:** Several files `declare global { var sandboxData: any }`. The first checked declaration wins; a stricter one in a shared helper poisons every other file.
- **Rule going forward:** Leave shared sandbox globals as `any` (or a single shared type module). Read `url` through a local cast, do not redeclare the global.

### [2026-08-18] — pre-commit scanned node.exe and failed open
- **What happened:** `.husky/pre-commit` ran `pnpm exec tsx scripts/secret-scan.ts --staged`. The script built its extra-path list from all of `process.argv`, so `argv[0]` (the node binary) survived the `--staged` filter. `--staged` never took effect. Meanwhile `git diff --cached` errors returned `[]` and printed `Secret scan passed (0 files).` exit 0.
- **Root cause:** Treating "could not list / could not read" as "nothing to scan", plus argv parsing that included the runtime. A real `git commit` also has a TTY, so `pnpm exec` would have tried to purge `node_modules` mid-commit.
- **Rule going forward:** Hooks call `node ./node_modules/<tool>/…` directly after `cd "$(git rev-parse --show-toplevel)"`. Secret scan exit **1** is a finding; exit **2** is a broken gate (unexamined content) and is not a pass. Staged mode reads `git show :path` when the worktree differs. Keep `.husky` LF (`.husky/.gitattributes`). Never `pnpm exec` / `pnpm run` from a hook.

### [2026-08-18] — `pnpm exec` wants to delete node_modules before it runs anything
- **What happened:** `pnpm exec vitest run --coverage` exited 1 in ~5s without starting Vitest: `[ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY] Aborted removal of modules directory due to no TTY`, after `[ERROR] Command failed with exit code 1: … pnpm.mjs install`.
- **Root cause:** pnpm runs a dependency-status check before `exec` / `run`. `node_modules` here does not match the lockfile (the nested `minimatch@10` under `test-exclude/node_modules`, plus the ignored `pnpm.overrides` field), so pnpm decided to reinstall and asked to purge `node_modules` first. It aborted **only because an agent shell has no TTY** — that is luck, not a safeguard. Under a TTY, or with `CI=true` / `confirmModulesPurge=false`, it would have deleted the nested v10 graph and broken coverage entirely (see the test-exclude entry below).
- **Rule going forward:** Do not run `pnpm exec <tool>` in this repo while `:3000` is up. Invoke the installed binary directly: `node ./node_modules/typescript/bin/tsc --noEmit`, `node ./node_modules/eslint/bin/eslint.js . --max-warnings 0`, `node ./node_modules/vitest/vitest.mjs run --coverage`, `node ./node_modules/tsx/dist/cli.mjs <script>`. Scripts you *write* still use pnpm; a script that must spawn a CLI resolves it with `createRequire(...).resolve('<pkg>/…')` and spawns `process.execPath` (see `scripts/migrate-test-db.ts`). Never set `CI=true` or `confirmModulesPurge=false` to get past the abort — that arms the deletion.

### [2026-08-18] — next-env.d.ts imports bypass tsconfig exclude
- **What happened:** `tsc --noEmit` failed on `.next/dev/types/routes.d.ts` (TS1005 / TS1128) after `.next` was already in `exclude`.
- **Root cause:** Next 16.3 writes `import "./.next/dev/types/routes.d.ts"` into `next-env.d.ts`. TypeScript follows imports even when the path is excluded. `tsconfig` `include` of `.next/dev/types/**/*.ts` is a second path; Next's `writeConfigurationDefaults` re-adds those globs.
- **Rule going forward:** Do not include `next-env.d.ts` in the app `tsc` used by verify. Keep Next's file on disk for the plugin. Point `include` at `types/next-env.d.ts` (triple-slash `next` refs only). Exclude `.next` and `next-env.d.ts`. Do not delete the live `.next` folder while `:3000` is up.

### [2026-08-18] — Audit highs: version-specific overrides, not one major
- **What happened:** `pnpm audit --audit-level=high` reported 93 vulns (56 high, 1 critical). Isolated eslint-config-next copies inflated path counts (e.g. 86× `minimatch@3.1.2`).
- **Root cause:** The unique list is small and real. The **critical** is `tar@7.4.3` via `@e2b/code-interpreter>e2b>tar` (patched `>=7.5.19`), not Prisma. `deepmerge-ts@7.1.5` via `@prisma/config` is **high** (stack exhaustion; patched `>=8`). A single `minimatch`/`glob`/`nanoid` override to the newest major would break eslint / sucrase / postcss.
- **Rule going forward:** Use `pnpm.overrides` with same-major selectors (`minimatch@3`, `glob@10`, `nanoid@3`). `deepmerge-ts` `^8` is OK — Prisma only calls `deepmerge` on plain config objects; do not bump Prisma major. Do not `pnpm add` / install while `:3000` is up. Do not remove the audit step from verify.

### [2026-08-18] — Playwright webServer must inherit ENCRYPTION_KEY
- **What happened:** Playwright critical timed out: `ENCRYPTION_KEY must be set and at least 32 bytes`.
- **Root cause:** CI `webServer` runs `pnpm start` (`next start` → production `assertBackupBoot`). Playwright does not load `.env.local`, and `webServer` had no `env` object, so a parent without the key booted Next with none.
- **Rule going forward:** Load `.env` / `.env.local` in `playwright.config.ts` via `lib/verify/playwright-env.ts`. Pass `webServer.env` as `Record<string, string>` (filter out `undefined` — Playwright does not accept `ProcessEnv`). Playwright replaces env, it does not merge. If `ENCRYPTION_KEY` is missing or under 32 bytes, use the hardcoded test-only placeholder. Never copy a real key from `.env.local` into source.

### [2026-08-18] — test-exclude needs minimatch v10 named export
- **What happened:** `vitest run --coverage` died with `TypeError: minimatch is not a function` from `test-exclude` / `@vitest/coverage-v8`.
- **Root cause:** `test-exclude@7` does `const { minimatch } = require('minimatch')` (v10 API). Isolated/hoisted `minimatch@3` exports the function as default, so the named bind is `undefined`.
- **Rule going forward:** Keep `minimatch@^10.2.2` in `devDependencies`. Nest a complete v10 graph under `test-exclude/node_modules` if you cannot `pnpm add` while `:3000` is up. Do not replace top-level v3. Do not relocate `next`.

### [2026-08-18] — legacy DB suites must ensure a default plan
- **What happened:** `generation-jobs`, `consumption`, `plans-limits`, and `audit-invariants` failed with `No default plan is configured` / `Seed the Free plan`.
- **Root cause:** Those suites assumed `prisma db seed` had already written `Plan.isDefault`. `openlovable_test` often has migrations only.
- **Rule going forward:** Call `ensureDefaultPlan` (same Free row as `prisma/seed.ts`) at the start of each DB suite. Do not require a prior seed.

### [2026-08-17] — migrate diff --from-migrations needs a shadow URL
- **What happened:** `pnpm run verify` Schema drift failed with `You must pass the --shadow-database-url if you want to diff a migrations directory.`
- **Root cause:** Prisma cannot apply a migrations folder without a disposable shadow database. The app DB and `openlovable_test` must not be used — Prisma may wipe the shadow.
- **Rule going forward:** Pass `--shadow-database-url` to `prisma migrate diff --from-migrations`. Use `SHADOW_DATABASE_URL` or derive `…/openlovable_shadow` from `TEST_DATABASE_URL`. Create the empty DB if missing. Keep `--exit-code` so real drift still fails.

### [2026-08-17] — React Compiler hook rules vs verify
- **What happened:** `eslint . --max-warnings 0` failed with 89 errors after eslint-config-next started shipping React Compiler rules (`set-state-in-effect`, `immutability`, `refs`, `purity`).
- **Root cause:** Fetch-on-mount / sync-from-storage `setState` is everywhere. Compiler rules also lint vendored `.cursor/skills` CommonJS scripts.
- **Rule going forward:** Keep `set-state-in-effect` off with `exhaustive-deps` / `prefer-const` (documented in `docs/release.md`). Ignore `.cursor/**`. Fix `immutability` / `refs` / `purity` in source when cheap; do not rewrite `components/workspace/GenerationWorkspace.tsx` to reorder functions.

### [2026-08-17] — Stale `.next/types` is not source of truth
- **What happened:** `tsc --noEmit` failed first on `.next/types/validator.ts` looking for `app/admin/page.js` after pages moved to `app/(app)/admin`.
- **Root cause:** `tsconfig` included `.next/types/**/*.ts`. That tree lags route moves. A second wave was TS5097 on `import '….ts'` because `allowImportingTsExtensions` was off.
- **Rule going forward:** Exclude `.next` from `include`. Do not invent stub pages to satisfy generated validators. Keep `allowImportingTsExtensions` while `noEmit` is true. Run tsc via `node node_modules/typescript/bin/tsc --noEmit`.

### [2026-08-17] — Map callback `({)` is a merge leftover
- **What happened:** `tsc` failed in `lib/health/admin.ts` at line 76 with TS1136 (`Property assignment expected`) plus a cascade of TS1005/TS1128. Health, release SHA, orphans, and provider rows were all present.
- **Root cause:** A jobs/health merge left `.map((row) => ({)` — the `)` closed the object before `kind` / `status` / `lastCheckedAt`. The property list and the later `})),` were then orphaned.
- **Rule going forward:** After merging a `.map` that returns an object, re-read the callback. Grep `=> ({)` (close paren immediately after `({`). The opener is `({` and the closer is `})` / `})),` on a later line — never `({)` on the same line as `map`.

### [2026-08-17] — Chat busy must follow the job, not Project.phase
- **What happened:** Recovery showed “The last build did not finish” twice, and chat stayed on “Building — hang tight…” with the input locked after an abandoned/failed job.
- **Root cause:** `recoveryCauseLine` repeated `RECOVERY_HEADING` when `errorCode` was missing. ChatInput/BuildingIndicator treated `phase === 'BUILDING'` (and leftover `sending` / `isJobActive`) as busy even when the latest job was ABANDONED/FAILED/CANCELLED.
- **Rule going forward:** Derive building/lock from job QUEUED|RUNNING. Terminal job or recovery → unlock chat, hide BuildingIndicator, do not repeat the recovery heading as the body. UI must work even if `Project.phase` is stale.

### [2026-08-17] — Waiter.settled must be set inside resolve, not before
- **What happened:** Provider queue tests hung on `await second.started` after `release()`.
- **Root cause:** `promote()` set `waiter.settled = true` then called `resolve()`, and `resolve` bailed because settled was already true, so the Promise never settled.
- **Rule going forward:** If a resolve wrapper guards on `settled`, only that wrapper may flip the flag. Promoters call `resolve(result)` only.

### [2026-08-17] — Auth helpers must be discriminated unions
- **What happened:** `tsc` reported ~80 `ActionErr.error: string | null` errors on admin/settings/template routes. `result` from `listTemplates` / `createFromTemplate` was also `null`.
- **Root cause:** `requireSessionUser` / `requireAdmin` returned `user: null as SessionUser | null`, so `if (!user)` did not narrow `error` to a string. `'error' in loaded` on domain helpers had the same gap — the success object stayed in the union and `error` became `string | undefined`.
- **Rule going forward:** Gate helpers return `{ user: SessionUser; error: null } | { user: null; error: string }`. Never `as SessionUser | null`. Prefer `{ ok: true } | { ok: false; error: string }` over `'error' in loaded`. After changing a gate, grep callers for `string | null` on `error`.

### [2026-08-17] — Flex `h-dvh overflow-hidden` needs `min-h-0` + inner scroll
- **What happened:** Dashboard/projects cards and the sidebar account avatar were clipped. The ⋮ menu shadow was cut off. Users could not scroll the grid or the sidebar.
- **Root cause:** App shell is `flex h-dvh overflow-hidden`. Flex items default to `min-height: auto` (content size), so the main column grew with the grid and never activated `overflow-y-auto`. The sidebar stacked nav + recents + footer with only a `flex-1` spacer — no scroll region — so the pinned account control was pushed off-screen and clipped. Project card `overflow-hidden` (thumbnail clip) also clipped the in-card kebab. Global `::-webkit-scrollbar { width: 0 }` hid any thumb that did exist.
- **Rule going forward:** On a locked viewport shell, every flex child that should scroll needs `min-h-0` (and `min-w-0` on the main axis). Sidebar: scrollable nav (`flex-1 min-h-0 overflow-y-auto`) + `shrink-0` footer. Main: `flex-1 min-h-0 overflow-y-auto`. Do not put dropdowns inside `overflow-hidden` — portal (Radix `DropdownMenuContent`) or keep overflow only on the thumbnail. Scope visible scrollbars to `.studio-scroll`; do not rely on a zero-width global scrollbar.

### [2026-08-17] — JSX merge leftovers: wrap ternary siblings
- **What happened:** Next compiled `VersionHistoryPanel.tsx` with `Expected '</', got '{'`. Export “Download code” was inserted next to Restore; the status hint stayed as a second sibling after `</div>` inside `pruned ? (…) : (…)`.
- **Root cause:** A ternary branch is one expression. Two adjacent JSX nodes after a mid-element insert need `<>…</>` (or one parent). Same merge-leftover class as dropping surrounding syntax, but in JSX not Prisma.
- **Rule going forward:** After inserting a button/hint into a ternary, re-read the branch. If more than one child remains, wrap them. Grep `) : (` then a closed tag followed by `{`.

### [2026-08-17] — Job try/catch must not drop the following Prisma call
- **What happened:** Next.js 16.3.1 failed the build on `lib/projects/plan.ts:338` (`Expression expected` at `where: { projectId }`). `generatePlan` had a valid `failJob` catch after `completePlan`, then an orphaned Prisma argument object (`where` / `orderBy` / `select` / `});`) so `latest` was used but never declared.
- **Root cause:** GenerationJob merge wrapped `completePlan` in try/catch and deleted `const latest = await prisma.projectPlan.findFirst({`, leaving the query body after `throw error;`. Parallel agents collided on the same function.
- **Rule going forward:** When wrapping an existing call in try/catch, keep the next statement (`const latest = await prisma.…findFirst({`). After a job/export/onboarding merge, re-read the function and grep for orphaned `where: { projectId }` / stray `});` after `throw`. Wait, then merge only the delta — never clobber the following Prisma query.

### [2026-08-17] — Do not run npm in this pnpm repo
- **What happened:** An accidental `npm install` / npm fallback created untracked `package-lock.json` next to `pnpm-lock.yaml`. Cursor warned it was using npm as the preferred package manager because multiple lockfiles existed and `npm.packageManager` was `auto`.
- **Root cause:** This repo’s source of truth is pnpm. Cursor/VS Code auto-picks npm when both lockfiles are present. `package.json` had no `packageManager` field.
- **Rule going forward:** Use pnpm only. Never `npm install` / `npm add`. Do not create `package-lock.json`. Keep `pnpm-lock.yaml`. Workspace `.vscode/settings.json` must set `"npm.packageManager": "pnpm"`. `package.json` has `"packageManager": "pnpm@…"`.

### [2026-08-17] — Do not export sync helpers from `'use server'` files
- **What happened:** Next.js 16.3.1 failed the build with `Server Actions must be async functions` on `toPublic` in `lib/templates/actions.ts`, imported by `app/(app)/templates/page.tsx`. The same class of error kept coming back.
- **Root cause:** A file-level `'use server'` directive makes every exported function a Server Action. `toPublic` was a sync mapper re-exported from that module (`export { toPublic }`), so Turbopack rejected it. Marking helpers `async` is a hack; the helper should never have been a Server Action.
- **Rule going forward:** `'use server'` modules may export only `async` functions (types are fine). Sync helpers, mappers, and constants live in a sibling file with no `'use server'` (same pattern as `lib/domains/instructions.ts`). Before adding or re-exporting anything from an actions file, grep that file for `export function` / `export {` and confirm every runtime export is `async`. Do not `export { helper }` from a `'use server'` file.

### [2026-08-18] — A test wrote the repo `.data` and faked a Sentry incident
- **What happened:** `/api/health` reported `observabilityFile.matchesIntegration === false` on this box: `.data/config/observability.json` named Sentry project `456789` while the CONNECTED `Integration` row named the real one. The smoke test exited 1. It looked like a connect path shipping a broken integration.
- **Root cause:** `tests/unit/sentry-integration.test.ts` calls `migrateEnvSentry` with an injected `createMigrated`, and `lib/observability/migrate-env.ts` then did a second `writeRuntimeConfig` inside `try {} catch {}`. With no `OBSERVABILITY_CONFIG_PATH` or `DATA_DIR` override, `getDataDir()` fell back to `<cwd>/.data` — the same directory the dev server reads — so fixture state landed in the running app and the swallowed error hid it. All four real write paths (connect, settings, disconnect, boot reconcile) were correct.
- **Rule going forward:** Tests never touch `<cwd>/.data`; `tests/setup/data-dir-guard.ts` repoints `DATA_DIR` at a temp dir before any test module loads, and `tests/unit/test-data-dir-guard.test.ts` fails if that stops working. One writer per derived file: `persistSentryConnection` owns `observability.json`, so `migrateEnvSentry` no longer writes it. Before blaming a shipped path for local drift, check the file mtime against the boot time — a write newer than the server boot is someone else's process.

### [2026-08-18] — "Not checked yet" is not "not writable"
- **What happened:** `getDataDirStatus()` returned `writable: false` plus an `error` string before the boot probe had run, so an unprobed volume read to an operator as a missing persistent volume — a different incident with a different first move.
- **Root cause:** A single boolean cannot carry three answers. The unknown state was encoded as a failure.
- **Rule going forward:** `DataDirStatus.checked` distinguishes "no probe has run" (`error: null`) from a real probe failure. `describeDataDir()` in `lib/health/check.ts` maps it to `state: 'ok' | 'not_checked' | 'unwritable'` with plain English per state, and `/admin/health` renders "Not checked yet" in muted text, never danger red.

### [2026-08-18] — Never unlink the destination before the rename
- **What happened:** `writeCacheJson` wrote a temp file, `unlinkSync`'d the destination, then renamed. A failed rename hit an empty catch that deleted the temp file, so a failed write destroyed the previous good value and left no cache file at all. Nothing was logged, ever. Observable cost: the GitHub installation-token cache kept vanishing, so every publish re-minted a token against the rate limit.
- **Root cause:** The unlink was there to make rename-over-existing safe, which `renameSync` already is on both POSIX and Windows. It converted an atomic replace into a destructive two-step.
- **Rule going forward:** Atomic file writes are `write tmp` → `rename tmp over path`. Never unlink the destination first. A non-throwing writer must still return a result and log the failure — "callers treat this as optional" is a reason to keep going, never a reason to stay quiet. Guard: `tests/unit/data-dir-cache-write.test.ts`.

### [2026-08-18] — `void` on a telemetry write makes a real probe read as no activity
- **What happened:** `/admin/usage` under-reported SSRF private-range rejects. The reject path did `void logRejectedUrl(...)` and threw immediately, so the counter transaction was still in flight — or abandoned — when anything read it. A discarded write also becomes an unhandled rejection with no context.
- **Root cause:** Fire-and-forget was chosen to keep the reject path fast, on a path that is already refusing the request and has no latency budget worth protecting.
- **Rule going forward:** If a caller is already async, `await` the counter write and make the writer non-throwing so the await cannot turn a refusal into a 500 (`logRejectedUrl`). Where the call site is genuinely synchronous, use the explicit `recordRejectedUrl` wrapper that attaches a `.catch`, never bare `void`. Same rule for detached post-generation work: detached must still mean logged with the project id and the task name. Guard: `tests/integration/ssrf-counter.test.ts`, `tests/integration/after-generation-followups.test.ts`.

### [2026-08-18] — Clearing an "already alerted" flag with a blanket catch buys permanent silence
- **What happened:** Four call sites cleared an alert row with `prisma.appSetting.delete(...).catch(() => undefined)`. The catch existed because deleting a row that was never created throws P2025, so it also swallowed real write failures — and for the low-space flag the consequence is that no further low-disk email is ever sent. `runTmpSweep` reported `ok: true` while both of its alerting steps had failed.
- **Root cause:** One catch covering "expected not-found" and "the database refused the write", on a flag whose failure mode is silence rather than an error.
- **Rule going forward:** Use `deleteMany` for idempotent clears so not-found is a clean success and every remaining error is real. Log it, and where the failed step *is* the alerting, report `ok: false` so `handleCron` turns it into a 500 and a failed `CronRun` row. Guards: `tests/unit/alert-clear.test.ts`, `tests/unit/alert-clear-failures.test.ts`.
