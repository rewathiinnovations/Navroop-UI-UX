# Cursor layout for Navroop / Open Lovable

This folder is project-scoped Cursor config. Existing `mcp.json` is kept. Rules and skills here are meant to be committed (secrets and caches are gitignored). Use **pnpm**, not npm (`pnpm-lock.yaml` is the lockfile; do not create `package-lock.json`).

This is one half of the agent configuration. The other half is Claude Code's, and it is committed
too — `AGENTS.md` carries the combined table under "Agent configuration layout". Both are listed
here so neither is invisible from the file that claims to map it.

## Layout

```
.cursor/
  mcp.json                 # MCP servers Cursor reads — duplicate of the root .mcp.json
  README.md                # this file
  lessons-learned.md       # self-evolving mistake log (read before tasks; append on corrections)
  rules/                   # project rules (*.mdc) — the content source for both hosts
  skills/
    superpowers/           # Superpowers process skills (vendored)
    cursor/                # Cursor core skills (create-rule, canvas, …) — Cursor only, not copied
    ui-ux-pro-max/         # UI/UX research + briefs
    ui-styling/            # Tailwind / shadcn styling
    design/                # logos, icons, CIP, slides — three commands call a paid Gemini API
    design-system/         # tokens and component specs

CLAUDE.md                  # Claude Code entry point; imports the always-on rules from .cursor/rules
.claude/
  skills/                  # what the Skill tool loads: same files, flat, minus the Cursor-only skills
                           #   (autopilot and split-to-prs are the two kept from cursor/)
  settings.json            # committed permissions (deny .env*/.cursor/.env.deploy/e2e/.auth)
  settings.local.json      # personal state — GITIGNORED, so what it enables is not reviewable
.mcp.json                  # MCP servers Claude Code reads — same dev3000 entry as .cursor/mcp.json
docs/superpowers/specs/    # dated design specs from brainstorming / writing-plans
```

`dev3000` is the single MCP server both files declare (`http://localhost:3684/mcp`). It is an
external dev tool that must already be running; nothing here starts it and it is not a dependency.
The two files are duplicates with no generator — edit one, edit the other.

`docs/superpowers/specs/` currently holds one spec,
`2026-08-19-interactive-generation-ux-design.md`, which is the only written record of the
post-sandbox preview architecture. Once a spec's decisions are load-bearing they belong in the
Product map below; the spec stays as the reasoning behind them.

Nested Firecrawl/home rules under `components/` and `styles/` are unchanged. Merge with those; do not delete them.

## Rules

| Rule                        | When                                                                                                                                                                                     |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `navroop-product.mdc`       | Always — invite-only Navroop shell                                                                                                                                                       |
| `secrets.mdc`               | Always — never commit `.env.local`                                                                                                                                                       |
| `coolify-local-secrets.mdc` | Always — read `.cursor/.env.deploy` for Coolify/SSH; never commit or echo                                                                                                                |
| `skills-availability.mdc`   | Always — what is in-repo vs profile-only                                                                                                                                                 |
| `multi-agent-ownership.mdc` | Always — wait, re-read, merge; one owner per area                                                                                                                                        |
| `single-dev-server.mdc`     | Always — one server per checkout on that checkout's own port (this tree `:3001`, `.worktrees/main` `:3000`); dedicated agent only (also `prisma generate` / locked Next+Prisma binaries) |
| `keep-cursor-current.mdc`   | Always — refresh this map after product/schema/API/layout changes                                                                                                                        |
| `stack.mdc`                 | App/lib/prisma TypeScript                                                                                                                                                                |
| `brand-theme.mdc`           | UI — Navroop, light default                                                                                                                                                              |
| `studio-generation.mdc`     | Studio chrome + `GenerationProvider`                                                                                                                                                     |
| `admin-ownership.mdc`       | Admin team/usage/invite files                                                                                                                                                            |

## Product map

- **API auth gate** — `proxy.ts` denies `/api` and `/preview-static` by default; the only exceptions are `PUBLIC_API_ROUTES` in `lib/auth/public-routes.ts` (explicit path + methods + reason + mechanism, no wildcards). Coarse JWT check only — no Prisma in the proxy; per-route membership/ADMIN/`isActive` checks stay put. 401s are JSON with a request id. Guarded by `tests/unit/api-route-auth.test.ts`, the `public-routes` verify step, and the probe in `scripts/smoke-test.ts`. Cookie-authenticated writes also need a same-origin `Origin` / `Sec-Fetch-Site` (`lib/auth/csrf.ts`, 403 `CROSS_ORIGIN_REFUSED`); `ORIGIN_CHECK_EXEMPT` is empty and `tests/unit/api-csrf-origin.test.ts` drives every mutating endpoint through the proxy. Server Actions keep Next's own Origin/Host check (F-350).
- **No self-fetch between routes** — routes never call sibling routes over HTTP. Shared work sits in `lib/` (`lib/generation/analyze-edit-intent.ts` is the surviving example); routes are thin wrappers. `internalCallHeaders` is deleted — do not bring it back. Failures are typed results and are logged; inside a Job use `recordJobStepFailure` (`lib/jobs/step-failure.ts`). Apply close copy comes from `applyOutcome` (`lib/jobs/copy.ts`); GenerationWorkspace reuses that sentence via `applyPageCopy` (`lib/generation/apply-page-copy.ts`). `/generation` is not a route; `proxy.ts` has no `/generation` redirect.
- **Lint** — eslint `no-empty` is error so a bare `catch {}` cannot return. A comment inside a catch is allowed only when the failure is a documented expected fallback (see the malformed-meta fall-through in `lib/sentry/client.ts`, which drops to the build-time DSN rather than crashing every page load).
- **Instance self-identity** — `lib/runtime/self.ts` `getSelfIdentity()` → `{ coolifyAppUuid, gitSha, instanceId, environment }`. Only reader of `COOLIFY_APP_UUID`; Sentry restart, health rollback route, and `scripts/rollback.ts` share `SELF_UUID_NOT_CONFIGURED`. Shown on `/admin/health`.
- **Projects API** — `/api/projects`, Prisma `Project` (`lib/projects`)
- **Plan/Build** — `ProjectPhase` + `/api/projects/[id]/plan`; workspace chat `plan` \| `build`. First build waits for plan Approve (`decidePendingPromptAction`); opening a project boots nothing (`shouldRequestSandbox` in `lib/workspace/sandbox-request.ts` is a permanent false gate). A dead first plan with no site resumes to PLANNING, not COMPLETE (`resumablePhaseFromEvidence`; job `filesWritten` is not site evidence). `settleStreamedGeneration` (`lib/jobs/settle-generation.ts`) persists the streamed `<file>` blocks server-side (merged over the existing site) and fails `no_files_generated` / `stack_mismatch` when nothing usable arrived — a finished stream is not SUCCEEDED + COMPLETE by itself. Recovery Try again starts a new billed build.
- **Stacks** — Prisma `Stack` + `lib/stacks`. New projects default NEXTJS. PromptHero / pending-prompt persist `{ text, stack, designDirection, importMode, templateId }` (defaults NEXTJS + minimal + reimagine)
- **Templates** — Prisma `Template`, `lib/templates/`, `/templates`, ADMIN `/admin/templates`. Built-in + workspace-private. Create from template stays in plan mode; `usageCount` increments. Seed: `prisma/seed-templates.ts`. `'use server'` actions export only async functions; `toPublic` is in `lib/templates/public.ts`.
- **ZIP export** — `lib/export/`, `GET /api/projects/[id]/export`. Checkpoint snapshots; no credits; 5/user/hour.
- **Onboarding** — `lib/onboarding/`, dashboard first-run + prompt tips + product tour. User dismissal timestamps.
- **Project search** — `GET /api/search?q=` FTS on name + original prompt (`searchVector Unsupported("tsvector")?` + GIN). Cmd+K palette. Firecrawl POST on the same route is unchanged.
- **Legal** — `/terms` `/privacy` `/legal` drafts. Terms checkbox on register; data-request email from profile.
- **Design directions / generation prompts** — `lib/design/directions.ts`, `lib/stack-prompts/` (base-rules + seo-rules + stack). Cacheable stable prefix + selective follow-up context in `lib/generation/`
- **SEO / AEO** — `lib/seo/`, Prisma `SeoAudit`, `/api/projects/[id]/seo`, Quality → SEO & AI search
- **Code quality** — `lib/audit/` (not `log.ts`), Prisma `CodeAudit`, `/api/projects/[id]/audit`, Quality → Code & performance; `getTopRecurringIssues` on `/admin/usage` and `/admin/quality`
- **Audit log** — Prisma `AuditLog`, `lib/audit/log.ts`, ADMIN `/admin/audit`. Distinct from CodeAudit. Pre-migrate backup gate: `scripts/pre-migrate.ts`. Last-admin trigger + atomic credits + Deployment RESTRICT.
- **Sidebar / workspace** — `components/layout/Sidebar`, default export `GenerationWorkspace` in `components/workspace/GenerationWorkspace.tsx` (imported by `app/project/[id]/page.tsx`). No `GenerationPage` identifier. `app/generation/page.tsx` is gone; `proxy.ts` has no `/generation` redirect. Workspace top bar: Preview/Code icon-only (`aria-label` Preview/Code), selected tab `--studio-cta-gradient` / `--studio-cta-fg`; cluster Preview|Code → page → device → version → More views → actions; Quality/Assets/Brain/Domains sit behind More views; device sizes are a dropdown (`PreviewDeviceToolbar`). Preview device sizes in `lib/preview/devices.ts` (mobile/tablet/desktop, localStorage, rotate, scale-to-fit). Open-in-new-tab → public `/preview-view?u=` shell (token-gated, no login; iframe from preview-static; not Coolify; not app-origin generated JS). `/project/[id]/preview` stays signed-in in-app.
- **Visual Edits** — **removed**. Inspector, preview toolbar (Select/Instruct/Comment), instant apply, and inspector inject are gone. Preview HTML still has the navigation interceptor, `<base href="about:srcdoc">`, and navigate postMessage. Image replace is the Assets tab / `NEED_IMAGE:` fulfill. Do not reintroduce `lib/visual-edits`.
- **Static preview** — Prisma `PreviewBuild`, `lib/preview/`, `/preview-static/{projectId}` served **only from a distinct preview origin** (`preview-static.{zone}`, else the `preview.host` setting — env fallback `PREVIEW_STATIC_HOST`, runtime — never the app origin, F-140) with a signed URL token; unconfigured → no preview URL is minted and Open-in-new-tab disables. Open-in-new-tab is the public `/preview-view` shell (signed iframe src on the preview origin; not Coolify). `lib/preview/build.ts` builds the snapshot **in-process with esbuild** (`buildStaticSite` in `lib/preview/server-bundle.ts` — same bundler, virtual filesystem, and esm.sh import map as the browser preview). One generation → one preview capture (per checkpoint); `activePreviewBuildId` adopts only a newer build. `persistProjectGeneration` `previewNotice` reaches chat via `surfacePreviewNotice` in `generation-runtime` (deduped with `saveCurrentProject`).
- **Connectors / GitHub** — `/connectors`, `/api/github`
- **Checkpoints** — `/api/projects/[id]/checkpoints`. The latest snapshot is the source of truth for publish and ZIP export. `readSnapshot` throws `SnapshotReadError` on a storage/gunzip miss — empty means empty, never "could not read".
- **Browser preview / bundling** — `components/workspace/BrowserPreview.tsx` compiles the project in the browser with `esbuild-wasm` (deps pinned to esm.sh URLs in `lib/preview/deps.ts` — React 19) and renders it in a sandboxed iframe; no VM, no dev server. In-frame `/` and `#` clicks route via `lib/preview/html.ts` → `window.__previewNavigate`; hash `#/product/foo` matches `app/product/[slug]/page.tsx` (`matchNextRoute` in `lib/preview/assemble.ts`); the page picker postMessages `{ type: 'navigate' }` at `previewFrameRef`. The wasm binary is copied by `scripts/copy-preview-vendor.mjs` into `public/preview-vendor/` (gitignored) ahead of `next dev` / `next build`; `next.config.ts` keeps `esbuild` in `serverExternalPackages` for the server-side twin. The sandbox VM subsystem (`lib/sandbox/`, `SandboxProviderConfig`, e2b/modal/daytona drivers, `/api/projects/[id]/sandbox`, `/admin/sandbox-providers`, `reap-sandboxes` / `check-sandbox-providers` crons, `SANDBOX_IDLE_MINUTES`) was deleted in migration `20260819010000_drop_sandbox_columns`; `lib/workspace/sandbox-request.ts` keeps the leftover workspace branches unreachable. Design history: `docs/superpowers/specs/2026-08-19-interactive-generation-ux-design.md`; generated-code validation: `docs/build-autofix.md`.
- **Assets** — `ProjectAsset`, `lib/assets`, `lib/storage`, workspace Assets tab, `/api/projects/[id]/assets`. `s3Get` / `s3Exists` / `localExists` rethrow anything that is not not-found. A `NEED_IMAGE:` token is **generated first, then falls back to stock** (`lib/assets/fulfill.ts`): the self-hosted **image worker** (`tooling.images.workerUrl` / `.token` / `.model`, default `lucid-origin`, ~12s, three concurrent, free and unmetered — `lib/assets/image-worker.ts`) → OpenAI `gpt-image-1` → Google Imagen 3 (both metered, reached only with no worker) → Unsplash when `tooling.unsplash.accessKey` is set → **Openverse**, keyless and CC0/public-domain only (`lib/assets/openverse.ts`), which is why an install with no photo key still ships real photographs. Unfulfilled tokens are reported, not silently placeholdered.
- **URL import** — `ImportSource`, `lib/import/`, `POST /api/projects/[id]/import`. Reimagine (default) or replicate. Multi-pass capture → rehost → segment → generate. Persist is CAS replace (`writeMergedSite`) + checkpoint + preview. Skills after the cacheable prefix. Stack-accurate workspace copy — not “React app”. `?url=` does not auto-import. SSRF: `lib/security/url-guard.ts` + `safeFetch`. Untrusted HTML wrap before prompts. Private-range reject counts on `/admin/usage`. Firecrawl text is typed (`lib/import/firecrawl.ts`) — a failed scrape is not “empty markdown”; chat + `recordJobStepFailure`. Playwright abort vs one-section continue. Empty `filesXml` is not success. Route passes `jobId` to `runProjectUrlImport`. Hard aborts use `import_failed`. SSE client reads `errorPayload.message`. IMPORT Try again is `streamProjectImport`, not a generated build.
- **Skills** — Prisma `Skill`, `lib/skills/`, `/settings/skills` + Brain tab section. Conditional; after cacheable prefix on chat, plan, and URL import; ADMIN mutations. Distinct from Brain memory.
- **Brain memory** — `MemoryEntry`, `lib/memory/`, workspace Brain tab. Always-on; inside cacheable prefix. Extraction toggle on `/admin/usage`.
- **Quality signals** — `QualitySignal`, `PromptVersion`, `lib/signals/`, `/admin/quality` (ADMIN). Measurement only — no auto prompt changes. `getActivePromptVersion` rolls a new labeled version when the assembled prefix hash drifts from the active row (prompt edits become attributable); code rollback reactivates the matching row.
- **Plans / credits** — `Plan` + `CreditLedger` merged onto `Workspace`. `lib/plans/`. Credits stay flat; admin cost is token-based (`lib/consumption/`). Per-job caps + loop detection. Workspace spend ceiling auto-pauses (`pauseReason`). Free default; ADMIN upgrades on `/admin/plans`. No checkout. `/settings/usage`, sidebar credit meter, `/admin/workspace`.
- **Email** — `lib/email/client.ts`. Resend (`RESEND_API_KEY`, `EMAIL_FROM`) or console dev driver. English templates in `lib/email/templates/`.
- **Password reset** — `PasswordResetToken`, `lib/password-reset/`, `/api/auth/forgot-password`, `/reset-password`, `/api/auth/reset-password`. AuthModal forgot panel. ADMIN `/api/admin/team/[id]/reset-link`. Hash-only tokens; generic success; sessions + JWT invalidated after reset.
- **Persistent volume** — `/data` (`DATA_DIR`). Cache + bootstrap only (`lib/runtime/data-dir.ts`). Observability file default `/data/config/observability.json`. See `docs/deployment.md`.
- **Error tracking** — `lib/logger`, `lib/sentry`, `lib/observability/`, `GET /api/health` (DSN + release sha + data dir), `/admin/health` (Error tracking + System checks + AI providers + persistent volume). Sentry DSN/org/token live on Integration `SENTRY` + `OBSERVABILITY_CONFIG_PATH` (not env). Heartbeat/quota crons + `ObservabilityCheck` / `CronRun`. Missing DSN in production is recorded, not treated as “no errors”.
- **Jobs** — Prisma `Job` (`@@map("GenerationJob")`), `lib/jobs/`, publish compensation, boot reconcile, `POST /api/cron/reap-jobs` every minute, `POST /api/cron/cleanup-orphans` daily, workspace + publish recovery panel (`recoveryHeading(kind)`; chat is PLAN/BUILD/FOLLOWUP/IMPORT only; IMPORT Try again is `streamProjectImport`), ADMIN `/admin/jobs` (failed rows show `errorMessage` via `jobAdminFailureLine`). `listReconcileCandidates` uses `COALESCE("heartbeatAt", "createdAt")`. Terminal writes are `updateJobIfActive` (QUEUED/RUNNING on the same UPDATE); a lost write is the row count (`commitActiveJob` / `abandonActiveJob.wrote`), never a status re-read, so only the winner runs side effects. Chat busy/building follows the latest job (QUEUED/RUNNING only); ABANDONED/FAILED/CANCELLED unlocks chat even if `Project.phase` is still BUILDING. Generate keys: `getEffectiveApiKey` personal → org (admin panel) → env; a rejected key does not fall back to the same vendor's env key. Provider failover/queue in `lib/ai/` (keyless skipped; plan and generate share `shouldFailover`; auth including unregistered-caller/identity, not_found, quota, unavailable, and empty completion fail over; content-policy / request-fault 4xx do not). Stream `onError` is captured (`bindStreamErrorCapture`) because AI SDK `textStream` drops error parts. Zero-file completion walks the rest of the chain once. 30s per attempt. Rejected-key copy names the vendor: "DeepSeek rejected the API key. Ask an administrator…" (`lib/ai/failover.ts`). First-build all-empty has its own sentence; follow-up no-files keeps "describe the change in a little more detail". Job rows record tokens, estimated USD, provider, model.
- **Team / usage** — `/admin/team`, `/admin/usage`, `/admin/quality`, `/admin/health`, `/admin/jobs`, `/admin/backups`, `/admin/audit`, `/admin/integrations`, `/admin/deploy`, `/admin/servers`, `/admin/plans`, `/admin/workspace`, `/admin/templates`, `/admin/config` (ADMIN). Admin dates: `app/(app)/admin/format-admin-date.ts` (`en-US`). Integrations Sentry redirect: `resolveSentryMeta` (no `window` fallback).
- **Admin shell** — `app/(app)/admin/layout.tsx` gates once (`requireAdmin`) and frames every page. Nav is defined once in `components/admin/admin-nav.ts` (`ADMIN_NAV`); sidebar, home cards, and titles render from it; `tests/unit/admin-nav-coverage.test.ts` pins every admin page into it. Shared chrome `components/admin/`: `AdminPage`, `AdminCard`, `AdminTable`, `StatTile`, `StatusPill`, `StatusBanner`, `AdminTabs`, `Accordion`, `AdminIcon`, `ConfirmAction` (the one destructive-action dialog; `confirmPhrase` for type-to-confirm). Do not hand-roll frames, tables, tabs, pills, or `window.confirm`.
- **Admin configuration** — `/admin/config` renders from `lib/settings/registry.ts` (`SETTING_GROUPS`/`SETTINGS`); adding a registry entry surfaces the setting. `lib/settings/resolve.ts` (server-only) resolves **DB → env → fallback**; clearing deletes the row (back to env). Secrets encrypted, echo `last4` only; `setting:`-prefixed `AppSetting` rows, 30s cache. `GET/PUT /api/admin/settings`; `POST /api/admin/settings/test` → `lib/settings/test-group.ts`, results typed `live` vs `local` — never present a presence check as a working key. Generation overlay: `lib/ai/effective-env.ts` (includes `DEEPSEEK_THINKING` from `ai.deepseek.thinking` — V4 thinks unless the request sends `disabled`). Tests: `tests/unit/settings-resolve.test.ts`.
- **Backup / restore** — `lib/backup/`, Prisma `BackupRun`, `scripts/backup-*` / `restore-db` / `verify-storage`, `/admin/backups`. Separate `BACKUP_*` bucket from `ELK_*`. Daily 02:00 `POST /api/cron/backup-db`, weekly `POST /api/cron/verify-storage`.
- **Integrations** — Prisma `Integration`, `lib/integrations/`, `/admin/integrations`. GitHub Manifest + Cloudflare token/zone + Coolify discover + Sentry DSN/OAuth. No publish env vars. Root domain = Cloudflare zone name. Sentry is not required for publish.
- **Publish** — Coolify Preview/Live under the connected zone. `lib/publish/`, GitHub App `lib/github/deploy-client.ts`, Cloudflare `lib/cloudflare/dns.ts`. `/deployments` + workspace Publish sheet. Slot limits via `checkLimit('liveSites'|'previewSites')`, not credits. Requires all three integrations CONNECTED. Files come from the latest Checkpoint snapshot, else a fresh capture of `lastCode` (`collectPublishFiles`); a `SnapshotReadError` is `unavailable` (503), never a silent stale publish.
- **Preview access control** — a PREVIEW deploy can be password-gated. Three stores: `Deployment.passwordHash` (bcrypt, the only flag — `execute.ts` derives `passwordProtected` from it, `serialize.ts` derives `hasPassword`), the plaintext as a `PREVIEW_PASSWORD` env var on the Coolify application (middleware cannot verify a hash), and the `middleware.ts` that `lib/publish/preview-inject.ts` injects into the deploy repo for node stacks — Basic Auth, fail-closed (no env var → 401), username checked against `preview` as well as the password, both compared as SHA-256 digests through `timingSafeEqual`, and `runtime: 'nodejs'` pinned in the emitted `config` only when the gate is present (Edge cannot resolve `node:crypto`). Static stacks use Coolify Traefik basic auth (`setBasicAuth`, user `preview`) and get no file gate. `updatePreviewPassword` (`lib/publish/publish.ts`) reads the existing plaintext back via `getApplicationEnvVar` **before writing anything** (only copy; a read failure refuses the change), then hash → env var → start the PREVIEW job, and rolls back **both** stores on failure. `setPreviewPasswordAction` holds the project lock, hands the run to `after()` and returns at once — the publish is not inline; the route declares `maxDuration = 600`. `POST`/`DELETE /api/projects/[id]/publish/password`. Do not hand-edit `PREVIEW_PASSWORD` on the Coolify app.
- **Custom domains** — `lib/domains/`, Prisma `CustomDomain`, workspace Domains tab + `/project/[id]/domains`. Path A client DNS / Path B Cloudflare zone (do not auto-delete). `POST /api/cron/check-domains` every 2 min. `Plan.allowCustomDomain`.
- **Project lock / presence** — `lib/projects/lock.ts` + `ProjectPresence`. Atomic lock on generate/import/publish/audit/restore. Presence GET/POST `/api/projects/[id]/presence`. Workspace avatars, lock bar, stale banner (`contentVersion`). Daily prune via thin-checkpoints.
- **Coolify** — `docker-compose.yml` + `Dockerfile` (see `docs/coolify.md`); local Postgres `docker-compose.dev.yml` on `5433`. `NEXT_PUBLIC_APP_URL` is set in the compose file and `assertInternalOrigin()` refuses to boot in production if it is unset, unparseable, or a different host from `APP_URL` (warn-only elsewhere). API client `lib/coolify/`; token from Integration / `CoolifyServer`. `POST /api/admin/servers` is 410 — configure at `/admin/integrations`. No `COOLIFY_*` compose env. Local logins: `.cursor/.env.deploy` (gitignored).
- **Verify / release** — `pnpm run verify` / `verify:full`. **The step list is single-sourced in `docs/release.md` (“`verify` order”)** — do not restate it here; the summaries that did dropped the fatal `playwright-authenticated` step. Vitest in `tests/unit` + `tests/integration` (legacy tsx suites wired). Unit-test `fetch` to loopback needs `allowLocalhost('reason')` (`tests/setup/network-guard.ts`). Coverage floors live only in `vitest.config.ts` (`thresholds`) — raise, never lower, and never restate the numbers in prose. Only one `vitest --coverage` in a checkout (`coverage/.tmp`). Repo-write guard is Vitest `globalSetup`. Secret scan exit 2 is a broken gate, not a pass. Playwright `e2e/` (`critical` = journeys 1–4). Playwright CI `webServer` inherits env from `lib/verify/playwright-env.ts` (`.env` / `.env.local` + test-only `ENCRYPTION_KEY` fallback). Test DB `TEST_DATABASE_URL` ≠ `DATABASE_URL`. Schema drift shadow DB is disposable. Doc claims that can be read out of the source — floors, step ids, setting keys, env vars, stack prompts, worktree ports, banned `npm` / `pnpm exec` forms — are pinned by `tests/unit/docs-accuracy.test.ts`.

## Superpowers

Skills are copies of the Superpowers plugin so agents do not depend only on the user plugin cache.
They exist twice: `.cursor/skills/superpowers/` for Cursor and `.claude/skills/` for Claude Code,
byte-identical and kept that way by `tests/unit/skill-trees-in-sync.test.ts`. Either copy reads the
same, but only `.claude/skills/` is what the Claude Code Skill tool loads, so read the tree your own
host loads and mirror every edit into the other.

1. Read `using-superpowers/SKILL.md` at the start of a task — `.cursor/skills/superpowers/` under
   Cursor, `.claude/skills/` under Claude Code.
2. If a skill might apply, read that skill’s `SKILL.md` **before** exploring or editing.
3. Common triggers:
   - New feature → `brainstorming`, then `writing-plans`
   - Bug → `systematic-debugging`
   - Implementation with tests → `test-driven-development`
   - Multi-agent work → `subagent-driven-development` / `dispatching-parallel-agents`
   - Before claiming done → `verification-before-completion`

Announce “Using [skill] to [purpose]” and follow the skill.

## Cursor core and UI skills

- Authoring rules/skills: `.cursor/skills/cursor/create-rule`, `create-skill`
- Product UI: `ui-ux-pro-max`, `ui-styling`, `design-system`
- Generated-site briefs already use `lib/ui-ux-pro-max/` — keep that path; the skill is the research companion.

## Not vendored

`omni-*`, `gstack-*`, `coolify*`, `whm-cpanel`, `cloudflare*`, and most `cli-*` skills stay in the user profile (`~/.cursor/skills/`). They remain available globally; they are not copied here to avoid bloating the repo.
