# Phase 6 — Section N (tests & the verify gate) and Section O (cross-cutting)

Scope: `audit/_scope-p6.txt` — 273 files, 41,494 lines. Finding ids **F-600 … F-699**.

## Method and honesty note

Read line-by-line, in full: all 13 `e2e/**` files, all 6 `lib/verify/**` files,
`vitest.config.ts`, `playwright.config.ts`, all 11 `tests/setup/**` files, all 30
assert-style suites under `tests/*.test.ts`, all 9 `tests/factories/**`, all 8
`tests/mocks/**`, `tests/register-ts.mjs`, and ~70 of the 194 files under
`tests/unit/**` + `tests/integration/**`.

The remaining ~124 files under `tests/unit/**` and `tests/integration/**` were read
by machine, in full, against the defect classes this phase is looking for — literal
`expect(true)`, `|| true`, `?.x == null`, `.only` / `.skip` / `.fixme` / `.todo`,
`it()` bodies containing no assertion, `not.toHaveBeenCalled()` sites, early-return
guards before the only assertions, `try/catch` that converts a throw into a pass,
`source.slice(source.indexOf(...))` windows that collapse to `''`, direct `PrismaClient`
construction, `fetch` to a real host, floating promises, and `TODO`/`FIXME`/`HACK`.
**Every hit was then opened and read in context before it became a finding or was
discarded.** Several candidates raised by that sweep were rejected on reading
(`tests/unit/s3-not-found.test.ts:260,269`, `tests/unit/register-invite-only.test.ts:71`,
`tests/unit/shutdown-drain.test.ts:114`, `tests/unit/generation-stream-rail.test.ts:74`,
`tests/integration/raw-sql-parse.test.ts` — all are protected by a preceding assertion
or a throwing helper). Where the ledger says `clean`, that means: no hit in any of the
above classes, and — for the ~70 files read line-by-line — no defect on reading either.

Nothing in the repository was modified. One scratch file was created by accident during
ledger generation (`audit/_ledger-p6.tmp.txt`) and deleted in the same minute; the
working tree is otherwise untouched by this phase.

No test was executed. `pnpm audit` and `vitest --coverage` were deliberately not run
(another agent's coverage run would be corrupted, and `pnpm audit` needs an install that
`:3000` forbids). Dependency conclusions come from `pnpm-lock.yaml` and the source tree.

---

## Headline

The test corpus is unusually disciplined. Almost every source-scanning "convention" test
carries an explicit anti-vacuity guard (`expect(endpoints.length).toBeGreaterThan(150)`,
`expect(includeGlobs.length).toBeGreaterThan(0)`, `expect(withRawSql.length).toBeGreaterThan(15)`),
the network guard blocks loopback by default, the repo-write guard is itself tested, and
`requirePassingTests` already closes the "exited 0 having run nothing" hole for Playwright.
Only **one** genuinely vacuous product test survives (`money-limits.test.ts:71-77`) and
two no-op placeholders (`explain`, `seed-migrate`).

What is weak is not the tests that exist but three structural things:

1. **`pnpm run verify` can validate a different checkout.** `playwright.config.ts`
   defaults `baseURL` to `http://localhost:3000` with `reuseExistingServer: true`, and
   AGENTS.md:26-28 says `:3000` is the **`.worktrees/main`** dev server while the primary
   checkout runs on `:3001`. Both Playwright steps are fatal gates. (F-620, HIGH.)
2. **Server Actions are the largest untested surface in the product.** Ten `'use server'`
   modules totalling ~2,100 lines — every one of them carrying `requireAdmin` /
   `requireSessionUser` / `canMutate` as the _only_ authorization for that path — are
   never loaded by any test. (F-613.)
3. **The observability layer converts its own failures into "all clear."**
   `lib/observability/sentry-api.ts` turns a failed Sentry API call into
   `0 accepted / 0 dropped / quota 0 of 1 / no issues`, which is exactly the shape of a
   healthy project. (F-631, HIGH.)

---

## Section N — tests and the verify gate

### F-600 [MEDIUM] The unit suite constructs a live PrismaClient against the application database

- Area: N
- Location: `vitest.config.ts:24` (`setupFiles: ['tests/setup/vitest.setup.ts']`),
  `tests/setup/vitest.setup.ts:1-7`, `tests/setup/env.ts:22`, `lib/db.ts:7-11`
  (related: `.github/workflows/verify.yml:29-30`, `tests/setup/db.ts:45-68`)
- What happens: `tests/setup/env.ts` is the only thing that rewrites `DATABASE_URL` to
  `TEST_DATABASE_URL`, and it is **not** in the global `setupFiles`. It is imported by
  exactly one file, `tests/integration/legacy-db-suites.test.ts:1`, plus by each
  `tests/integration/*.test.ts` individually. Nothing loads it for `tests/unit/**`.
  An import-graph walk of the 194 collected test files shows **23 files under
  `tests/unit/` reach `lib/db.ts` without a `vi.mock('@/lib/db')`** — among them
  `image-worker`, `morph-fast-apply`, `storage-not-found`, `import-client-frames` (via
  `lib/settings/resolve.ts`), `provider-key-resolves` and `ai-effective-env` (via
  `lib/api-keys.ts`), `data-dir`, `observability`, `sentry-integration`, `property`,
  `publish-naming-slug`, `jobs-copy`, `storage-key-traversal`. `lib/db.ts:9` runs
  `new PrismaClient()` at module scope, so each of those workers holds an open client
  pointed at the **application** database (in CI, `postgresql://…/openlovable`, the same
  database `next start` and the Playwright journeys use).
- Trigger: Constructing does not connect, so nothing is damaged today — none of those
  23 files currently issues a query. The guard that is supposed to prevent this
  (`tests/setup/db.ts` `assertTestEnvApplied`) only covers the explicit
  `testPrismaClient()` factory; it cannot see the `@/lib/db` singleton. The first unit
  test that calls a settings/api-key/data-dir helper for real writes to the app DB.
- Impact: Audit-map invariant 15 ("Tests — `TEST_DATABASE_URL` only") is unenforced for
  the entire `tests/unit/**` tree. A future unit test can read or write real project,
  user or `AppSetting` rows and nothing will notice.
- Confidence: Confirmed (graph computed from the real import statements; `lib/db.ts`
  read).
- Suggested fix: Add `tests/setup/env.ts` to `vitest.config.ts` `setupFiles` ahead of
  `vitest.setup.ts`, so the redirect happens for every worker rather than for the
  integration files that remember to import it. If requiring `TEST_DATABASE_URL` for a
  pure unit run is unacceptable, add a second guard module that instead points
  `DATABASE_URL` at an unreachable sentinel URL when `TEST_DATABASE_URL` is unset — so a
  unit test that queries fails loudly instead of hitting real data.

### F-601 [MEDIUM] The "credits are checked before a model call" test invokes nothing

- Area: N
- Location: `tests/unit/money-limits.test.ts:71-77` (related: `tests/mocks/ai.ts:3-8`)
- What happens:
  ```
  it('credits are checked before a model call — mock stays idle on fail', async () => {
    const ai = createAiMock('success');
    const check = { ok: false as const, reason: 'workspace_exhausted' as const };
    if (!check.ok) {
      expect(creditDenialMessage(check.reason)).toMatch(/credits are used up/i);
      expect(ai.invoked).toBe(0);
    }
  });
  ```
  `check` is a literal the test writes itself; no product code decides it. `ai` is a
  freshly constructed mock that is handed to nothing, so `ai.invoked` is `0` by
  construction. The only real assertion is that a copy constant matches a regex. This is
  precisely the "`not.toHaveBeenCalled()` on a mock that was never wired" class the brief
  names — the two remaining `not.toHaveBeenCalled()`-equivalents in this file's siblings
  are all genuinely wired; this one is not.
- Trigger: Always. Delete the credit pre-flight from every call site and this test stays
  green.
- Impact: The money path's headline invariant ("check credits _before_ spending tokens")
  reads as covered in review and is covered by nothing. `tests/plans-limits.test.ts`
  covers `checkCredits`/`consumeCredits` in isolation, but nothing asserts the ordering
  at a call site.
- Confidence: Confirmed.
- Suggested fix: Drive the real path: call the generate route (or
  `chargeJobCreditsOnce` / `markJobRunning({ chargeCredits: true })`) with a workspace
  whose credits are exhausted, with the AI client injected as the mock, and assert
  `ai.invoked === 0` afterwards. If that is too much wiring for a unit test, delete the
  case rather than leave it — it is currently negative coverage.

### F-602 [MEDIUM] `tests/integration/explain.test.ts` is entirely `expect(true).toBe(true)`

- Area: N
- Location: `tests/integration/explain.test.ts:8-16` (lines 10 and 15)
- What happens: The whole file is one `it()` whose body is two `expect(true).toBe(true)`
  calls — one on the `!process.env.TEST_DATABASE_URL` branch, one after it. It runs no
  `EXPLAIN`, opens no connection, and cannot fail under any condition.
- Trigger: Always.
- Impact: The file is named `explain` and its doc comment describes an "EXPLAIN seq-scan
  check". It is counted in the pass total of `pnpm run verify` and asserts nothing. The
  index-usage question it names — whether the hot queries (`listReconcileCandidates`,
  project search, presence) plan as index scans — has no coverage anywhere.
- Confidence: Confirmed.
- Suggested fix: Either delete the file and record the gap, or make it real: seed a
  few thousand rows in a `beforeAll`, run `EXPLAIN (FORMAT JSON)` against the two or
  three statements whose plans matter, and fail on `Seq Scan` for those. A placeholder
  that always passes is worse than an absent test because it makes the gap invisible.

### F-603 [LOW] One of three `seed-migrate` cases is a no-op

- Area: N
- Location: `tests/integration/seed-migrate.test.ts:31-35`
- What happens: `it('documents previous-schema migrate as a subset', () => { expect(true).toBe(true); })`.
  The other two cases in the file are real (they walk `prisma/migrations` and assert the
  seed files use upserts).
- Trigger: Always.
- Impact: The upgrade-from-previous-schema path — the one that decides whether a
  production `prisma migrate deploy` succeeds — is claimed by a test name and covered by
  nothing.
- Confidence: Confirmed.
- Suggested fix: Delete the case and note the gap in `docs/release.md`, or replace it
  with a real check: migrate an empty database to the second-newest migration, then
  `migrate deploy` to head, and assert exit 0.

### F-604 [LOW] `tests/unit/mocks.test.ts` tests helpers that nothing uses, with one assertion that cannot fail

- Area: N
- Location: `tests/unit/mocks.test.ts:70` and `:74-77`; `tests/mocks/index.ts:1-7`
- What happens: Line 70 is `expect(name).toBeTruthy()` where `name` is a string literal
  taken from the `factories` const array declared at `:12-20` — it cannot be falsy.
  Lines 74-77 assert `ai.invoked === 0` immediately after `createAiMock('success')`,
  which is true by construction. More importantly, a grep of the whole `tests/` and
  `e2e/` tree shows the six non-AI mock factories (`createGithubMock`,
  `createCoolifyMock`, `createCloudflareMock`, `createResendMock`, `createSentryMock`,
  `createStorageMock`) are imported by **this file only**; `createAiMock` is used by
  exactly one other test, and there it is the vacuous one (F-601).
- Trigger: Always.
- Impact: 79 lines of test plus 145 lines of mock exist solely to test each other.
- Confidence: Confirmed.
- Suggested fix: Either adopt the mocks in the suites that currently hand-roll the same
  stubs (`publish-execute`, `publish-compensate-resume`, `cron-outcome-bodies` all
  re-implement Coolify/Cloudflare/GitHub doubles inline), or delete `tests/mocks/**` and
  this file together.

### F-605 [LOW] ~355 lines of dead test infrastructure that knip is configured not to see

- Area: N
- Location: `tests/factories/index.ts:1-7`, `tests/factories/user.ts`,
  `tests/factories/workspace.ts`, `tests/factories/project.ts`,
  `tests/factories/checkpoint.ts`, `tests/factories/job.ts`,
  `tests/factories/deployment.ts`, `tests/factories/ids.ts`, `tests/mocks/*` (7 files),
  `tests/register-ts.mjs`, `tests/setup/integration.setup.ts`
  (related: `knip.json:2`)
- What happens: A grep for `from '…/factories…'` across `tests/` and `e2e/` returns four
  hits, and all four import `./factories/plan.ts` (`ensureDefaultPlan` / `createPlan`).
  The barrel `tests/factories/index.ts` and the other six factories are imported by
  nothing. `tests/register-ts.mjs` (a Node ESM loader hook) is referenced by no config,
  script or `package.json` entry. `tests/setup/integration.setup.ts` (3 lines, imports
  `./env` and `./network-guard`) is referenced by nothing — `vitest.config.ts:24` lists
  only `tests/setup/vitest.setup.ts`. `knip.json:2` ignores `tests/**`, `scripts/**` and
  `e2e/**`, so knip — which `verify` runs as a non-fatal report — can never surface any
  of this.
- Trigger: N/A (static).
- Impact: `tests/setup/integration.setup.ts` is the dangerous one: it _looks_ like the
  file that installs the DB redirect and the network guard for the integration suites,
  and a reader who assumes it runs will conclude F-600 is already handled.
- Confidence: Confirmed.
- Suggested fix: Delete the unused factories, the mock pack (or adopt it per F-604),
  `register-ts.mjs`, and `integration.setup.ts`. Narrow `knip.json`'s ignore list to
  `generated/**` and `coverage/**` so test-tree dead code is reported like the rest.

### F-606 [MEDIUM] Parallel test files share one database, and two suites mutate global rows

- Area: N
- Location: `tests/audit-invariants.test.ts:157-189`, `tests/generation-jobs.test.ts:334-338`
  (related: `vitest.config.ts` — no `fileParallelism`/`poolOptions`, so Vitest's default
  parallel file execution applies; `tests/unit/reconcile-test-scope.test.ts:6-11`, which
  already documents this exact hazard for job reapers)
- What happens: Two suites reach outside their own rows in the shared `openlovable_test`
  database:
  - `tests/audit-invariants.test.ts:157-170` selects **every other active ADMIN in the
    database** and sets `isActive: false` on all of them, restoring them in a `finally`
    at `:182-188`. While that window is open, any concurrently-running file whose fixture
    depends on an ADMIN row (`tests/integration/plan-admin-caps.test.ts` creates
    `user_plan_caps_admin`; `tests/unit/…` mock theirs, but the DB integration files do
    not) sees a deactivated admin. A crash between `:170` and `:182` leaves them
    deactivated for the rest of the run.
  - `tests/generation-jobs.test.ts:334-338` upserts the **shared** singleton workspace
    (`WORKSPACE_ROW_ID` = `'default'`) with `update: { creditsUsed: 0, creditAlert80Sent: false }`,
    then measures credit deltas against it at `:339-410`. `tests/integration/publish-execute.test.ts`,
    `publish-compensate-resume.test.ts` and `sentry-runtime-file.test.ts` all use the same
    `DEFAULT_WORKSPACE_ID` row.
    The `tests/*.test.ts` suites are serialized relative to each other (they are `it()`
    blocks inside one file), but they run in parallel with the 24 files under
    `tests/integration/`.
- Trigger: Any run where `legacy-db-suites.test.ts` and an integration file land in
  different workers at the same time — i.e. every CI run.
- Impact: Intermittent, unreproducible failures in whichever file loses the race, on the
  suites that gate credits, admin management and publish. The repo has already been
  bitten by the same class once — `tests/unit/reconcile-test-scope.test.ts` exists
  because unscoped `reconcileAbandonedJobs` was stealing other suites' job rows.
- Confidence: Confirmed for the two writes; **Likely** for the flake (not observed here,
  as no test was run).
- Suggested fix: Give the DB suites per-file workspace and user ids the way the
  integration files already do (`ws_publish_execute`, `user_job_settle`, …), so nothing
  touches `'default'`. For the last-admin case, scope the demotion to a fixture
  workspace instead of `WHERE role = 'ADMIN' AND isActive = true` over the whole table —
  or extend the `reconcile-test-scope` guard idea to a lint that fails any `updateMany`
  in `tests/` with no id/workspace predicate.

### F-607 [LOW] The project-search suite queries the whole test database

- Area: N
- Location: `tests/search.test.ts:60-68` (rows created at `:30-57`, outside the `try`)
- What happens: `searchProjects({ q: 'restaurant', limit: 20 })` is unscoped by owner and
  capped at 20 rows; the assertions are `hits.some(row => row.id === live.id)` and
  `!hits.some(row => row.id === deleted.id)`. If another suite (or a previous crashed run)
  has left ≥20 higher-ranked projects whose prompt matches "restaurant" in
  `openlovable_test`, the seeded row falls off the page and the suite fails for a reason
  that has nothing to do with search. Separately, the `owner`, `live` and `deleted` rows
  are created at `:30-57` _before_ the `try` at `:59`, so a throw in the third create
  leaks the first two.
- Trigger: Row accumulation in the shared test database.
- Impact: Latent flake plus row leakage; both compound F-606.
- Confidence: Confirmed (code read); the flake itself is Likely.
- Suggested fix: Scope the query to the seeded owner, or use a nonce term
  (`restaurant-${suffix}`) so no other row can match. Move the creates inside the `try`.

### F-608 [MEDIUM] `disconnect-does-not-lose-build` silently passes if the function it inspects is renamed

- Area: N
- Location: `tests/unit/disconnect-does-not-lose-build.test.ts:63-69`
  (related: `lib/jobs/lifecycle.ts:375`)
- What happens:
  ```
  const onAbort = source.slice(source.indexOf('function onAbort()'));
  const body = onAbort.slice(0, onAbort.indexOf('\n  }'));
  expect(body).not.toContain('stop()');
  ```
  If `function onAbort()` is renamed or reformatted, `indexOf` returns `-1`,
  `source.slice(-1)` yields a single character, its `indexOf('\n  }')` is `-1`, and
  `body` becomes `''`. `expect('').not.toContain('stop()')` **passes**. The anchor exists
  today (`lib/jobs/lifecycle.ts:375`), so the test is currently doing its job — but its
  failure mode is a green tick, not a red one.
- Trigger: Any rename, arrow-function conversion, or reformat of `onAbort` in
  `lib/jobs/lifecycle.ts`.
- Impact: The regression it guards is a real, documented incident: stopping the heartbeat
  on client abort made a live generation look stale to the reaper and to the workspace.
  Losing this guard silently means the incident can recur unnoticed.
- Confidence: Confirmed.
- Suggested fix: Assert the anchor before slicing (`expect(source).toContain('function onAbort()')`,
  or `expect(source.indexOf('function onAbort()')).toBeGreaterThan(-1)`) — the pattern
  the sibling tests already use. Fifteen other `source.slice(source.indexOf(...))`
  windows across 11 test files were checked and are all protected by a _positive_
  assertion on the window (an empty window fails those); this is the only one whose only
  assertion is negative.

### F-609 [LOW] An ordering assertion that passes when the branch it orders is deleted

- Area: N
- Location: `tests/unit/api-keys-admin-section-gate.test.ts:34-39`
- What happens:
  ```
  const beforeError = loadOrg.indexOf('setError(');
  const beforeLoaded = loadOrg.indexOf('setOrgLoaded(true)');
  expect(beforeError).toBeLessThan(beforeLoaded);
  ```
  If the `setError(` call is removed from `loadOrg`, `beforeError` becomes `-1` and
  `-1 < beforeLoaded` is true — the assertion passes on the exact edit it exists to
  catch ("an early return must skip it", per the comment at `:36`). The window itself is
  protected by the positive `toContain` at `:35`, so only the ordering degrades.
- Trigger: Removing or renaming the error branch in `loadOrg`.
- Impact: Small — the hydration gate itself is still pinned at `:28-30`.
- Confidence: Confirmed.
- Suggested fix: `expect(beforeError).toBeGreaterThan(-1)` before the comparison.

### F-610 [LOW] Five assertions in the assert-style suites cannot fail as written

- Area: N
- Location:
  - `tests/checkpoint-storage.test.ts:54` — `assert(stored!.length < rawJson.length || stored!.length > 0, 'gzip payload is stored')`. `stored` was asserted non-null at `:52` and is a gzip buffer, so the second disjunct is always true; the compression claim in the first is never tested.
  - `tests/seo-audit.test.ts:389-392` — `assert((all.match(/Fix these SEO/i) || all.match(/together/i) || true) && all.length > 40, 'fix-all is one combined instruction')`. The literal `|| true` collapses the whole first clause; only `all.length > 40` survives.
  - `tests/integrations.test.ts:139` — `assert(blob.includes('==') || blob.length > 20, 'secrets blob is encrypted')`. Any plaintext JSON blob is longer than 20 characters, so this passes on unencrypted output. (Lines 140 and 142 do cover the property properly, so the risk is only that this line reads as a second guard.)
  - `tests/preview-devices.test.ts:33` — `assert(byKey.desktop?.width == null && byKey.desktop?.height == null, 'desktop fills available area')`. Optional chaining makes `undefined == null` true, so deleting the `desktop` device entirely leaves this green. Lines 31-32 use `=== 390` and do fail on removal.
  - `tests/skills.test.ts:216-219` — `assert(prefix === buildStablePromptPrefix('NEXTJS','minimal'), 'stable prefix stays byte-identical with or without a skill')`. Both sides are the same call with the same arguments; nothing about "with or without a skill" is exercised. The real property is covered at `:215`.
  - `tests/unit/publish-stacks.test.ts:6-11` — `expect(stack.buildCommand === null || typeof stack.buildCommand === 'string').toBe(true)` restates the declared type. The test's name claims "every stack build command comes from lib/stacks.ts" and never checks a command's content or that publish reads it.
- Area: N
- What happens: as above — each is true regardless of the behaviour it names.
- Trigger: Always.
- Impact: Six review-visible claims backed by nothing. Two of them (`integrations:139`
  on encryption, `checkpoint-storage:54` on gzip) sit on properties that matter.
- Confidence: Confirmed.
- Suggested fix: Drop the always-true disjunct in each case and assert the property
  directly (`stored.length < rawJson.length`; `all` matches one of the two phrases;
  `blob` does not parse as the plaintext JSON; `byKey.desktop` exists and its width is
  `null`; build a prefix with and without a skill and compare those two).

### F-611 [MEDIUM] Conditional skips inside fatal Playwright projects are invisible to the gate

- Area: N
- Location: `e2e/journeys-workflow.spec.ts:368-372`, `e2e/journeys-critical.spec.ts:29-32`,
  `e2e/journeys-stacks.spec.ts:29-32`, `lib/verify/orchestrator.ts:58-65`,
  `playwright.config.ts:88-98`
- What happens: `requirePassingTests` fails a Playwright step only when the reporter
  prints **zero** passing tests for the whole project. A single conditional skip inside a
  project that also has passing tests is undetectable. Two such skips exist on paths the
  gate is supposed to defend:
  - `journeys-workflow.spec.ts:368-372` — `test.skip(missing.length === 0, …)` in
    "POST publish is refused while an integration is missing". On any machine where
    GitHub, Cloudflare and Coolify are all connected (i.e. a fully configured developer
    box, which is the only place publish is exercised at all), the 409-refusal assertion
    silently does not run, and `playwright-authenticated` still ticks green from the
    other journeys in the project.
  - `journeys-critical.spec.ts:29-32` — `test.skip(true, …)` when
    `PLAYWRIGHT_ALLOW_NO_SERVER=1` and the goto threw. That flag is documented and
    explicit, but if it is ever set in an environment file the `critical` project has
    exactly one test, so the whole fatal step reports `1 skipped` — which
    `requirePassingTests` _does_ catch. That half is safe; the workflow one is not.
  - `journeys-stacks.spec.ts:29-32` is an unconditional, honestly-named single skip; the
    `stacks` project is not in `VERIFY_STEPS` at all, so it is only reported, never
    gated.
- Trigger: A developer or CI runner with all three publish integrations connected.
- Impact: The only automated coverage of the publish refusal path — the half of publish
  that is free to test and the half that regresses silently — can disappear without
  turning the gate red.
- Confidence: Confirmed.
- Suggested fix: Extend `assertExecuted` to take an expected minimum pass count per
  project (or parse `N skipped` and fail when it is non-zero for the gated projects), so
  a skip inside a fatal step has to be declared. Alternatively, seed a project whose
  `missingIntegrations` is non-empty by construction rather than depending on the host's
  integration state.

### F-612 [MEDIUM] `pnpm run verify` seeds real accounts — including an ADMIN with a hardcoded password — into the application database

- Area: N
- Location: `e2e/support/account.ts:44` (`LOCAL_ONLY_PASSWORD = 'E2eLocal-Pw9'`),
  `:47-49`, `:76-139`; `e2e/support/seed-account.ts:47-66`, `:86-113`, `:129-135`;
  `e2e/auth.setup.ts:53-71`; `playwright.config.ts:73-93`;
  `lib/verify/orchestrator.ts:130-141`; `e2e/.auth/user.json`, `e2e/.auth/admin.json`
- What happens: The `authenticated` Playwright project — a **fatal** `verify` step — has
  `dependencies: ['setup']`, and `auth.setup.ts` upserts two accounts through Prisma
  into whatever `E2E_DATABASE_URL ?? DATABASE_URL` names. `resolveE2eTarget` explicitly
  _refuses_ the Vitest databases (`e2e/support/account.ts:47`, `:97-102`) — the
  application database is the intended target, by design. On a local host the password is
  the source literal `E2eLocal-Pw9` (`:113`), and one of the two accounts is
  `role: 'ADMIN'` (`seed-account.ts:129-135`). The journeys then create and delete real
  `Project` rows (`e2e/support/projects.ts:38-63`), a real `Template`
  (`seed-account.ts:201-221`), a real abandoned `GenerationJob`
  (`seed-account.ts:160-194`) and a real invited `User` (`journeys-authenticated.spec.ts:135-142`).
  `e2e/.auth/user.json` and `e2e/.auth/admin.json` currently on disk hold live
  `authjs.session-token` JWTs (627 bytes, expiring epoch 1788367865). They are gitignored
  (`e2e/.gitignore:4`) and `git ls-files` confirms they are untracked, so this is a
  local-disk exposure, not a repository leak.
- Trigger: Every `pnpm run verify` and every `git push` (via `.husky/pre-push`).
- Impact: A standing ADMIN account with a password that is a string literal in the
  source tree, in the same database as the developer's real projects. The host guard
  (`LOCAL_HOSTS` at `:49`) includes `host.docker.internal`, so a container whose
  `DATABASE_URL` points at the host database counts as "this machine".
- Confidence: Confirmed.
- Suggested fix: Generate the local password per-machine (write it to a gitignored file
  next to `e2e/.auth/`) rather than shipping a literal, and refuse to seed at all when
  the target database contains rows the E2E fixtures did not create (e.g. more than N
  users) unless `E2E_SEED_ALLOW_DATABASE` names it. Consider making the admin account
  short-lived — created in `setup`, removed in a global teardown.

### F-613 [HIGH] Ten `'use server'` action modules — ~2,100 lines, every one an authorization boundary — are loaded by no test

- Area: N
- Location: `lib/templates/actions.ts` (446 lines), `lib/audit/actions.ts` (364),
  `lib/seo/actions.ts` (346), `lib/memory/actions.ts` (222), `lib/skills/actions.ts` (185),
  `lib/api-keys/actions.ts` (152), `lib/coolify/server-actions.ts` (100),
  `lib/coolify/actions.ts` (95), `lib/projects/stars.ts` (61), `lib/github/actions.ts` (56)
  (related: `proxy.ts:9`, `:147-149`; `tests/unit/api-route-auth.test.ts`;
  `tests/unit/auth-matrix.test.ts`)
- What happens: A transitive import walk from all 194 collected test files plus the 13
  e2e files never reaches any of these modules. Each one begins with `'use server'` and
  each one carries `requireAdmin` / `requireSessionUser` / `canMutate` internally — I
  checked all ten. A Server Action POSTs to the **page** URL with a `Next-Action` header,
  not to `/api`, so `proxy.ts`'s deny-by-default `/api` gate (which
  `tests/unit/api-route-auth.test.ts` exhaustively pins) does not apply; the page matcher
  at `proxy.ts:147` only redirects when there is no session at all. The role and
  ownership check _inside_ each action is therefore the only authorization on those
  paths, and none of it is exercised.
- Trigger: N/A — this is a coverage hole, not a runtime bug.
- Impact: The surfaces with no test behind their gate include: creating/updating/deleting
  templates (admin), running and fixing code and SEO audits (owner/admin mutations),
  creating and rotating **API keys**, adding and removing Coolify servers with encrypted
  tokens, disconnecting GitHub and pushing a project to it, and CRUD over Skills and
  Brain memory. `tests/unit/auth-matrix.test.ts` and `api-route-auth.test.ts` give the
  impression the authorization matrix is fully pinned; it is pinned for routes only.
- Confidence: Confirmed.
- Suggested fix: Add an action-level equivalent of `auth-matrix`: import each exported
  action with `@/lib/auth` mocked to return a MEMBER and then a signed-out caller, and
  assert every export refuses. A source-scan companion (in the style of
  `tests/unit/settings-registry-consumers.test.ts`) that fails when a new `'use server'`
  export appears without a matrix entry would keep it from regressing.

### F-614 [GAP] Fifty-eight `lib/` modules are never loaded by any test

- Area: N
- Location: computed over all 448 non-`.d.ts` files under `lib/` by transitive import
  from every test and e2e file. Beyond the ten action modules in F-613, the ones on paths
  this audit cares about:
  - **Publish credentials / connect flows:** `lib/integrations/github.ts`
    (`convertGithubManifest`, `discoverGithubInstallation`),
    `lib/integrations/cloudflare-connect.ts` (`verifyCloudflareToken`,
    `probeCloudflareDnsEdit`, `connectCloudflareToken`),
    `lib/integrations/coolify-connect.ts` (`discoverCoolify`, `saveCoolifySelection`),
    `lib/integrations/sentry-verify.ts`, `lib/integrations/sentry-restart.ts`,
    `lib/integrations/public.ts`.
  - **Job / credit bookkeeping:** `lib/jobs/boot.ts` (`reconcileJobsAtBoot` — the boot
    reconcile AGENTS.md names as one of four abandon paths), `lib/plans/job-credits.ts`,
    `lib/consumption/record.ts` (`recordJobUsage`), `lib/deploy/record.ts`
    (`recordCurrentRelease`).
  - **Generation context selection:** `lib/context-selector.ts`,
    `lib/edit-intent-analyzer.ts`, `lib/file-parser.ts`, `lib/file-search-executor.ts`,
    `lib/generation/selective-context.ts`, `lib/edit-examples.ts`,
    `lib/generation/apply-page-copy.ts`.
  - **Stacks:** `lib/stacks/routes.ts` — the three-way switch AGENTS.md:41 calls out as
    the source of truth for what stacks exist.
  - **SEO live path:** `lib/seo/live.ts`, `lib/seo/lighthouse.ts` (the only consumer of
    the `lighthouse` runtime dependency).
  - **Operator surfaces:** `lib/health/admin.ts` (`getAdminHealth` — everything
    `/admin/health` renders), `lib/backup/admin.ts`, `lib/team/http.ts`,
    `lib/legal/data-request.ts`, `lib/export/client.ts`, `lib/assets/load-manifest.ts`,
    `lib/visual-edits/format-instruction.ts`, `lib/workspace/sandbox-request.ts`,
    `lib/sentry/client.ts`, `lib/signals/range.ts`, `lib/templates/thumbnails.ts`,
    `lib/templates/summary.ts`, `lib/templates/public.ts`, `lib/templates/http.ts`,
    `lib/templates/schema.ts`, `lib/api-keys/schema.ts`, `lib/audit/scan.ts`,
    `lib/audit/static/index.ts`, `lib/projects/persist-client.ts`,
    `lib/onboarding/examples.ts`, `lib/stack-resolve.ts`, `lib/icons.ts`,
    `lib/email/templates/data-request.ts`, `lib/email/templates/sandbox-credits.ts`,
    `lib/domains/index.ts`, `lib/plans/index.ts`, `lib/coolify/actions.ts`.
- What happens: nothing imports them from a test, so the coverage numbers in
  `vitest.config.ts:48-68` do not describe them at all (v8 reports 0% for a file it never
  loads, which is why the global floor sits at 48%).
- Impact: Mapping to the brief's named critical paths:
  - **Job failure / restart** — well covered (`job-settle`, `job-terminal-race`,
    `job-heartbeat-sql`, `settle-streamed-generation`, `settled-job-never-recovers`,
    `shutdown-drain`, `generation-jobs`). The one hole is `reconcileJobsAtBoot`.
  - **Ownership checks** — covered for routes, absent for Server Actions (F-613).
  - **Git push** — the _personal-OAuth_ push is covered end-to-end against a mock GitHub
    (`tests/github-oauth.test.ts:197-257`). The **GitHub App** deploy client that publish
    actually uses (`lib/github/deploy-client.ts`) is reached only through
    `publish-execute` with injected deps; the App-manifest exchange and installation
    discovery (`lib/integrations/github.ts`) are untested.
  - **Deploy** — `runPublishJob` is covered against real job rows with fake providers
    (`tests/integration/publish-execute.test.ts`, 666 lines). The Coolify and Cloudflare
    _clients_ themselves, and the connect flows that store their encrypted tokens, are
    not.
  - **Image invariants** — well covered (`need-image-never-ships-raw`, `image-worker`,
    `image-debit-failure`, `stock-photo-fallback`, `assets`). Untested:
    `lib/assets/load-manifest.ts` and `lib/templates/thumbnails.ts` (paid generation).
- Confidence: Confirmed (list is mechanical; the per-path commentary is from reading the
  covering tests).
- Suggested fix: Not "test all 58". Take the ten action modules (F-613), plus
  `lib/jobs/boot.ts`, `lib/stacks/routes.ts`, `lib/health/admin.ts` and
  `lib/consumption/record.ts`, and treat the rest as an accepted gap recorded in
  `docs/release.md`.

### F-615 [LOW] `pnpm run verify` gates slightly _more_ than AGENTS.md claims, and the claim about where overrides live is wrong

- Area: N
- Location: `lib/verify/orchestrator.ts:74-167`, `scripts/verify.ts:43-46`,
  `package.json:18`; claim at `AGENTS.md:79`; overrides at `pnpm-workspace.yaml:18-38`
- What happens: The AGENTS.md list is tsc → eslint `--max-warnings 0` → public-route
  allowlist → prisma validate → migrate diff with `--shadow-database-url` → destructive
  detector → vitest `--coverage` → next build → Playwright `critical` → depcheck/knip
  (report) → `pnpm audit --audit-level=high`. Every one of those is present in
  `VERIFY_STEPS` in that order, with the documented `fatal` flags. Two deltas:
  1. `VERIFY_STEPS` also contains `playwright-authenticated` (`:136-141`), fatal, between
     `playwright-critical` and `depcheck`. AGENTS.md does not mention it. Under-claiming,
     not over-claiming.
  2. AGENTS.md:79 says the audit step is fixed "via `pnpm.overrides`" — `package.json`
     has **no** `pnpm` key (verified by parsing it); the overrides live in
     `pnpm-workspace.yaml:18-38`, which is where pnpm 11 reads them. `docs/release.md:58`
     repeats the stale location.
     Two Playwright projects are outside `verify` entirely: `full`
     (`e2e/journeys-full.spec.ts` — the signed-out gate journeys) and `stacks`. They run
     only in `verify:full`, i.e. nightly (`.github/workflows/nightly.yml:58`). A new project
     added to `playwright.config.ts` is likewise ungated by default;
     `tests/unit/test-suites-reachable.test.ts` proves a spec is _collectable_ by some
     project, not that the project is _gated_.
- Confidence: Confirmed.
- Suggested fix: Add `playwright-authenticated` to the AGENTS.md list; correct the
  overrides location in AGENTS.md:79 and `docs/release.md:58`; and add a case to
  `tests/unit/verify-orchestrator.test.ts` asserting that every project name in
  `playwright.config.ts` appears in either `VERIFY_STEPS` or `VERIFY_FULL_EXTRA_STEPS`,
  so a new ungated project is a red test rather than a quiet omission.

### F-616 [LOW] Coverage config points at a deleted directory and the floors were lowered

- Area: N
- Location: `vitest.config.ts:35` and `:48-68`
- What happens: `exclude: ['lib/e2b-backends/**', …]` names a directory that no longer
  exists (the sandbox subsystem was removed; `lib/sandbox` and `lib/e2b-backends` are both
  gone). The thresholds comment at `:49-52` records that statements/lines were
  **recalibrated down** to 48 on 2026-08-19 when that code was deleted. The comment's
  reasoning is sound (deleting well-tested code lowers the ratio without losing a test),
  but the block also still says "Raise, never lower" three times while recording a
  lowering, and the `lib/publish/**` floor at `:64` was likewise re-measured downward on
  the same day.
- Confidence: Confirmed.
- Suggested fix: Drop the dead exclude. When a subsystem is deleted, re-measure once and
  say so in one place rather than leaving three "raise, never lower" notices around two
  recorded lowerings.

### F-617 [LOW] A DB suite permanently mutates `process.env.AUTH_SECRET` for its worker

- Area: N
- Location: `tests/github-oauth.test.ts:24-26`
- What happens: `if (!process.env.AUTH_SECRET && !NEXTAUTH_SECRET && !ENCRYPTION_KEY) { process.env.AUTH_SECRET = '<a 46-char literal, elided here for the staged-secret scanner>' }` — set at module scope with no restore. Every later suite in the same worker inherits it.
  `tests/unit/api-route-auth.test.ts:174-186` does the same thing properly (saves and
  restores in `beforeAll`/`afterAll`), which is the pattern this file should follow.
- Impact: Small today (the condition rarely fires, and the legacy DB suites run in one
  file). It is the kind of leak that makes a later auth test pass or fail depending on
  execution order.
- Confidence: Confirmed.
- Suggested fix: Save and restore, as `api-route-auth` does.

### F-618 [LOW] `allowHost` mutates the network allowlist for the rest of the worker with no reset

- Area: N
- Location: `tests/setup/network-guard.ts:1` (`ALLOWED_HOSTS`), `:85-92`,
  `tests/setup/vitest.setup.ts:5-7`
- What happens: `revokeLocalhost()` runs in `afterEach`, but `allowHost()` adds to a
  module-level `Set` that is never cleared. A test that allowlists a host leaks that
  allowance to every later test in the same worker process. No production test currently
  calls `allowHost` (only `tests/unit/network-guard.test.ts:52-53`, and only to assert it
  _rejects_ loopback), so this is latent.
- Confidence: Confirmed.
- Suggested fix: Snapshot and restore `ALLOWED_HOSTS` in the same `afterEach` that calls
  `revokeLocalhost`, or make `allowHost` require a reason and auto-revoke like
  `allowLocalhost` does.

### F-619 [LOW] The timezone half of `formatRelativeTime` cannot fail

- Area: N
- Location: `tests/unit/format-relative-time.test.ts:18-31`
- What happens: The test sets `process.env.TZ` between two calls and asserts
  `west === east`. `formatRelativeTime(value, snapshot)` computes a delta between two
  epoch numbers, which is timezone-independent by construction, so the equality holds
  regardless of whether the `TZ` assignment took effect. The second assertion
  (`west === '28 minutes ago'`) is real.
- Impact: The test name promises timezone stability and proves arithmetic.
- Confidence: Confirmed.
- Suggested fix: Either delete the TZ manipulation (the property is structural) or move
  the test to a formatter that genuinely reads the zone (`formatAdminDateTime`, which
  `tests/unit/format-admin-date.test.ts:12-29` already covers correctly by comparing
  `en-US` against `en-GB`).

### F-620 [HIGH] Both fatal Playwright steps can validate a different git worktree's dev server

- Area: N
- Location: `playwright.config.ts:7` (`baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3000'`),
  `:48-71` (`reuseExistingServer: true`), `lib/verify/orchestrator.ts:123-141`
  (related: `AGENTS.md:26-28`)
- What happens: `verify` runs `playwright test --project=critical` and
  `--project=authenticated`, both fatal. Playwright probes `baseURL` first and, because
  `reuseExistingServer: true`, uses whatever answers on `:3000` instead of spawning
  `next dev`. AGENTS.md:26-28 states that on this repo's setup `:3000` is the
  **`.worktrees/main`** checkout and the primary checkout (`ai-genration-improvements`)
  runs on `:3001`. Both servers share one Postgres and one `public/uploads`. So running
  `pnpm run verify` from the primary checkout drives its browser assertions against
  `main`'s code.
- Trigger: Any `verify` or `git push` from a checkout that is not the one serving
  `:3000`, with no `PLAYWRIGHT_BASE_URL` set.
- Impact: This is the exact failure the config's own comment at `:55-65` says it exists
  to prevent ("a gate that validates stale output is worse than one that refuses to run,
  because it reports green about code it never served"). Switching `next start` to
  `next dev` fixed the _staleness_ half; the _wrong-checkout_ half is still open, and it
  is worse — the served code is not merely old, it is from another branch. In CI nothing
  listens on `:3000`, so CI is unaffected; this is a local-gate and pre-push defect.
- Confidence: Confirmed (config read; the two-tree/two-port arrangement is stated in
  AGENTS.md and both worktrees exist on disk).
- Suggested fix: Have the config assert the server it reused is _this_ checkout before
  running — e.g. probe a build-identity endpoint (`/api/health` already returns
  `version`; extend it with the git SHA from `lib/deploy/release.ts`, which
  `getSelfIdentity` already exposes) and fail fast when it does not match
  `currentRelease().sha`. Failing with "the server on :3000 is serving a different
  checkout — set PLAYWRIGHT_BASE_URL" is strictly better than a green tick.

---

## Section O — cross-cutting

### F-630 [HIGH] The Sentry scrubber never touches the error message, the exception, the tags, or the user

- Area: O
- Location: `lib/sentry/scrub.ts:47-86`; wired at `lib/observability/noise.ts:157` and
  `lib/sentry/options.ts:47` (related: `tests/sentry-scrub.test.ts:56-92`)
- What happens: `sentryBeforeSend` scrubs exactly four things — `event.request`
  (url, query_string, headers, data, cookies), `event.extra`, `event.contexts` and
  `event.breadcrumbs[].data`. It does not read `event.message`,
  `event.exception.values[].value`, `event.exception.values[].stacktrace`, `event.tags`
  or `event.user`. For an unhandled exception those are where the payload actually lives:
  a thrown `Error` whose message embeds a URL with a query token, an `Authorization`
  header echoed back by a provider, or a connection string, is sent to Sentry verbatim.
  Two secondary gaps in the same file: `scrubQuery` (`:5-10`) only rewrites `?k=v`
  parameters, so credentials in the userinfo position (`https://user:pass@host/`) survive
  a URL scrub; and `scrubValue` (`:15`) applies `scrubQuery` only when the _key_ is
  literally `url`, `query_string` or `referrer`, so a `redirectUrl` or `endpoint` field
  is passed through.
- Trigger: Any captured exception whose message or type name carries a secret. The repo
  has already met one: the lessons-learned entry for 2026-08-18 records E2B replying
  "Unauthorized … authorization header is missing" — provider errors that quote request
  material are the norm, not the exception.
- Impact: Secrets reach a third-party service. Audit-map invariant 13 ("Secrets — never
  logged, never returned to a client") is not enforced on the error-reporting path.
- Confidence: Confirmed. `tests/sentry-scrub.test.ts` builds an event with `request` and
  `extra` only (`:29-54`) and never asserts anything about `message`, `exception`, `tags`
  or `user`, so the gap is uncovered as well as unhandled.
- Suggested fix: Run `event.message`, every `exception.values[].value`, and `event.tags`
  through a text redactor (the same key regex plus a URL/bearer/PEM pattern), and set
  `event.user` to `{ id }` only. Extend `tests/sentry-scrub.test.ts` with an event whose
  secret is in `exception.values[0].value` — today that test would pass with the
  scrubber removed from those fields entirely.

### F-631 [HIGH] A failed Sentry API call is reported as a healthy, quiet project

- Area: O
- Location: `lib/observability/sentry-api.ts:40`, `:41-43`, `:44`, `:82`; consequences at
  `lib/observability/quota.ts:52-74`
- What happens: `getProjectStats()` fires three requests in `Promise.all` and swallows
  each one:
  - stats → `.catch(() => null)` → `groups = []` → `accepted = 0`, `dropped = []`
  - issues → `.catch(() => [])` → `topIssues = []`
  - projectInfo → `.catch(() => null)` → `quotaLimit = 0` → `quota = { used: 0, limit: Math.max(0, 1) = 1 }`
    `findIssueByFingerprint` does the same at `:82` and returns `null`.
    In `quota.ts` that produces: `quotaRatio = 0 / 1 = 0` → **no quota warning is possible,
    ever**; `stats.dropped = []` → **no dropped-events warning**; and
    `issue === null` → `lastSeenMs = NaN` → `receiptStale = true`, so if any local
    heartbeat succeeded in the last 24 h the run sends a **heartbeat-mismatch** email — an
    alert that tells the operator "events are not reaching Sentry" when what actually
    happened is "we could not call the Sentry API". Nothing anywhere logs the HTTP failure.
- Trigger: Revoked or expired Sentry auth token, wrong org/project slug, Sentry outage,
  or any network failure from the app to `sentry.io` — on the daily
  `POST /api/cron/observability-quota`.
- Impact: The subsystem whose entire job is to notice that error reporting has gone dark
  reports "0 events, 0 dropped, quota 0 of 1" — indistinguishable from a healthy, quiet
  project — and misattributes the one alert it does raise. This is a direct repeat of the
  documented lesson "`[]` / `{}` / `false` is not 'nothing happened'", in the code that
  exists to catch exactly that.
- Confidence: Confirmed. Also confirmed uncovered: every test injects a working
  `sentryApi` double (`tests/unit/observability.test.ts:144-155`, `:183-195`, `:216-234`;
  `tests/unit/sentry-integration.test.ts:251-262`), so `createSentryApi` — the function
  containing the catches — is never executed by the suite.
- Suggested fix: Let `sentryGet` reject. Catch once, in `getProjectStats`, and return a
  discriminated result (`{ ok: false, error }`) so `runObservabilityQuotaCheck` can
  record `ObservabilityCheck{ kind: 'quota', ok: false, detail: 'sentry API unreachable: …' }`
  and return `ok: false` — which `handleCron` already turns into a 500 and a failed
  `CronRun`. Do not send the mismatch email on a path where the API call itself failed.

### F-632 [MEDIUM] `droppedWarning` is computed, stored, and never alerts anyone

- Area: O
- Location: `lib/observability/quota.ts:65-67`, `:69-74`, `:76-90`, `:92-99`
- What happens: `droppedWarning` is true when Sentry reports events dropped to
  `rate_limit` / `rate_limited` / `quota`. It is written into the `detail` JSON at `:85`
  and returned at `:97` — and that is all. Only `mismatch` and `quotaWarning` send mail
  (`:69-74`), and `ok` at `:78` is `!mismatch && !quotaWarning`, so a project actively
  dropping errors records `CronRun{ ok: true }` and emails nobody.
- Trigger: Sentry rate-limiting or quota-dropping the project's events while the quota
  _ratio_ is still under 80% (e.g. an inbound filter or a per-key rate limit).
- Impact: Errors are being discarded and the daily check says everything is fine. The
  quota-warning email at `:73` already carries `topIssues`, so the plumbing to say so
  exists.
- Confidence: Confirmed. `tests/unit/observability.test.ts:216-238` feeds
  `dropped: [{ reason: 'rate_limit', count: 2 }]` and asserts only `result.quotaWarning`
  — it never asserts that the dropped events produced an alert.
- Suggested fix: Include `droppedWarning` in the `ok` computation and in the alert
  branch; add the drop reasons and counts to the quota email body.

### F-633 [MEDIUM] The structured logger has no redaction, and the test named `logger-scrub` tests none

- Area: O
- Location: `lib/logger.ts:17-29`, `:40-45`, `:54-57`; `tests/logger-scrub.test.ts:1-69`
- What happens: `formatLogLine` spreads arbitrary caller fields into a `JSON.stringify`
  and writes them to stdout/stderr. There is no key filter, no value pattern, no length
  cap. `logError` (`:54-57`) puts the raw `error.message` into the line. The file named
  `tests/logger-scrub.test.ts` asserts the _shape_ of a log line (level, event, ALS
  request/user/workspace ids, one-line-ness) and contains no scrubbing assertion at all —
  the name is the only thing suggesting redaction exists.
- Trigger: Any `log.*`/`logError` call whose fields carry a token, a connection string,
  or a provider error message that quotes an `Authorization` header. Today no call site
  passes an obviously named secret field (I grepped `lib/` and `app/` for
  `token|apiKey|secret|password|dsn|key` inside a `log`/`logError` argument and found
  none), so this is a missing guard rather than an active leak.
- Impact: Application logs are the one destination with **no** scrubber, while Sentry
  (`lib/sentry/scrub.ts`) and the audit log (`lib/audit/log.ts:104-105`, which calls
  `scrubSensitive`) both have one. On Coolify those logs are collected and retained.
- Confidence: Confirmed (no active leak found; the guard is absent).
- Suggested fix: Run the fields object through the existing `scrubSensitive` in
  `formatLogLine`, and rename `tests/logger-scrub.test.ts` to match what it tests (or add
  the missing scrub cases to it). One shared redactor for logs, audit and Sentry.

### F-634 [LOW] A logging call that swallows its own failure, in the module that once wrote the wrong file

- Area: O
- Location: `lib/observability/migrate-env.ts:32`
- What happens: `void import('../logger').then(({ log: logger }) => logger.info(event, extra)).catch(() => undefined);`
  — fire-and-forget plus a bare swallow, in the exact module whose swallowed second write
  caused the 2026-08-18 `.data/config/observability.json` incident. It is the only
  `void …catch(() => undefined)` left in `lib/observability/**`, `lib/sentry/**`,
  `lib/logger.ts`, `lib/audit/log.ts`, `lib/request-context.ts`, `lib/request-id.ts`,
  `lib/api/error-response.ts`, `lib/api/with-request.ts` and `lib/notify.ts` — everything
  else in those files is clean.
- Impact: Small (it is a log line, not a write), but it is the pattern the lessons file
  explicitly rules out: "detached must still mean logged with the project id and the task
  name."
- Confidence: Confirmed.
- Suggested fix: `await` it (the caller is async) or fall back to `console.info` in the
  catch rather than discarding.

### F-635 [MEDIUM] `.npmrc` disables the build allowlist that `pnpm-workspace.yaml` carefully maintains

- Area: O
- Location: `.npmrc:1` (`dangerouslyAllowAllBuilds=true`) vs `pnpm-workspace.yaml:1-11`
  (`allowBuilds:` naming eleven packages)
- What happens: `pnpm-workspace.yaml` lists exactly which dependencies may run install
  scripts — `@prisma/client`, `@prisma/engines`, `@sentry/cli`, `cbor-extract`, `esbuild`,
  `msw`, `prisma`, `protobufjs`, `sharp`, `unrs-resolver`. `.npmrc` then sets
  `dangerouslyAllowAllBuilds=true`, which grants postinstall/preinstall execution to
  **every** package in the tree, transitively. The allowlist becomes documentation.
- Trigger: `pnpm install` — including the `pnpm install --frozen-lockfile` in both CI
  workflows.
- Impact: Supply-chain exposure. A compromised transitive dependency runs arbitrary code
  on the CI runner (which has the repo checkout and the workflow env, including
  `ENCRYPTION_KEY` and `AUTH_SECRET` values) and on every developer machine. The
  allowlist mechanism exists precisely to stop this and is switched off one file over.
- Confidence: Confirmed.
- Suggested fix: Delete `.npmrc:1`. If a build was failing without it, add that package
  to `allowBuilds` by name and record why.

### F-636 [MEDIUM] Ten unused runtime dependencies, and two animation libraries shipped side by side

- Area: O
- Location: `package.json:30-107`; verified against every `.ts/.tsx/.mjs/.js/.json` file
  outside `node_modules`/`.next`/`generated`/worktrees
- What happens: The following `dependencies` appear nowhere in the tree except
  `package.json` itself:
  `@tabler/icons-react` (:65), `cors` (:77), `tailwindcss-animate` (:104),
  `@radix-ui/react-aspect-ratio` (:39), `@radix-ui/react-avatar` (:40),
  `@radix-ui/react-checkbox` (:41), `@radix-ui/react-hover-card` (:46),
  `@radix-ui/react-menubar` (:48), `@radix-ui/react-radio-group` (:52),
  `@radix-ui/react-toast` (:60), `@radix-ui/react-toggle` (:61),
  `@radix-ui/react-toggle-group` (:62).
  Separately, **both** `framer-motion` (:81) and `motion` (:88) are installed and both
  are imported — `motion` by 14 files under `components/app/(home)/sections/**`,
  `framer-motion` by many more. `motion` v12 and `framer-motion` v12 are the same
  codebase under two names; shipping both means two copies of the animation runtime in
  the client bundle.
  `lodash-es` (:86) has exactly one consumer, `utils/init-canvas.ts:1`.
  `lighthouse` (:85) is a `dependency`, not a devDependency, for one server-side consumer
  (`lib/seo/lighthouse.ts`) — it drags in chrome-launcher and a Chrome/puppeteer stack on
  every `pnpm install` and into the production image.
- Trigger: N/A (install/bundle weight).
- Impact: Install time, image size, and audit surface — every one of these is a package
  `pnpm audit` has to consider and a maintainer has to patch. `depcheck` runs in `verify`
  (`lib/verify/orchestrator.ts:143-147`) with `fatal: false`, so this list has presumably
  been printed on every run and acted on never.
- Confidence: Confirmed.
- Suggested fix: Remove the twelve unused packages; pick one of `motion` /
  `framer-motion` and codemod the imports; move `lighthouse` behind a lazy
  `await import()` in `lib/seo/lighthouse.ts` and mark it optional, or accept it and say
  so. Then make `depcheck` fatal with an explicit ignore list, so the report has teeth.

### F-637 [MEDIUM] Two `cn()` helpers with different semantics; the 121-file majority is the one that does not merge Tailwind classes

- Area: O
- Location: `utils/cn.ts:1-5` (classnames only) and `lib/utils.ts:1-6`
  (`twMerge(clsx(inputs))`)
- What happens: Both export a function called `cn`. `lib/utils.ts` resolves conflicting
  Tailwind utilities (`twMerge`); `utils/cn.ts` just concatenates. **121 files import
  `@/utils/cn` and 10 import `@/lib/utils`** — and the 121 include every shadcn primitive
  (`components/ui/shadcn/button.tsx:3`, `dialog.tsx:7`, `select.tsx:6`, …), which are
  written on the assumption that a caller's `className` overrides the variant's. With the
  non-merging helper, `<Button className="px-2">` emits `px-4 px-2` and the winner is
  decided by CSS source order, not by the caller.
- Trigger: Any component that passes an overriding Tailwind class to a shadcn primitive.
- Impact: Silent, hard-to-diagnose styling bugs; the standard shadcn idiom does not work.
  Two same-named helpers is also exactly the "duplicated logic that has drifted between
  copies" the audit brief asks about.
- Confidence: Confirmed (counts computed over the tree; three shadcn files read).
- Suggested fix: Make `utils/cn.ts` re-export the `twMerge` version (one line), verify
  nothing depended on the non-merging behaviour, then delete the duplicate and the
  `classnames` dependency.

### F-638 [LOW] The documented `tar` / `deepmerge-ts` audit finding: half of it is now obsolete

- Area: O
- Location: `pnpm-workspace.yaml:19-20`; `pnpm-lock.yaml`; `.cursor/lessons-learned.md`
  entry "[2026-08-18] — Audit highs"
- What happens: The lessons entry records a **critical** `tar@7.4.3` reaching the tree via
  `@e2b/code-interpreter > e2b > tar`, fixed with an override to `^7.5.19`, and a **high**
  `deepmerge-ts@7.1.5` via `@prisma/config`, fixed with `^8.0.0`. Checking the current
  lockfile:
  - `tar` **no longer appears at all** — `@e2b/*` is gone with the sandbox subsystem, and
    no other package pulls it. The `tar: ^7.5.19` override at `pnpm-workspace.yaml:19` is
    now a no-op.
  - `deepmerge-ts@8.0.1` is resolved. That half still holds and is still needed.
    Same-major pins for `minimatch@3/9/10`, `glob@10/11`, `nanoid@3/5` and
    `brace-expansion@1/2` are all present and resolving. Two versions in the tree are
    **not** pinned by any override — `minimatch@5.1.9` and `minimatch@7.4.9` — and
    `glob@13.0.6` is present without a `glob@13` entry.
- Confidence: Confirmed from the lockfile. Whether the unpinned versions carry advisories
  is **Needs check** — `pnpm audit` was not run (it needs an install, and `:3000` is up).
- Suggested fix: Drop the dead `tar` override, add `minimatch@5` / `minimatch@7` /
  `glob@13` entries if the next `pnpm audit` flags them, and correct the two docs that
  say the overrides live in `package.json` (AGENTS.md:79, `docs/release.md:58`).

### F-639 [MEDIUM] The full Prism syntax highlighter is statically imported into the workspace client bundle

- Area: O
- Location: `components/workspace/StreamingCodePanel.tsx:4-5`
- What happens:
  ```
  import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
  import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
  ```
  Importing `Prism` from the package root pulls **every** refractor language grammar and
  the full theme set — the well-known ~1 MB-plus variant. The alternative the package
  ships for exactly this reason (`PrismLight` + `registerLanguage` for the handful of
  languages the panel renders) is not used, and the component is a plain static import in
  a `'use client'` file that is part of the `/project/[id]` graph — no `next/dynamic`, no
  lazy boundary.
- Trigger: Every first load of the workspace route.
- Impact: This is the single largest avoidable item in the studio route's client bundle.
- Confidence: Confirmed (import read; `react-syntax-highlighter` confirmed present in the
  `/project/[id]` module graph).
- Suggested fix: Switch to `PrismLight`, register `tsx/ts/jsx/js/json/css/html`, and wrap
  the panel in `next/dynamic({ ssr: false })` so it loads when the Code view is first
  opened rather than on workspace mount.

### F-640 [MEDIUM] `esbuild-wasm` is in the workspace route's initial client graph

- Area: O
- Location: `lib/preview/bundle.ts:1` (`import * as esbuild from 'esbuild-wasm'`),
  imported by `components/workspace/BrowserPreview.tsx:20`
- What happens: The wasm binary itself is fetched lazily from
  `/preview-vendor/esbuild.wasm` (`lib/preview/bundle.ts:12`, `:32-38`), which is right.
  But the **JS wrapper** is a static top-level import in a module that a `'use client'`
  component imports statically, so it is in the workspace route's first client chunk even
  for a user who never opens the preview.
- Trigger: Every first load of `/project/[id]`.
- Impact: Adds the esbuild JS API surface to the initial payload, on top of F-639.
- Confidence: Confirmed.
- Suggested fix: Move the `esbuild-wasm` import inside `ensureEsbuild()` as
  `await import('esbuild-wasm')`, so the wrapper is fetched at the same moment as the
  wasm it drives.

### F-641 [MEDIUM] The workspace client root is 2,282 lines with one `useMemo`, no `useCallback`, and no `memo`

- Area: O
- Location: `components/workspace/GenerationWorkspace.tsx` (whole file)
- What happens: Counts over the file: **2,282 lines, 40 `useState`, 11 `useEffect`,
  10 `useRef`, 1 `useMemo`, 0 `useCallback`, 0 `memo(`**. The `/project/[id]` module graph
  contains **50 `'use client'` components**, of which this is the root; the next largest
  are `WorkspaceTopBar` (660), `ProjectWorkspace` (576), `BrowserPreview` (565),
  `BrainPanel` (500), `PublishPanel` (498). Every SSE frame during a generation sets state
  in this component, which re-creates every inline handler and object prop and re-renders
  the entire child tree, because nothing below it is memoised either.
- Trigger: Streaming a build — the highest-frequency state update in the product, and the
  moment the UI most needs to stay responsive.
- Impact: This is the "unmemoised heavy renders during streaming" the brief asks about,
  and it compounds F-642: the preview's `assemblePreview` + `JSON.stringify` work is
  driven off props that change identity on every render.
- Confidence: Confirmed (mechanical counts; `.cursor/lessons-learned.md` for 2026-08-17
  explicitly says "do not rewrite `components/workspace/GenerationWorkspace.tsx` to
  reorder functions", so a full rewrite is out of scope — but memoising the props it
  hands down is not).
- Suggested fix: Do not rewrite the component. Wrap the leaf panels that re-render per
  frame (`StreamingCodePanel`, `BrowserPreview`, `ChatPanel`, `WorkspaceTopBar`) in
  `React.memo`, and `useCallback` the handlers passed to them. Measure with the React
  profiler during a real stream before and after; the win should be visible on the
  file-per-second cadence.

### F-642 [MEDIUM] The preview serialises the entire assembled project once per streamed file

- Area: O
- Location: `components/workspace/BrowserPreview.tsx:230-246`
- What happens: `compilable` (`:230-237`) merges the streaming file set into the stored
  files on every change; `assembly = useMemo(() => assemblePreview(stack, compilable), [stack, compilable])`
  (`:239`) rebuilds the whole assembly whenever that merge produces a new object; and
  `target = useMemo(() => ({ key: JSON.stringify(assembly), assembly }), [assembly])`
  (`:243-246`) then `JSON.stringify`s the complete project source to derive a cache key.
  During a generation, `streamFiles` changes on every completed file, so this runs once
  per file — on the main thread, alongside the streaming UI.
- Trigger: Any build that writes more than a handful of files. The chat-indicator test
  (`tests/unit/chat-building-indicator.test.ts:4-8`) documents a real run that wrote 21
  files in 90 seconds.
- Impact: O(project size) serialisation per file, on the same thread as the frames that
  are supposed to show progress. The file's own comment at `:241` says esbuild is too
  slow to run per keystroke — the key derivation has the same problem in miniature.
- Confidence: Confirmed (code read; memoisation is present but keyed on a value that
  changes per file, so it does not help here).
- Suggested fix: Derive the cache key from a cheap stable hash over `path + content.length`
  (or a running FNV/xxhash of the contents) instead of `JSON.stringify` of the whole
  assembly, and debounce `compilable` with the existing `DEFAULT_SETTLE_MS` (`:66`) so
  the assembly is rebuilt on the settle boundary rather than on every file.

### F-643 [LOW] The 2-second job poll costs three to four database round trips per viewer

- Area: O
- Location: `app/api/projects/[id]/job/route.ts:13-27`; poll cadence from
  `lib/jobs/poll.ts` (`nextPollIntervalMs(30_000) === 2_000`, pinned at
  `tests/generation-jobs.test.ts:80-81`); `lib/auth.ts:16-33`;
  `app/api/projects/[id]/presence/route.ts:38-56`
- What happens: Each poll does `getSessionUser()` — which is a `prisma.user.findUnique`
  with no cache (`lib/auth.ts:21-24`) — then `prisma.project.findFirst` for an existence
  check (`:16-19`), then `getActiveJob(id)` and, when there is no active job,
  `getLatestJob(id)`. That is 3-4 queries every 2 seconds per open workspace for the first
  two minutes of a build, then every 10 seconds. The `project.findFirst` is redundant:
  `getActiveJob`/`getLatestJob` are already scoped by `projectId` and return `null` for a
  project that does not exist. `POST /api/projects/[id]/presence` (every 30 s) repeats the
  same session read plus `loadProject`, `heartbeatPresence` and `getPresenceSnapshot`.
- Trigger: Any open workspace; multiplied by viewers.
- Impact: Modest at current scale, but these are the two highest-frequency endpoints in
  the product and roughly half of each request's database work is a redundant existence
  or session re-read.
- Confidence: Confirmed.
- Suggested fix: Drop the `project.findFirst` in the job route and map a `null` job to
  `{ job: null }` (a 404 for a non-existent project is not information the poller uses).
  Consider a short (2-5 s) request-scoped cache for `getSessionUser` — it is already
  called once per request by `withRequest`, and the deactivated-user check does not need
  to be re-read four times in the same eight seconds.

### F-644 [MEDIUM] Three conflicting operator instructions for the restore command, and a test pins the one the repo forbids

- Area: O
- Location: `lib/backup/copy.ts:8` (`pnpm exec tsx scripts/restore-db.ts --key …`),
  `tests/unit/admin-ui-conventions.test.ts:40-44`, `scripts/restore-db.ts:3-4`
  (`npx tsx …`), `AGENTS.md:72` (`npx tsx scripts/restore-db.ts --key …`),
  `docs/release.md:56`, `:144-146`, `:215`, `.husky/pre-commit:2-3`, `.husky/pre-push:2-9`
- What happens: The repo's stated rule — in the lessons file, in both git hooks, and in
  `docs/release.md:144-146` — is that `pnpm exec` must never be used here because pnpm's
  dependency-status check can purge `node_modules` before running anything. Yet:
  - `/admin/backups` shows the operator `pnpm exec tsx scripts/restore-db.ts --key …`
    (`lib/backup/copy.ts:8`);
  - `tests/unit/admin-ui-conventions.test.ts:42-43` **asserts** that string and asserts
    it does **not** contain `npx` — locking in the forbidden form and forbidding the form
    AGENTS.md recommends;
  - `scripts/restore-db.ts:3-4` and `AGENTS.md:72` say `npx tsx`;
  - `scripts/rollback.ts:5-6` and `docs/release.md:215` say `pnpm exec tsx`.
- Trigger: A disaster-recovery restore — the moment when following the on-screen
  instruction matters most and when losing `node_modules` mid-command is least welcome.
- Impact: The operator is given, on the admin screen, a command the project's own rules
  say can destroy the dependency tree it is about to run from. `npx` is separately called
  out in the same test's doc comment (`:12-13`) as having "corrupted
  pnpm-workspace.yaml", so both documented options are considered unsafe and no safe one
  is offered.
- Confidence: Confirmed.
- Suggested fix: Standardise on the form the hooks and `verify` already use —
  `node ./node_modules/tsx/dist/cli.mjs scripts/restore-db.ts --key …` — in
  `lib/backup/copy.ts`, `scripts/restore-db.ts`, `scripts/rollback.ts`, AGENTS.md:72 and
  `docs/release.md:215`, and flip the assertion in
  `tests/unit/admin-ui-conventions.test.ts` to forbid both `pnpm exec` and `npx`.

### F-645 [LOW] `depcheck` and `knip` are reported and enforced never, and knip is blind to half the tree

- Area: O
- Location: `lib/verify/orchestrator.ts:142-157`, `knip.json:2-3`; no `.depcheckrc` exists
- What happens: Both steps are `fatal: false`. `knip.json:2` additionally ignores
  `generated/**`, `e2e/**`, `tests/**`, `scripts/**` and `coverage/**`. So the twelve
  unused runtime dependencies in F-636 and the ~355 lines of dead test infrastructure in
  F-605 are, respectively, printed on every run and invisible on every run. The comment
  at `:149-152` records that knip's `--no-exit-code` was removed on 2026-08-19 so the tick
  reflects reality — which is an improvement, but the step still cannot block.
- Confidence: Confirmed.
- Suggested fix: Give depcheck an explicit ignore list for the packages that are genuinely
  config-only (`autoprefixer`, `@tailwindcss/typography`, `postcss-*`, `@prisma/client`)
  and make it fatal; narrow `knip.json`'s ignore to `generated/**` and `coverage/**`. A
  report nobody has to act on is the same shape as a test that cannot fail.

### F-646 [LOW] `@ts-nocheck` on a whole file, and three `@ts-expect-error` suppressions

- Area: O
- Location: `components/shared/pixi/utils.ts:1-2` (`// @ts-nocheck -- TODO: fix this`),
  `components/app/(home)/sections/hero/Pixi/tickers/ascii.ts:132`,
  `components/shared/buttons/slate-button.tsx:93` and `:106`
- What happens: `components/shared/pixi/utils.ts` (60 lines) is excluded from typechecking
  entirely, with an eslint-disable on the line above to allow the ban-ts-comment. It
  handles WebGL context-loss detection and texture generation for the home hero — the
  `isDestroyed` guard at `:6-11` reaches four levels into the renderer with no type
  checking. The three `@ts-expect-error`s are narrow and each carries a reason.
- Impact: `verify`'s `tsc --noEmit` step reports green over this file. Combined with
  `pixi.js` being a client dependency of the public home page, a runtime type error here
  is a blank hero for every anonymous visitor.
- Confidence: Confirmed.
- Suggested fix: Type the four accesses in `isDestroyed` and `generateTexture` against
  pixi's own types (or one narrow local interface) and remove the file-level suppression.

---

## GAPS

### F-660 [GAP] No test covers `reconcileJobsAtBoot`

`lib/jobs/boot.ts` is one of the four documented paths that abandon a job (boot reconcile,
alongside the reaper, the SIGTERM drain and the client watchdog). The other three have
tests (`tests/integration/job-terminal-race.test.ts`, `tests/generation-jobs.test.ts`,
`tests/unit/shutdown-drain.test.ts`). This one is loaded by nothing.

### F-661 [GAP] No test drives the real Coolify, Cloudflare or GitHub-App clients

`tests/integration/publish-execute.test.ts` (666 lines) exercises `runPublishJob`
thoroughly, but always with `PublishDeps` injected. `lib/coolify/client.ts`,
`lib/cloudflare/dns.ts` and `lib/github/deploy-client.ts` are reached only as type
imports. Their request shaping, error mapping and retry behaviour are covered by nothing —
including `isRetryableProviderError`'s interaction with the real error objects those
clients throw. `tests/publish-jobs.test.ts:277-298` tests the retry helper against a
hand-made `FakeHttpError` instead.

### F-662 [GAP] No coverage of the client/server bundle contract for the workspace route

`tests/unit/client-import-boundary.test.ts` (365 lines) proves no `'use client'` graph
reaches a Node builtin or a server-only module — a real and valuable guard. Nothing
asserts anything about **size**: there is no budget on the `/project/[id]` first-load JS,
so F-639 and F-640 could double the bundle and every gate would stay green.
`lib/audit/bundle.ts` already knows how to turn asset sizes into findings for
_generated_ projects; the same thresholds are not applied to Navroop itself.

### F-663 [GAP] No test asserts that a secret cannot reach the application log

`tests/sentry-scrub.test.ts` covers the Sentry path and `tests/audit-invariants.test.ts:90-116`
covers the audit-log path (it writes `apiKey`/`password`/`token`/`secret` into an audit
entry and asserts none of them appear in the stored row — a good test). There is no
equivalent for `lib/logger.ts`, which is the gap F-633 describes.

### F-664 [GAP] `duplicateProject` produces an empty project, by design, with no test

`lib/projects/actions.ts:467` — `// TODO: does not copy sandbox/generated code.` The
action copies `name`, `initialPrompt`, `stack` and `designDirection` and nothing else, so
"Duplicate" on a finished site yields a blank project. There is no test for
`duplicateProject` at all, and the UI does not warn. Either copy the latest checkpoint or
rename the action.

### F-665 [GAP] Two other real `TODO`s in shipped paths

- `lib/projects/plan.ts:625` — "set phase COMPLETE when generation reports a clean
  completion signal". Approve returns `phase: 'BUILDING'` and relies on
  `persistProjectGeneration` mapping `generationStatus: 'ready'` → COMPLETE. The
  resumable-phase machinery (`resumablePhaseFromEvidence`) papers over this, but the
  approve path itself has no completion transition.
- `lib/team/actions.ts:73` — "email invites are out of scope (self-serve registration)".
  In an invite-only product the temporary password shown once in the dialog
  (`e2e/journeys-authenticated.spec.ts:176-181`) is the entire handover; if the admin
  loses it the invitee is stranded until a reset link is issued.
- Three UI affordances are labelled "coming soon" and do nothing:
  `components/workspace/ChatInput.tsx:98` (attachments — with a second TODO at `:108`
  "wire existing attachments when an upload path exists"), `:139`/`:143` (voice input),
  and `components/workspace/ChatPanel.tsx:218`.

Repo-wide, that is the **complete** list of `TODO`/`FIXME`/`HACK`/`XXX` markers outside
`docs/`, `.cursor/` and `audit/` — the source tree is otherwise free of them.

---

## IMPROVEMENTS

### F-680 [IMPROVEMENT] Give `requirePassingTests` a per-project expected minimum

`lib/verify/orchestrator.ts:58-65` catches "the whole project ran nothing". Adding an
expected minimum pass count per Playwright step (or failing on any non-zero `N skipped`
in a gated project) would close F-611 and would have caught the conditional publish skip
the day it was added.

### F-681 [IMPROVEMENT] Add an anti-vacuity lint for the legacy assert helpers

Every `tests/*.test.ts` suite defines the same `assert(cond, name)` and tallies. A tiny
guard test — in the style of `tests/unit/reconcile-test-scope.test.ts` — could scan those
files for `|| true`, `?.x == null`, and `a || a.length > 0` shapes and fail on them. The
five instances in F-610 are all one regex away.

### F-682 [IMPROVEMENT] Assert the source anchor before slicing

Sixteen assertions across eleven test files use `source.slice(source.indexOf(anchor))`.
Eleven are safe only because the _next_ assertion is positive. A shared
`window(source, from, to)` helper that throws when either anchor is missing would make
the whole family safe and would remove the F-608/F-609 class permanently.

### F-683 [IMPROVEMENT] Record a per-suite database budget

F-606 and F-607 are both "a test reached outside its own rows". A single guard that runs
after each DB suite and asserts the row counts for `User`, `Project`, `Workspace` and
`GenerationJob` are back to their pre-suite values would catch leaks and cross-suite
mutation together — and would have caught the shared-`default`-workspace write.

### F-684 [IMPROVEMENT] One redactor, three destinations

`lib/sentry/scrub.ts` `scrubSensitive` is already shared with `lib/audit/log.ts:104-105`.
Making `lib/logger.ts` the third consumer (F-633) and extending the redactor to message
and exception text (F-630) would leave the product with exactly one answer to "how do we
stop secrets escaping", instead of three different ones.

---

## Files reviewed

- `e2e/.auth/admin.json` — F-612
- `e2e/.auth/user.json` — F-612
- `e2e/.gitignore` — clean
- `e2e/auth.setup.ts` — F-612
- `e2e/journeys-authenticated.spec.ts` — F-612
- `e2e/journeys-critical.spec.ts` — F-611
- `e2e/journeys-full.spec.ts` — clean
- `e2e/journeys-stacks.spec.ts` — F-611
- `e2e/journeys-workflow.spec.ts` — F-611
- `e2e/support/account.ts` — F-612
- `e2e/support/paths.ts` — clean
- `e2e/support/projects.ts` — clean
- `e2e/support/seed-account.ts` — F-612
- `lib/verify/ensure-db.ts` — clean
- `lib/verify/env-assert.ts` — clean
- `lib/verify/orchestrator.ts` — F-615
- `lib/verify/playwright-env.ts` — clean
- `lib/verify/schema-drift.ts` — clean
- `lib/verify/test-db.ts` — clean
- `playwright.config.ts` — F-611, F-615, F-620
- `tests/assets.test.ts` — clean
- `tests/audit-invariants.test.ts` — F-606
- `tests/backup.test.ts` — clean
- `tests/checkpoint-storage.test.ts` — F-610
- `tests/code-audit.test.ts` — clean
- `tests/consumption.test.ts` — clean
- `tests/custom-domains.test.ts` — clean
- `tests/export.test.ts` — clean
- `tests/factories/checkpoint.ts` — F-605
- `tests/factories/deployment.ts` — F-605
- `tests/factories/ids.ts` — F-605
- `tests/factories/index.ts` — F-605
- `tests/factories/job.ts` — F-605
- `tests/factories/plan.ts` — clean
- `tests/factories/project.ts` — F-605
- `tests/factories/user.ts` — F-605
- `tests/factories/workspace.ts` — F-605
- `tests/generation-jobs.test.ts` — F-606
- `tests/github-oauth.test.ts` — F-617
- `tests/health.test.ts` — clean
- `tests/import-pipeline.test.ts` — clean
- `tests/integration/after-generation-followups.test.ts` — clean
- `tests/integration/answer-turn-settles-succeeded.test.ts` — clean
- `tests/integration/explain.test.ts` — F-602
- `tests/integration/generate-stream-teardown.test.ts` — clean
- `tests/integration/import-route-heartbeat.test.ts` — clean
- `tests/integration/job-heartbeat-sql.test.ts` — clean
- `tests/integration/job-settle-kept-partial-sql.test.ts` — clean
- `tests/integration/job-settle.test.ts` — clean
- `tests/integration/job-terminal-race.test.ts` — clean
- `tests/integration/legacy-db-suites.test.ts` — clean
- `tests/integration/legacy-suites.test.ts` — clean
- `tests/integration/oauth-single-use.test.ts` — clean
- `tests/integration/plan-admin-caps.test.ts` — clean
- `tests/integration/preview-persist-once.test.ts` — clean
- `tests/integration/project-lock-reentrancy.test.ts` — clean
- `tests/integration/publish-compensate-resume.test.ts` — clean
- `tests/integration/publish-execute.test.ts` — clean
- `tests/integration/publish-snapshot-read.test.ts` — clean
- `tests/integration/raw-sql-parse.test.ts` — clean
- `tests/integration/seed-migrate.test.ts` — F-603
- `tests/integration/sentry-runtime-file.test.ts` — clean
- `tests/integration/settle-streamed-generation.test.ts` — clean
- `tests/integration/settle-write-reporting.test.ts` — clean
- `tests/integration/ssrf-counter.test.ts` — clean
- `tests/integrations.test.ts` — F-610
- `tests/job-chat-ui.test.ts` — clean
- `tests/legal-terms.test.ts` — clean
- `tests/logger-scrub.test.ts` — F-633
- `tests/memory.test.ts` — clean
- `tests/mocks/ai.ts` — F-605
- `tests/mocks/cloudflare.ts` — F-605
- `tests/mocks/coolify.ts` — F-605
- `tests/mocks/github.ts` — F-605
- `tests/mocks/index.ts` — F-605
- `tests/mocks/resend.ts` — F-605
- `tests/mocks/sentry.ts` — F-605
- `tests/mocks/storage.ts` — F-605
- `tests/password-reset.test.ts` — clean
- `tests/plans-limits.test.ts` — clean
- `tests/pre-migrate.test.ts` — clean
- `tests/preview-devices.test.ts` — F-610
- `tests/project-lock.test.ts` — clean
- `tests/publish-jobs.test.ts` — clean
- `tests/quality-signals.test.ts` — clean
- `tests/register-ts.mjs` — F-605
- `tests/search.test.ts` — F-607
- `tests/sentry-scrub.test.ts` — F-630
- `tests/seo-audit.test.ts` — F-610
- `tests/setup/data-dir-guard.ts` — clean
- `tests/setup/db.ts` — F-600
- `tests/setup/env.ts` — F-600
- `tests/setup/integration.setup.ts` — F-605
- `tests/setup/legacy.ts` — clean
- `tests/setup/network-guard.ts` — F-618
- `tests/setup/repo-write-guard.global.ts` — clean
- `tests/setup/repo-write-guard.test.ts` — clean
- `tests/setup/repo-write-guard.ts` — clean
- `tests/setup/suites.ts` — clean
- `tests/setup/vitest.setup.ts` — F-600
- `tests/skills.test.ts` — F-610
- `tests/templates.test.ts` — clean
- `tests/unit/account-mail-never-dropped.test.ts` — clean
- `tests/unit/admin-jobs-auth.test.ts` — clean
- `tests/unit/admin-nav-coverage.test.ts` — clean
- `tests/unit/admin-ui-conventions.test.ts` — F-644
- `tests/unit/ai-effective-env.test.ts` — clean
- `tests/unit/ai-failover-policy.test.ts` — clean
- `tests/unit/ai-helpers-admin-key.test.ts` — clean
- `tests/unit/ai-plan-failover.test.ts` — clean
- `tests/unit/ai-provider-chain.test.ts` — clean
- `tests/unit/ai-queue-concurrency.test.ts` — clean
- `tests/unit/alert-clear-failures.test.ts` — clean
- `tests/unit/alert-clear.test.ts` — clean
- `tests/unit/answer-does-not-walk-the-provider-chain.test.ts` — clean
- `tests/unit/answer-turn-route-wiring.test.ts` — clean
- `tests/unit/api-keys-admin-section-gate.test.ts` — F-609
- `tests/unit/api-route-auth.test.ts` — clean
- `tests/unit/apply-not-sandbox-gated.test.ts` — clean
- `tests/unit/auth-active.test.ts` — clean
- `tests/unit/auth-matrix.test.ts` — clean
- `tests/unit/backup-db-run.test.ts` — clean
- `tests/unit/backup-restore-run-row.test.ts` — clean
- `tests/unit/backup-verify-storage.test.ts` — clean
- `tests/unit/build-autofix.test.ts` — clean
- `tests/unit/cancel-job-compensates-publish.test.ts` — clean
- `tests/unit/chat-building-indicator.test.ts` — clean
- `tests/unit/chat-plan-order.test.ts` — clean
- `tests/unit/chat-ui.test.ts` — clean
- `tests/unit/checkpoint-client-lock.test.ts` — clean
- `tests/unit/checkpoint-empty-snapshot.test.ts` — clean
- `tests/unit/checkpoint-restore-storage.test.ts` — clean
- `tests/unit/checkpoint-write-authz.test.ts` — clean
- `tests/unit/client-import-boundary.test.ts` — clean (see F-662 for what it does not cover)
- `tests/unit/cloudflare-zone-records.test.ts` — clean
- `tests/unit/command-palette-snippet.test.ts` — clean
- `tests/unit/conversation-state-scope.test.ts` — clean
- `tests/unit/cron-handle.test.ts` — clean
- `tests/unit/cron-monitor-coverage.test.ts` — clean
- `tests/unit/cron-outcome-bodies.test.ts` — clean
- `tests/unit/data-dir-cache-write.test.ts` — clean
- `tests/unit/data-dir.test.ts` — clean
- `tests/unit/deploy-repo-files.test.ts` — clean
- `tests/unit/deploy-rollback.test.ts` — clean
- `tests/unit/direct-call-extractions.test.ts` — clean
- `tests/unit/disconnect-does-not-lose-build.test.ts` — F-608
- `tests/unit/dockerfile-health.test.ts` — clean
- `tests/unit/domain-detach-vs-delete.test.ts` — clean
- `tests/unit/domain-project-scope.test.ts` — clean
- `tests/unit/draft-hydration-race.test.ts` — clean
- `tests/unit/edit-context-from-project.test.ts` — clean
- `tests/unit/ensure-db.test.ts` — clean
- `tests/unit/entrypoint-env.test.ts` — clean
- `tests/unit/file-tree.test.ts` — clean
- `tests/unit/format-admin-date.test.ts` — clean
- `tests/unit/format-relative-time.test.ts` — F-619
- `tests/unit/generate-provider-preflight.test.ts` — clean
- `tests/unit/generation-code-view.test.ts` — clean
- `tests/unit/generation-fileless-reply.test.ts` — clean
- `tests/unit/generation-no-changes.test.ts` — clean
- `tests/unit/generation-output-contract.test.ts` — clean
- `tests/unit/generation-page-identifier.test.ts` — clean
- `tests/unit/generation-path-posix.test.ts` — clean
- `tests/unit/generation-runtime-frames.test.ts` — clean
- `tests/unit/generation-runtime-persist.test.ts` — clean
- `tests/unit/generation-stream-rail.test.ts` — clean
- `tests/unit/generation-write-guard.test.ts` — clean
- `tests/unit/github-auth-failure-copy.test.ts` — clean
- `tests/unit/i18n-copy.test.ts` — clean
- `tests/unit/image-debit-failure.test.ts` — clean
- `tests/unit/image-worker.test.ts` — clean
- `tests/unit/import-capture-honesty.test.ts` — clean
- `tests/unit/import-client-frames.test.ts` — clean
- `tests/unit/import-job-delivery.test.ts` — clean
- `tests/unit/import-persists-site.test.ts` — clean
- `tests/unit/import-recovery-retry.test.ts` — clean
- `tests/unit/internal-origin.test.ts` — clean
- `tests/unit/job-error-codes.test.ts` — clean
- `tests/unit/job-running-write-guard.test.ts` — clean
- `tests/unit/jobs-copy.test.ts` — clean
- `tests/unit/login-malformed-body.test.ts` — clean
- `tests/unit/login-rate-limit.test.ts` — clean
- `tests/unit/mocks.test.ts` — F-604, F-605
- `tests/unit/money-limits.test.ts` — F-601
- `tests/unit/morph-fast-apply.test.ts` — clean
- `tests/unit/need-image-never-ships-raw.test.ts` — clean
- `tests/unit/network-guard.test.ts` — F-618
- `tests/unit/no-deleted-routes.test.ts` — clean
- `tests/unit/observability.test.ts` — F-631, F-632
- `tests/unit/orphan-cleanup-provenance.test.ts` — clean
- `tests/unit/orphan-listing-blind.test.ts` — clean
- `tests/unit/parse-blocks.test.ts` — clean
- `tests/unit/parse-files.test.ts` — clean
- `tests/unit/parse-generated-files.test.ts` — clean
- `tests/unit/password-change-invalidates-sessions.test.ts` — clean
- `tests/unit/pending-prompt-consumed-once.test.ts` — clean
- `tests/unit/pending-prompt.test.ts` — clean
- `tests/unit/persist-writes-real-columns.test.ts` — clean
- `tests/unit/plan-recovery-retry.test.ts` — clean
- `tests/unit/playwright-env.test.ts` — clean
- `tests/unit/preview-after-generation.test.ts` — clean
- `tests/unit/preview-assemble.test.ts` — clean
- `tests/unit/preview-capture-once.test.ts` — clean
- `tests/unit/preview-denied-visible.test.ts` — clean
- `tests/unit/preview-failure-recovery.test.ts` — clean
- `tests/unit/preview-origin.test.ts` — clean
- `tests/unit/preview-ready-signal.test.ts` — clean
- `tests/unit/preview-repair-instruction.test.ts` — clean
- `tests/unit/preview-server-bundle.test.ts` — clean
- `tests/unit/preview-workspace-actions.test.ts` — clean
- `tests/unit/project-arm-scope.test.ts` — clean
- `tests/unit/project-write-authz.test.ts` — clean
- `tests/unit/projects-search-one-path.test.ts` — clean
- `tests/unit/prompt-version-drift.test.ts` — clean
- `tests/unit/property.test.ts` — clean
- `tests/unit/provider-key-resolves.test.ts` — clean
- `tests/unit/prune-previews-bad-key.test.ts` — clean
- `tests/unit/publish-domain-merge.test.ts` — clean
- `tests/unit/publish-files.test.ts` — clean
- `tests/unit/publish-naming-slug.test.ts` — clean
- `tests/unit/publish-preview-inject.test.ts` — clean
- `tests/unit/publish-preview-password-env.test.ts` — clean
- `tests/unit/publish-republish-invariants.test.ts` — clean
- `tests/unit/publish-stacks.test.ts` — F-610
- `tests/unit/publish-stop-keeps-domains.test.ts` — clean
- `tests/unit/purge-deleted-provenance.test.ts` — clean
- `tests/unit/raw-sql-composition.test.ts` — clean
- `tests/unit/reconcile-test-scope.test.ts` — clean
- `tests/unit/recovery-action-guards.test.ts` — clean
- `tests/unit/recovery-cause-recorded.test.ts` — clean
- `tests/unit/recovery-route-target.test.ts` — clean
- `tests/unit/register-invite-only.test.ts` — clean
- `tests/unit/resumable-phase.test.ts` — clean
- `tests/unit/resume-partial.test.ts` — clean
- `tests/unit/s3-not-found.test.ts` — clean
- `tests/unit/safe-fetch-trusted.test.ts` — clean
- `tests/unit/schema-drift-run.test.ts` — clean
- `tests/unit/schema-drift.test.ts` — clean
- `tests/unit/secret-scan.test.ts` — clean
- `tests/unit/sentry-admin-meta.test.ts` — clean
- `tests/unit/sentry-integration.test.ts` — clean
- `tests/unit/settings-registry-consumers.test.ts` — clean
- `tests/unit/settings-resolve.test.ts` — clean
- `tests/unit/settings-test-button.test.ts` — clean
- `tests/unit/settled-job-never-recovers.test.ts` — clean
- `tests/unit/shutdown-drain.test.ts` — clean
- `tests/unit/single-use-state.test.ts` — clean
- `tests/unit/skills-degrade-visibly.test.ts` — clean
- `tests/unit/stack-shape-mismatch.test.ts` — clean
- `tests/unit/start-over-reopens-plan.test.ts` — clean
- `tests/unit/stock-photo-fallback.test.ts` — clean
- `tests/unit/storage-key-traversal.test.ts` — clean
- `tests/unit/storage-not-found.test.ts` — clean
- `tests/unit/stream-file-tracker.test.ts` — clean
- `tests/unit/streaming-generation-view.test.ts` — clean
- `tests/unit/studio-contrast.test.ts` — clean
- `tests/unit/team-self-guard.test.ts` — clean
- `tests/unit/test-data-dir-guard.test.ts` — clean
- `tests/unit/test-db-guard.test.ts` — clean
- `tests/unit/test-suites-reachable.test.ts` — clean
- `tests/unit/thin-checkpoints.test.ts` — clean
- `tests/unit/truncation-recovery.test.ts` — clean
- `tests/unit/validate-imports.test.ts` — clean
- `tests/unit/validation-is-wired.test.ts` — clean
- `tests/unit/validation-runs-on-generated-code.test.ts` — clean
- `tests/unit/verify-env.test.ts` — clean
- `tests/unit/verify-orchestrator.test.ts` — clean
- `tests/unit/watchdog-stop-scope.test.ts` — clean
- `tests/unit/workspace-edit-intent.test.ts` — clean
- `tests/unit/workspace-job-watch-clock.test.ts` — clean
- `tests/unit/workspace-tabs.test.ts` — clean
- `tests/url-guard.test.ts` — clean
- `vitest.config.ts` — F-600, F-616

273 files, each listed once.

### Related files cited but outside this phase's scope

`scripts/verify.ts`, `package.json`, `pnpm-workspace.yaml`, `.npmrc`, `pnpm-lock.yaml`,
`knip.json`, `.github/workflows/verify.yml`, `.github/workflows/nightly.yml`,
`.husky/pre-commit`, `.husky/pre-push`, `proxy.ts`, `lib/db.ts`, `lib/auth.ts`,
`lib/logger.ts`, `lib/sentry/scrub.ts`, `lib/sentry/options.ts`,
`lib/observability/{noise,quota,heartbeat,sentry-api,migrate-env}.ts`,
`lib/audit/log.ts`, `lib/backup/copy.ts`, `lib/utils.ts`, `utils/cn.ts`,
`lib/preview/bundle.ts`, `lib/jobs/lifecycle.ts`, `lib/projects/actions.ts`,
`lib/projects/plan.ts`, `lib/team/actions.ts`, `components/shared/pixi/utils.ts`,
`components/workspace/{GenerationWorkspace,BrowserPreview,StreamingCodePanel,ChatInput,ChatPanel}.tsx`,
`components/ui/shadcn/{button,dialog,select}.tsx`,
`app/api/projects/[id]/{job,presence}/route.ts`, `docs/release.md`, `AGENTS.md`,
`.cursor/lessons-learned.md`.
