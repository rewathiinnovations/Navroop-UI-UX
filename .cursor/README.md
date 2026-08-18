# Cursor layout for Navroop / Open Lovable

This folder is project-scoped Cursor config. Existing `mcp.json` is kept. Rules and skills here are meant to be committed (secrets and caches are gitignored). Use **pnpm**, not npm (`pnpm-lock.yaml` is the lockfile; do not create `package-lock.json`).

## Layout

```
.cursor/
  mcp.json                 # existing MCP servers (do not wipe)
  README.md                # this file
  lessons-learned.md       # self-evolving mistake log (read before tasks; append on corrections)
  rules/                   # project rules (*.mdc)
  skills/
    superpowers/           # Superpowers process skills (vendored)
    cursor/                # Cursor core skills (create-rule, canvas, …)
    ui-ux-pro-max/         # UI/UX research + briefs
    ui-styling/            # Tailwind / shadcn styling
    design/                # logos, icons, CIP, slides
    design-system/         # tokens and component specs
```

Nested Firecrawl/home rules under `components/` and `styles/` are unchanged. Merge with those; do not delete them.

## Rules

| Rule | When |
| --- | --- |
| `navroop-product.mdc` | Always — invite-only Navroop shell |
| `secrets.mdc` | Always — never commit `.env.local` |
| `coolify-local-secrets.mdc` | Always — read `.cursor/.env.deploy` for Coolify/SSH; never commit or echo |
| `skills-availability.mdc` | Always — what is in-repo vs profile-only |
| `multi-agent-ownership.mdc` | Always — wait, re-read, merge; one owner per area |
| `single-dev-server.mdc` | Always — one `:3000` server; dedicated agent only (also `prisma generate` / locked Next+Prisma binaries) |
| `keep-cursor-current.mdc` | Always — refresh this map after product/schema/API/layout changes |
| `stack.mdc` | App/lib/prisma TypeScript |
| `brand-theme.mdc` | UI — Navroop, light default |
| `studio-generation.mdc` | Studio chrome + `GenerationProvider` |
| `admin-ownership.mdc` | Admin team/usage/invite files |

## Product map

- **API auth gate** — `proxy.ts` denies `/api` and `/preview-static` by default; the only exceptions are `PUBLIC_API_ROUTES` in `lib/auth/public-routes.ts` (explicit path + methods + reason + mechanism, no wildcards). Coarse JWT check only — no Prisma in the proxy; per-route membership/ADMIN/`isActive` checks stay put. 401s are JSON with a request id. Guarded by `tests/unit/api-route-auth.test.ts`, the `public-routes` verify step, and the probe in `scripts/smoke-test.ts`.
- **No self-fetch between routes** — routes never call sibling routes over HTTP. Shared work sits in `lib/generation/analyze-edit-intent.ts`, `lib/sandbox/read-files.ts`, `lib/sandbox/install-packages.ts`, `lib/sandbox/restart-dev.ts`, `lib/sandbox/detect-packages.ts` (`activeSandboxProvider` + string `runCommand`; live follow-up is `apply-ai-code-stream` → `installPackages`); routes are thin wrappers. `internalCallHeaders` is deleted — do not bring it back. Failures are typed results and are logged; inside a Job use `recordJobStepFailure` (`lib/jobs/step-failure.ts`). Typed misses and unexpected throws from `analyzeEditIntent` / `readSandboxFiles` call `recordJobStepFailure` (`analyze-edit-intent` / `read-sandbox-files`). `apply-ai-code-stream` closes with `applyOutcome` (`lib/jobs/copy.ts`). GenerationWorkspace reuses that sentence via `applyPageCopy`. `/generation` is not a route; `proxy.ts` has no `/generation` redirect. E2B create refuses a missing `getHost` (`sandboxMissingPreviewUrlMessage`; never `https://undefined`). Daytona missing `exitCode` is exit 1 (`lib/sandbox/daytona-command-result.ts`).
- **Lint** — eslint `no-empty` is error so a bare `catch {}` cannot return. A comment inside a catch is allowed only when the failure is a documented expected fallback (see Morph relative/absolute `cat` in `lib/morph-fast-apply.ts`).
- **Instance self-identity** — `lib/runtime/self.ts` `getSelfIdentity()` → `{ coolifyAppUuid, gitSha, instanceId, environment }`. Only reader of `COOLIFY_APP_UUID`; Sentry restart, health rollback route, and `scripts/rollback.ts` share `SELF_UUID_NOT_CONFIGURED`. Shown on `/admin/health`.
- **Projects API** — `/api/projects`, Prisma `Project` (`lib/projects`)
- **Plan/Build** — `ProjectPhase` + `/api/projects/[id]/plan`; workspace chat `plan` \| `build`. First build waits for plan Approve (`decidePendingPromptAction`); opening a project does not boot a sandbox (`shouldRequestSandbox('open')`). A dead first plan with no site resumes to PLANNING, not COMPLETE (`resumablePhaseFromEvidence`; job `filesWritten` is not site evidence). A streamed BUILD that never persisted (`lastCode` / checkpoint) and whose sandbox is FAILED/DEAD settles FAILED (`sandbox_unavailable`) via `settleStreamedGeneration` — not SUCCEEDED + COMPLETE. Chat: the generated files were not saved because the workspace never became ready (or the existing boot error). Recovery Try again starts a new billed build; the last files were not saved.
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
- **Sidebar / workspace** — `components/layout/Sidebar`, default export `GenerationWorkspace` in `components/workspace/GenerationWorkspace.tsx` (imported by `app/project/[id]/page.tsx`). No `GenerationPage` identifier. `app/generation/page.tsx` is gone; `proxy.ts` has no `/generation` redirect. Workspace top bar: Preview/Code labeled, other tabs and device sizes icon-only. Preview device sizes in `lib/preview/devices.ts` (mobile/tablet/desktop, localStorage, rotate, scale-to-fit).
- **Visual Edits** — `lib/visual-edits` + workspace preview toolbar. Static preview HTML gets the inspector at upload time.
- **Static preview** — Prisma `PreviewBuild`, `lib/preview/`, `/preview-static/{projectId}` (or `preview-static.{zone}`) with a signed URL token. Build runs in the generation sandbox then calls `killSandbox`. **Live mode** keeps a sandbox (credits). Idle default `SANDBOX_IDLE_MINUTES` is 5. One generation → one preview capture (per checkpoint); `activePreviewBuildId` adopts only a newer build. `persistProjectGeneration` `previewNotice` reaches chat via `surfacePreviewNotice` in `generation-runtime` (deduped with `saveCurrentProject`).
- **Connectors / GitHub** — `/connectors`, `/api/github`
- **Checkpoints** — `/api/projects/[id]/checkpoints`. Latest snapshot is the source of truth when a sandbox is reaped. `readSnapshot` throws `SnapshotReadError` on a storage/gunzip miss — empty means empty, never "could not read".
- **Sandbox providers** — Prisma `SandboxProviderConfig`, `lib/sandbox/router.ts`, drivers e2b/modal/daytona, ADMIN `/admin/sandbox-providers`, cron `/api/cron/check-sandbox-providers` (every 5 min). Client pages use `lib/sandbox/provider-check-copy` and `lib/security/url-guard-messages` — not `test-run` / `url-guard` (Turbopack 500). `unknown` is eligible (first boot); healthy > unknown > degraded. Pick reason is `selectionReason` / admin **Next pick**. A Job stores that reason on `sandboxAttempts` (`ok` means the boot reached READY, not that `create()` returned a handle; a later ready/install miss flips the last row via `markSandboxAttemptBootFailed`) and lists only cost/credit/priority-outranked eligible skips on `sandboxSkipped` (same English; no secrets). Test and the probe share create + echo + shutdown + a returned preview URL (`healthy` does not mean preview or build); `applyPreviewUrlCheck` rejects empty / unparseable / non-http(s) / `undefined` hostnames without fetching. Probe `lastError` is the same driver-named English as Test. All-skipped probes record a skip, not a silent pass. `monthsRemaining` is null when there is no 30-day burn. `E2B_API_KEY` migrates once then is ignored. Modal boots `node:20` (not Python) and create requests `encryptedPorts: [5173]`. Modal writes use `filesystem.writeText` with `absoluteSandboxPath` — not `printf`+`JSON.stringify`. Daytona's unused-shell fallback is base64; E2B Buffer write was already safe. Test/probe do not `npm install`, start Vite, or fetch the preview URL.
- **Sandbox lifecycle** — `lib/sandbox/manager.ts`, `Project.sandboxStatus`, `/api/projects/[id]/sandbox`, cron `/api/cron/reap-sandboxes` (`SANDBOX_IDLE_MINUTES` default 5; 5 min early idle when no active job). Monthly sandbox minutes on Plan/Workspace; cold start refused when exhausted. A non-zero `npm install` during `setupViteApp` / `installAndStartDev` hard-fails and calls `teardownProvider`. `pollPreviewReady` timeout is `FAILED`, not `READY`. `FAILED` is retryable via `claimBoot`. Three clocks: `BOOT_WAIT_MS` (90s waiter), `BOOT_CLAIM_FRESH_MS` (10 min claim), `READY_POLL_MS` (90s HTTP-ready; `ok` or 304). A lost claim throws instead of a second VM. `waitForInflightOrReady` never awaits itself. `createSandboxOrTerminate` calls `teardownProvider` when `create()` throws — a leak is `sandbox.teardownLeaks` on `/admin/usage`, not "stopped so it is not billed". Minutes accrue on kill and the reaper pass for READY/BOOTING and FAILED rows that still have a `sandboxId` (`bumpStart`). `killSandbox` sets NONE only when teardown is not a leak. All three drivers: reconnect `false` only when gone, throw when uncertain (`probeExisting` writes no DEAD, restores READY). Modal reattaches via `fromId` + `tunnels()`. Copy is graded (`unusedSandboxTeardownSuffix`); reconnect says "is still running and may still be billed". A stale BOOTING steal accrues minutes first. Mid-generation `restartDevServer` polls the same way; a failed restart keeps the code and the VM. E2B `runCommand` parses the printed subprocess return code (`lib/sandbox/e2b-command-result.ts`). E2B `listFiles` throws on unparseable JSON (never `[]`). Object snapshots via `lib/checkpoints/snapshot-store.ts`; legacy `fileSnapshot` is read-only. `Workspace` single-row storage ledger. Crons: reap-sandboxes / reap-jobs / check-sandbox-providers / thin-checkpoints / purge-projects / backup-db / verify-storage.
- **Assets** — `ProjectAsset`, `lib/assets`, `lib/storage`, workspace Assets tab, `/api/projects/[id]/assets`. `s3Get` / `s3Exists` / `localExists` rethrow anything that is not not-found.
- **URL import** — `ImportSource`, `lib/import/`, `POST /api/projects/[id]/import`. Reimagine (default) or replicate. Multi-pass capture → rehost → segment → generate. SSRF: `lib/security/url-guard.ts` + `safeFetch`. Untrusted HTML wrap before prompts. Private-range reject counts on `/admin/usage`. Firecrawl text is typed (`lib/import/firecrawl.ts`) — a failed scrape is not “empty markdown”; chat + `recordJobStepFailure`. Playwright abort vs one-section continue. Empty `filesXml` is not success. Route passes `jobId` to `runProjectUrlImport`. Hard aborts use `import_failed`. SSE client reads `errorPayload.message`. IMPORT Try again is `streamProjectImport`, not a generated build.
- **Skills** — Prisma `Skill`, `lib/skills/`, `/settings/skills` + Brain tab section. Conditional; after cacheable prefix; ADMIN mutations. Distinct from Brain memory.
- **Brain memory** — `MemoryEntry`, `lib/memory/`, workspace Brain tab. Always-on; inside cacheable prefix. Extraction toggle on `/admin/usage`.
- **Quality signals** — `QualitySignal`, `PromptVersion`, `lib/signals/`, `/admin/quality` (ADMIN). Measurement only — no auto prompt changes.
- **Plans / credits** — `Plan` + `CreditLedger` merged onto `Workspace`. `lib/plans/`. Credits stay flat; admin cost is token-based (`lib/consumption/`). Per-job caps + loop detection. Workspace spend ceiling auto-pauses (`pauseReason`). Free default; ADMIN upgrades on `/admin/plans`. No checkout. `/settings/usage`, sidebar meter (credits + sandbox minutes), `/admin/workspace`.
- **Email** — `lib/email/client.ts`. Resend (`RESEND_API_KEY`, `EMAIL_FROM`) or console dev driver. English templates in `lib/email/templates/`.
- **Password reset** — `PasswordResetToken`, `lib/password-reset/`, `/api/auth/forgot-password`, `/reset-password`, `/api/auth/reset-password`. AuthModal forgot panel. ADMIN `/api/admin/team/[id]/reset-link`. Hash-only tokens; generic success; sessions + JWT invalidated after reset.
- **Persistent volume** — `/data` (`DATA_DIR`). Cache + bootstrap only (`lib/runtime/data-dir.ts`). Observability file default `/data/config/observability.json`. See `docs/deployment.md`.
- **Error tracking** — `lib/logger`, `lib/sentry`, `lib/observability/`, `GET /api/health` (DSN + release sha + data dir), `/admin/health` (Error tracking + System checks + AI providers + persistent volume). Sentry DSN/org/token live on Integration `SENTRY` + `OBSERVABILITY_CONFIG_PATH` (not env). Heartbeat/quota crons + `ObservabilityCheck` / `CronRun`. Missing DSN in production is recorded, not treated as “no errors”.
- **Jobs** — Prisma `Job` (`@@map("GenerationJob")`), `lib/jobs/`, publish compensation, boot reconcile, `POST /api/cron/reap-jobs` every minute, `POST /api/cron/cleanup-orphans` daily, workspace + publish recovery panel (`recoveryHeading(kind)`; chat is PLAN/BUILD/FOLLOWUP/IMPORT only; IMPORT Try again is `streamProjectImport`), ADMIN `/admin/jobs` (sandbox choice lines). `listReconcileCandidates` uses `COALESCE("heartbeatAt", "createdAt")`. Terminal writes are `updateJobIfActive` (QUEUED/RUNNING on the same UPDATE); a lost write is the row count (`commitActiveJob` / `abandonActiveJob.wrote`), never a status re-read, so only the winner runs side effects. Chat busy/building follows the latest job (QUEUED/RUNNING only); ABANDONED/FAILED/CANCELLED unlocks chat even if `Project.phase` is still BUILDING. Generate keys: `getEffectiveApiKey` personal → org (admin panel) → env; a rejected key does not fall back to the same vendor's env key. Provider failover/queue in `lib/ai/` (keyless skipped; plan and generate share `shouldFailover`; auth including unregistered-caller/identity, not_found, quota, unavailable, and empty completion fail over; content-policy / request-fault 4xx do not). Stream `onError` is captured (`bindStreamErrorCapture`) because AI SDK `textStream` drops error parts. Zero-file completion walks the rest of the chain once. 30s per attempt. Rejected Gemini copy: "Gemini rejected the API key. Ask an administrator…". First-build all-empty has its own sentence; follow-up no-files keeps "describe the change in a little more detail". Job rows record tokens, estimated USD, provider, model.
- **Team / usage** — `/admin/team`, `/admin/usage`, `/admin/quality`, `/admin/health`, `/admin/jobs`, `/admin/backups`, `/admin/audit`, `/admin/integrations`, `/admin/deploy`, `/admin/servers`, `/admin/plans`, `/admin/workspace`, `/admin/templates`, `/admin/sandbox-providers` (ADMIN). Admin dates: `app/(app)/admin/format-admin-date.ts` (`en-US`). Sandbox provider table: `loadSandboxProvidersAdmin` + `providersFromPayload`. Integrations Sentry redirect: `resolveSentryMeta` (no `window` fallback).
- **Backup / restore** — `lib/backup/`, Prisma `BackupRun`, `scripts/backup-*` / `restore-db` / `verify-storage`, `/admin/backups`. Separate `BACKUP_*` bucket from `ELK_*`. Daily 02:00 `POST /api/cron/backup-db`, weekly `POST /api/cron/verify-storage`.
- **Integrations** — Prisma `Integration`, `lib/integrations/`, `/admin/integrations`. GitHub Manifest + Cloudflare token/zone + Coolify discover + Sentry DSN/OAuth. No publish env vars. Root domain = Cloudflare zone name. Sentry is not required for publish.
- **Publish** — Coolify Preview/Live under the connected zone. `lib/publish/`, GitHub App `lib/github/deploy-client.ts`, Cloudflare `lib/cloudflare/dns.ts`. `/deployments` + workspace Publish sheet. Slot limits via `checkLimit('liveSites'|'previewSites')`, not credits. Requires all three integrations CONNECTED. A READY sandbox list/read failure or a `SnapshotReadError` is `unavailable` (503), not a silent checkpoint / `lastCode` publish.
- **Custom domains** — `lib/domains/`, Prisma `CustomDomain`, workspace Domains tab + `/project/[id]/domains`. Path A client DNS / Path B Cloudflare zone (do not auto-delete). `POST /api/cron/check-domains` every 2 min. `Plan.allowCustomDomain`.
- **Project lock / presence** — `lib/projects/lock.ts` + `ProjectPresence`. Atomic lock on generate/import/publish/audit/restore. Presence GET/POST `/api/projects/[id]/presence`. Workspace avatars, lock bar, stale banner (`contentVersion`). Daily prune via thin-checkpoints.
- **Coolify** — `docker-compose.yml` + `Dockerfile` (see `docs/coolify.md`); local Postgres `docker-compose.dev.yml` on `5433`. `NEXT_PUBLIC_APP_URL` is set in the compose file and `assertInternalOrigin()` refuses to boot in production if it is unset, unparseable, or a different host from `APP_URL` (warn-only elsewhere). API client `lib/coolify/`; token from Integration / `CoolifyServer`. `POST /api/admin/servers` is 410 — configure at `/admin/integrations`. No `COOLIFY_*` compose env. Local logins: `.cursor/.env.deploy` (gitignored).
- **Verify / release** — `pnpm run verify` / `verify:full` (includes the `public-routes` allowlist step, which prints the allowlist size). Vitest in `tests/unit` + `tests/integration` (legacy tsx suites wired). Unit-test `fetch` to loopback needs `allowLocalhost('reason')` (`tests/setup/network-guard.ts`). Coverage floors are 49/70/65/49 — raise, never lower. Only one `vitest --coverage` in a checkout (`coverage/.tmp`). Repo-write guard is Vitest `globalSetup`. Secret scan exit 2 is a broken gate, not a pass. Playwright `e2e/` (`critical` = journeys 1–4). Playwright CI `webServer` inherits env from `lib/verify/playwright-env.ts` (`.env` / `.env.local` + test-only `ENCRYPTION_KEY` fallback). Test DB `TEST_DATABASE_URL` ≠ `DATABASE_URL`. Schema drift shadow DB `openlovable_shadow` / `SHADOW_DATABASE_URL` (never the app or test DB). High/critical audit via `pnpm.overrides` (do not drop `pnpm audit --audit-level=high`; install only after `:3000` is stopped). `tsc --noEmit` excludes generated `.next` / `next-env.d.ts` route types (`types/next-env.d.ts` keeps `next` refs). Husky + `.github/workflows/verify.yml`. Rollback on `/admin/health`. Runbook `docs/release.md`.

## Superpowers

Skills are copies of the Superpowers plugin so agents do not depend only on the user plugin cache.

1. Read `.cursor/skills/superpowers/using-superpowers/SKILL.md` at the start of a task.
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
