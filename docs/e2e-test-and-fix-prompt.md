# End-to-end pass — how to run one

- Owner: the agent or engineer running the pass. Update this file in the same session you change
  what it describes (`keep-cursor-current.mdc`).
- Verified against code on **2026-08-20**.

**This is a checklist, not a paste-in prompt.** The 658-line agent brief that used to live at this
path was deleted on 2026-08-20 (audit F-531 / F-575). It mandated `pnpm exec` for binaries, told the
reader to start a dev server on the wrong port, sourced credentials from a `SandboxProviderConfig`
table that no longer exists, budgeted "sandbox boots", named nine `/api` routes that no longer exist
and an admin page that the 2026-08-19 sandbox removal deleted, and listed six per-stack prompt files
where three exist. Pasting it armed a `node_modules` purge and spent a live-generation budget
against endpoints that 404.

Nothing below restates a route list, a stack list, an endpoint list or a page inventory: those are
what rotted. Read them from the code, and read the invariants from `AGENTS.md`.

## Read first, always

`AGENTS.md`, `.cursor/README.md`, `.cursor/lessons-learned.md`, the always-on rules in
`.cursor/rules/*.mdc`, and `docs/release.md`. A pass that skips this re-discovers decisions that are
already written down, and re-breaks things the lessons file already records.

## Ground rules

These come from the always-on rules; a QA pass does not get an exemption.

- **pnpm only.** Never `npm` / `npx` / `yarn` — this repo pins `packageManager: pnpm@11.21.0` and
  another package manager can rewrite `pnpm-workspace.yaml`, which carries the security `overrides`
  the verify gate depends on.
- **Project scripts are fine (`pnpm run verify`, `pnpm db:test`); ad-hoc tool invocation is not.**
  Never `pnpm exec <tool>`. Run the installed binary directly:
  `node ./node_modules/typescript/bin/tsc --noEmit`,
  `node ./node_modules/eslint/bin/eslint.js <paths> --max-warnings 0`,
  `node ./node_modules/vitest/vitest.mjs run <files>`,
  `node ./node_modules/tsx/dist/cli.mjs <script>`. Reason and current status: the Verify/release
  bullet in `AGENTS.md`.
- **One dev server per working tree, on that tree's port.** The table in
  `.cursor/rules/single-dev-server.mdc` is the allocation: this checkout
  (`ai-genration-improvements`) is `:3001`, `.worktrees/main` is `:3000`. If the port already
  answers, reuse it. Only the dedicated dev-server agent may start or restart it, run
  `prisma generate`, or replace locked Next/Prisma binaries. `pnpm install` only while that server
  is stopped.
- **Tests use `TEST_DATABASE_URL`** (`openlovable_test` on `5433`) — never the application database.
- **No skipped test, loosened assertion, widened timeout, `@ts-expect-error`, `any`, or
  `--no-verify`** to turn a run green. Fix the product.
- **Do not commit or push** unless asked, and do not run destructive admin actions (backup restore,
  deploy rollback, a real deploy, `purge-projects` against real data). Exercise their pre-flight and
  confirmation path instead, and list them as "not executed — destructive".
- **There is no sandbox VM.** Generated code is bundled in the browser
  (`components/workspace/BrowserPreview.tsx`, `esbuild-wasm`) and server-side by
  `lib/preview/server-bundle.ts`. Nothing to boot, kill, or budget.

## Bring-up

1. `pnpm install --frozen-lockfile` — only while this tree's dev server is stopped. If the lockfile
   is stale, say so; do not silently regenerate it.
2. `pnpm db:up` — local Postgres on host `5433` (`docker-compose.dev.yml`).
3. `pnpm db:test` — creates **and** migrates `openlovable_test`; it refuses to run against any other
   database name. Skipping it leaves the test database behind the committed schema, and the raw-SQL
   suites then pass while proving nothing.
4. `pnpm db:seed` — one ADMIN.
5. `.env` / `.env.local` from `.env.example`. Never invent or guess a third-party key.

A failure here is an environment defect: fix it, record the fix, and count it separately from
product bugs.

## Where credentials actually live

- **AI provider keys** — `OrgApiKey` rows, resolved through `lib/api-keys.ts` and the overlay in
  `lib/ai/effective-env.ts`. UI: `/settings/api-keys`. Not `/admin/config`.
- **Publish integrations** (GitHub App, Cloudflare, Coolify, Sentry) — Prisma `Integration` rows,
  configured at `/admin/integrations`. Not env.
- **Operator tunables** — `lib/settings/registry.ts`, surfaced at `/admin/config`, resolved DB row →
  env var → registry fallback.

Use them only by driving the app. Never print them, copy them out of the database, or write them to
disk.

## Cost control

The repo already has the pattern — copy it from `e2e/journeys-workflow.spec.ts`:

- `blockPaidRoutes` answers every paid route with a plain JSON `503` and **fulfils, never aborts**.
  An aborted request surfaces as `TypeError: Failed to fetch`, which the workspace renders as a
  crash — so an aborted stub hides the behaviour you were testing.
- `skipPlanningOnDashboardCreate` rewrites the `createProject` server action's arguments to add
  `skipPlanning: true`. `page.route` cannot intercept the server-side plan generation: a server
  action posts to the page URL, not to an API route.

Keep live generations to the few needed to judge output quality, track the ids you create, and delete
every project, invite, template, domain and API key you made. Never burn a live call reproducing a
bug more than twice — capture the output the first time.

## Prove it

`pnpm run verify` is the gate. Its step list, the fatal/non-fatal split, and what each exit code
means are enumerated once in `docs/release.md`; `lib/verify/orchestrator.ts` is the source of truth
behind it. `pnpm run verify:full` runs every Playwright project instead of just `critical`.

Playwright projects (`playwright.config.ts`): `setup` (auth state), `authenticated`
(`journeys-authenticated` + `journeys-workflow`), `critical`, plus `stacks` and `full` whose specs
are `.fixme()`.

Coverage floors in `vitest.config.ts` are a ratchet — raise, never lower — and only one
`vitest --coverage` may run in a checkout at a time.

If a bypass is genuinely unavoidable: `pnpm run verify:bypass -- "reason"` then
`git push --no-verify`. It logs to `docs/verify-bypasses.log`.

## Report

For each defect: what a user sees, the root cause in code, the fix, and the command or interaction
that proves it. For anything not done, say which: _not executed — destructive_, _not executed — over
live budget_, or _blocked_, with repro steps and a proposed fix. Never half-fix.
