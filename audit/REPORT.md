# Navroop — read-only audit report

Audit of `D:\xampp\htdocs\Navroop-UI-UX` at `ai-genration-improvements` / `255d5fb`.
Nine phases, disjoint scopes, 1859 inventoried files. **No application code, config, schema,
test or doc was modified.** The only files written are in `audit/`.

| Artefact                    | Contents                                                                                        |
| --------------------------- | ----------------------------------------------------------------------------------------------- |
| `00-inventory.md`           | the ledger: every file, its area, and its verdict                                               |
| `00-map.md`                 | route inventory, job state machine, data model, invariants (with one correction made mid-audit) |
| `01-prompt-generation.md`   | A prompt intake, B generation pipeline, C provider keys (F-001…F-099)                           |
| `02-chat-images-preview.md` | D chat, E images, F preview (F-100…F-199)                                                       |
| `03-deploy-git.md`          | G deploy, H git push (F-200…F-299)                                                              |
| `04-security-data.md`       | I auth/ownership, J data layer (F-300…F-399)                                                    |
| `05a-ux.md`                 | K UX, errors, accessibility (F-400…F-499)                                                       |
| `05b-skills-memory.md`      | L skills, M docs and memory (F-500…F-599)                                                       |
| `06-tests-crosscutting.md`  | N tests and the verify gate, O cross-cutting (F-600…F-699)                                      |
| `07-everything-else.md`     | P everything the brief did not name (F-700…F-799)                                               |
| `08-gap-closure.md`         | the 19 files Phase 7 read only partially, re-read in full (F-800…F-849)                         |
| `_route-gates.md`           | mechanical route/gate scan used to cross-check Phase 4                                          |

---

## 1. Executive summary

**The single most important fact in this report is that the product map is describing a
subsystem that no longer exists.** Migration `20260819010000_drop_sandbox_columns` removed the
sandbox VM subsystem. `lib/sandbox/` is absent, `PreviewMode` has one member (`STATIC`,
`prisma/schema.prisma:41-43`), and `SandboxStatus` / `SandboxProviderConfig` are gone from the
schema. `AGENTS.md` — the file the audit brief instructs every agent to trust — still documents
it across 17 lines, `README.md` tells operators to schedule two cron endpoints that 404, and an
always-on Cursor rule still assigns ownership of `lib/sandbox/**`. Three independent phases hit
this from different directions (F-141, F-520, F-521, F-522, F-523, F-700-series). It is also
the root of a large share of Section P: scaffolding, email templates, quality metrics, audit
checks, `.env` files and a whole npm package were left pointing at the deleted code, and several
of them now silently return success instead of failing.

Beyond that, four themes:

**Silent success is the dominant failure mode.** The recurring defect in this codebase is not a
crash — it is a path that charges the user, does nothing, and reports fine. A paid SEO/code
audit that fails detached and clears its own error state (F-819). Quality signals that record a
perfect 1.0 for type-safety, a11y and build success on projects never analysed, because a
failure finding lands in a category no counter reads (F-705, confirmed with a different
mechanism than first filed). `initSentryClient()` that never calls `Sentry.init`, so every
browser error since it shipped went nowhere while source maps uploaded on each build (F-703).
Admin dashboards that render "Nothing needs attention" over swallowed Prisma errors (F-404).
A Sentry quota check that reports a healthy quiet project when the API call failed (F-631).

**The generation pipeline has substantial dead machinery.** `global.sandboxState` has no writer
anywhere in the repo, and everything gated on it is unreachable: the agentic edit-search block,
`lib/context-selector.ts` with `lib/edit-intent-analyzer.ts` and `lib/edit-examples.ts` behind it
(F-026, F-800). `parseGenerationFiles` and `assertWritableGenerationFile` — the 2 MB/8 MB/binary
and `package.json` guards — have no production callers (F-028). The `buildFix` auto-repair loop
is disconnected at both ends (F-021). Package detection is three detection paths, three frame
types and a full install progress UI that `runApplyStream` ignores (F-090). `lib/file-parser.ts`
and `packages/create-open-lovable/**` are fully dead (F-800, F-841).

**Credentials and cross-tenant boundaries are mostly sound, with sharp exceptions.** Phase 4
followed all 30 "no gate helper" routes into their action modules and found every one correctly
gated — zero IDOR. But provider API keys are stored in plaintext while every other credential in
the same schema is AES-256-GCM (F-300), a decrypt failure returns the raw ciphertext _as the API
key_ (F-071), the seed unconditionally creates a known-password member account (F-301), and the
login rate limiter keys on an unvalidated `X-Forwarded-For` (F-302).

**The gate that is supposed to catch all of this has holes.** `tests/setup/env.ts` — the file
that redirects `DATABASE_URL` to `TEST_DATABASE_URL` — is not in `vitest.config.ts` `setupFiles`
(F-600). Both fatal Playwright steps default to `:3000`, which on this machine is a _different
git worktree_ (F-620). Ten `'use server'` modules totalling ~2,100 lines, each the only
authorization on its path, are loaded by no test (F-613). Thirteen assertions cannot fail.

### Verdict

The product's happy path works — this audit ran against a live instance that builds sites, and
the earlier verified end-to-end run in this repository proves it. What is weak is everything
around the edges of that path: the failure paths, the money paths, the operator paths, and the
documentation an agent or a new engineer would trust. The three things I would fix before
anything else are the preview origin (F-140), the restore guard (F-701), and the empty-prompt
resource leak (F-001), because each one is cheap to fix and expensive to hit.

---

## 2. Findings by severity

Counts are the per-phase totals as filed. Phase 6 grouped some multi-instance findings under one
id, so the severity sum (504) slightly exceeds the distinct-id count (495).

| Severity              | Count   |
| --------------------- | ------- |
| CRITICAL              | 8       |
| HIGH                  | 77      |
| MEDIUM                | 238     |
| LOW                   | 96      |
| GAP                   | 42      |
| IMPROVEMENT           | 43      |
| **Distinct findings** | **495** |

### CRITICAL (8)

| id        | title                                                                                                                                                                                                                                                           | location                                                                                                                               | phase |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| **F-140** | Static preview serves model-authored HTML/JS from the application's own origin, `unsafe-inline`/`unsafe-eval` CSP, opened top-level with no sandbox — generated JS can call `/api/*` with the user's session                                                    | `lib/preview/url.ts:15-16`, `lib/preview/headers.ts:8`, `lib/preview/devices.ts:81-87`, `components/workspace/WorkspaceTopBar.tsx:416` | 02    |
| **F-701** | `assertRestoreTarget` compares URL _text_, so `postgres://` vs `postgresql://` (or an omitted default port) lets `pg_restore` aim at production. Reproduced.                                                                                                    | `lib/backup/assert.ts:50-72`                                                                                                           | 07    |
| **F-001** | An empty prompt checks credits, creates the job, takes the lock with a renew timer, takes a queue slot and starts the heartbeat, then returns 400 through a `try` with no `finally` — two calls halt generation for the whole installation                      | `app/api/generate-ai-code-stream/route.ts:276,290,305,377,503-511,2247`                                                                | 01    |
| **F-020** | "Keep what was built" on a failed edit replaces `lastCode` with only `Job.partialFiles`, deleting the rest of the site, then checkpoints the damaged tree                                                                                                       | `lib/jobs/recovery.ts:81-90` vs `lib/jobs/settle-generation.ts:254-255`                                                                | 01    |
| **F-702** | Backup retention has no keep-newest floor: a skewed clock empties the bucket in the same run that wrote a good dump                                                                                                                                             | `lib/backup/retention.ts:22-53`, `lib/backup/db.ts:128-132`                                                                            | 07    |
| **F-520** | `AGENTS.md` documents the deleted sandbox subsystem across 17 lines, including two whole bullets — the file every agent is told to trust as the product map                                                                                                     | `AGENTS.md:3,37,40,43,50,53,55,56,57,59,63,65,68,69,74,78,96`                                                                          | 05b   |
| **F-521** | `README.md` tells operators to schedule `/api/cron/reap-sandboxes` and `/api/cron/check-sandbox-providers` (both 404) and omits the real `cleanup-orphans` and `system-checks-digest` — the latter being the one whose absence is indistinguishable from health | `README.md:82-87,124-129`                                                                                                              | 05b   |
| **F-202** | A project slug matching an existing organisation repo makes publish force-push over it                                                                                                                                                                          | `lib/github/deploy-client.ts:162-196,213-250`, `lib/publish/naming.ts:22-24`                                                           | 03    |

### HIGH (77) — the ones that change what you would do on Monday

Full text for every id is in the phase files. The highest-value subset:

| id                | title                                                                                                                                                                                                        | location                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| F-300             | Provider API keys stored plaintext while every sibling credential is encrypted                                                                                                                               | `prisma/schema.prisma:414-433`, `lib/api-keys/actions.ts:86,119`                          |
| F-071             | `decodeStoredSecret` returns raw ciphertext **as the API key** when decryption fails                                                                                                                         | `lib/api-keys.ts:65-72`                                                                   |
| F-703             | `initSentryClient()` never calls `Sentry.init` — browser error reporting is a no-op, source maps upload anyway                                                                                               | `lib/sentry/client.ts:1-7`, `next.config.ts:51`                                           |
| F-819             | Paid SEO/code audit fails detached, the client clears its own error, credits already charged                                                                                                                 | `lib/seo/actions.ts`, `hooks/useCodeAudit.ts:27`                                          |
| F-705             | Quality signals record constant 1.0 type-safety, a11y and build scores for projects never analysed                                                                                                           | `lib/audit/tool-fail.ts:8-9` vs `lib/audit/findings.ts:86-89`, `lib/audit/actions.ts:132` |
| F-600             | `tests/setup/env.ts` is not in `setupFiles`, so the test-DB redirect is per-file, not global                                                                                                                 | `vitest.config.ts:24`                                                                     |
| F-620             | Both fatal Playwright steps default to `:3000`, which is a different git worktree here                                                                                                                       | `playwright.config.ts:7,68` vs `AGENTS.md:26-28`                                          |
| F-613             | Ten `'use server'` modules (~2,100 lines), each the only authorization on its path, are loaded by no test                                                                                                    | `lib/{templates,audit,seo,memory,skills,api-keys,coolify,github}/…`                       |
| F-120             | `NEED_IMAGE:` tokens ship raw on the URL-import path — documented invariant violated                                                                                                                         | `lib/import/persist.ts:59-88`                                                             |
| F-122             | "Generated images carry no text" holds only for the worker; OpenAI/Imagen get the bare prompt                                                                                                                | `lib/assets/generate-image.ts:187-189`                                                    |
| F-121             | Asset upload has no size limit, no MIME/magic-byte check, no rate limit; sharp runs at default 268 MP                                                                                                        | `lib/assets/actions.ts:155-181`, `lib/assets/optimize.ts:14-40`                           |
| F-100/F-101       | `global.conversationState` leaks one project's user messages into another's memory extraction and checkpoint labels                                                                                          | `lib/memory/extract.ts:47-58`, `lib/checkpoints/actions.ts:82-93`                         |
| F-102             | "Preview this version" is an unmarked destructive rollback of `Project.lastCode`                                                                                                                             | `lib/checkpoints/actions.ts:342-366`                                                      |
| F-142/F-143       | The static preview is built on every generation and can never be displayed; Visual Edits is inoperable                                                                                                       | `hooks/useStaticPreview.ts:73-89`, `PreviewPanel.tsx:111-124`                             |
| F-144             | `previews/` objects leak permanently on project delete; `storageBytes` never decremented                                                                                                                     | `lib/checkpoints/purge-deleted.ts:69-72,109-111`                                          |
| F-301             | Seed unconditionally creates `member@navroop.local` with a committed password                                                                                                                                | `prisma/seed.ts:52-70,110`                                                                |
| F-302             | Login/forgot-password rate limit keys on unvalidated `X-Forwarded-For`; the allowlist advertises limits that do not exist                                                                                    | `lib/password-reset/rate-limit.ts`, `lib/auth/public-routes.ts:118`                       |
| F-303             | `/api/conversation-state` is a process-global with no tenant key; any member's page mount resets it for everyone                                                                                             | `app/api/conversation-state/route.ts:7,44`                                                |
| F-305             | `rollCreditPeriodIfNeeded` has no `periodStart` guard — a concurrent roll at the month boundary erases a debit                                                                                               | `lib/plans/limits.ts:87-99`                                                               |
| F-306             | `notifyAdminsCredit80` never calls `mailAdmins` — the 80% credit email has never been sent                                                                                                                   | `lib/plans/alerts.ts`                                                                     |
| F-200/F-201       | Publish bypasses `buildRepoFiles` (no scaffold/Dockerfile/package.json) and has no exclusion list, so `.env` is committed to the deploy repo                                                                 | `lib/publish/execute.ts:293-310`, `lib/publish/files.ts:10-18`                            |
| F-203/F-204/F-205 | Double-click publish runs two runners over one job; the poll step reads app health so every re-publish reports LIVE immediately; an abandoned re-publish leaves `Deployment` on BUILDING forever             | `lib/publish/execute.ts:203-207,437-454`, `lib/jobs/compensate-publish.ts:73-83`          |
| F-210             | Connectors push force-replaces the whole tree in the user's own repository                                                                                                                                   | `lib/github/git-data.ts:100-173`                                                          |
| F-208             | Domain verify token leaks to read-only viewers through `lastError`                                                                                                                                           | `lib/domains/errors.ts:13-14`, `lib/domains/list.ts:33`                                   |
| F-022             | Cancel is DB-only: no `AbortController` reaches the stream, tokens are paid in full, then the result is discarded                                                                                            | `app/api/generate-ai-code-stream/route.ts`                                                |
| F-023             | `filesFromReply` keeps undeclared-path fences as `file.<ext>`, so a prose reply with one code fence is persisted as the project and reported as success                                                      | `lib/generation/parse-blocks.ts`                                                          |
| F-700             | `.npmrc dangerouslyAllowAllBuilds=true` voids the 10-package `allowBuilds` allowlist beside it                                                                                                               | `.npmrc:1`                                                                                |
| F-704             | `pre-migrate` reads `_prisma_migrations` fatally, so a first production deploy against an empty database crash-loops                                                                                         | `scripts/pre-migrate.ts:32-45`                                                            |
| F-707             | `executeCoolifyRollback` hits the plain redeploy endpoint with an invented header — rollback redeploys the broken release and prints success                                                                 | `lib/deploy/rollback.ts:32-50`                                                            |
| F-708             | No cron has overlap protection, and a killed run leaves no record at all                                                                                                                                     | `lib/cron/handle.ts:7-33`                                                                 |
| F-709             | The unauthenticated password-reset limiter is an unbounded in-process `Map`, and refused requests still burn a bcrypt                                                                                        | `lib/password-reset/rate-limit.ts:7-24`                                                   |
| F-710             | `copy-preview-vendor.mjs` exits 0 when `esbuild.wasm` is missing, shipping a build whose only rendering path cannot start                                                                                    | `scripts/copy-preview-vendor.mjs:15-18`                                                   |
| F-713             | `.dockerignore` patterns are root-anchored, so nested `node_modules`/`.next`/`.env` and a sibling worktree enter the build context                                                                           | `.dockerignore:1-24`                                                                      |
| F-501/F-503       | 16 copied `cursor/*` skills drive Cursor-only tools and paths; the `shell` skill says "execute immediately, do not inspect the repository first" and its only guard is a frontmatter key Claude Code ignores | `.claude/skills/**`                                                                       |
| F-630/F-631       | `sentryBeforeSend` never scrubs `message`/`exception`/`tags`/`user`; a failed Sentry API call reports a healthy quiet project                                                                                | `lib/sentry/scrub.ts:47-86`, `lib/observability/sentry-api.ts:40,44,82`                   |
| F-400             | `styles/main.css:277-283` globally deletes the focus ring from every text input with `!important` (WCAG 2.4.7)                                                                                               | `styles/main.css:277-283`                                                                 |
| F-403/F-404       | Admin loaders are `try/finally` with no `catch`; `/admin` prints "Nothing needs attention" over swallowed Prisma errors                                                                                      | `app/(app)/admin/page.tsx:67-80,124-128`                                                  |
| F-447             | `client-import-boundary.test.ts` does not cover what its name claims — `lib/`+`hooks/` client modules unscanned, half the Node builtins missing, bare specifiers never resolved                              | `tests/unit/client-import-boundary.test.ts`                                               |

MEDIUM (238), LOW (96), GAP (42) and IMPROVEMENT (43) are filed in full in the phase files,
each with location, trigger, impact, confidence and a suggested fix.

---

## 3. Independent verification performed by the coordinator

The brief requires confirmation before filing. I re-opened and confirmed these myself rather
than accepting the phase agent's word, and two of my checks changed a finding:

| Finding          | What I did                                                                                                    | Outcome                                                                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F-140            | Read `url.ts:15-16`, `headers.ts:8`, `public-routes.ts:172-183`, `devices.ts:81-87`, `BrowserPreview.tsx:388` | **Confirmed CRITICAL.** In-app iframe is correctly sandboxed with no `allow-same-origin`; the _open in new tab_ path is top-level and first-party                                    |
| F-001            | Read the setup ordering at `:276,290,305,377` against the guard at `:503` and the handlers at `:2203,2247`    | **Confirmed CRITICAL** — no `finally` at that level                                                                                                                                  |
| F-300            | Read `lib/api-keys/actions.ts:69-124`                                                                         | **Confirmed** — raw `secret` on both create and update, no `encrypt()`, while `lib/settings/resolve.ts` encrypts                                                                     |
| F-301            | Read `prisma/seed.ts:52-70,110` and checked Docker/compose for auto-seed                                      | **Confirmed, severity nuanced** — no env guard, but production start is `pre-migrate` + `migrate deploy`, so it needs an operator to seed                                            |
| F-303            | Read the route and traced its only caller                                                                     | **Confirmed, impact corrected** — the app calls only the mutating `clear-old` branch, so the concrete harm is a process-wide reset; the `GET` leak is reachable by hand              |
| F-401            | `curl` against the running dev server                                                                         | **Phase 5's claim was wrong** — `/builder` returns `307 → /?auth=login`. Re-filed LOW after the agent proved nothing links to it and it bails without a removed `sessionStorage` key |
| F-141/F-520      | `ls lib/sandbox`, `grep` the schema, list migrations                                                          | **Confirmed** — directory absent, `PreviewMode` has one member. I corrected my own `00-map.md`, which had inherited the error from AGENTS.md                                         |
| Route gates      | Built `_route-gates.md` and read `app/api/team/route.ts` → `lib/team/actions.ts:75-101`                       | **Warned Phase 4 off 30 false positives**; it then followed every one into its action module and filed zero IDOR                                                                     |
| F-600            | Read `vitest.config.ts:24` and `tests/setup/vitest.setup.ts`                                                  | **Confirmed mechanism**; noted Prisma connects lazily, so exposure is bounded to unit tests that actually query                                                                      |
| page-vs-API gate | Read `proxy.ts:32-33,49-59,108,143-150`                                                                       | **New MEDIUM**: page decisions use cookie _presence_, API uses real JWT verification — a stale cookie renders shells and is bounced away from `/login`                               |

---

## 4. Coverage ledger

|                                                       | Files    | Lines   |
| ----------------------------------------------------- | -------- | ------- |
| Inventoried (non-generated, non-vendored)             | **1859** | 228,899 |
| REVIEWED                                              | **1858** | —       |
| NOT REVIEWED                                          | **1**    | —       |
| Read partially in Phase 7, re-read in full in Phase 8 | 19       | ~4,700  |
| Still PENDING                                         | **0**    | —       |

**The one file not reviewed:** `.cursor/.env.deploy` — a secrets file whose read is denied by
`.claude/settings.json:7`. Its gitignore and tracking status were verified instead (ignored, not
tracked), which is the property that matters.

Excluded as generated/vendored, with reasons, in `00-inventory.md`: `node_modules/**`,
`.next/**`, `generated/**`, `coverage/**`, `playwright-report/**`, `test-results/**`,
`.worktrees/**` and `.claude/worktrees/**` (other agents' checkouts, ground rule 6),
`public/uploads/**`, lockfiles, `tsconfig.tsbuildinfo`, the 507 KB root `index.html`, and binary
assets.

---

## 5. Prioritised fix backlog

**P0 — before the next deploy**

1. **F-701** restore-target guard: compare parsed components (host, port with protocol default, database), not URL text. One function, catastrophic blast radius.
2. **F-140** preview origin: serve static previews from a separate origin always, or sandbox the top-level open; drop `unsafe-inline`/`unsafe-eval` from the preview CSP.
3. **F-001** wrap the generate handler's setup in `try/finally` and validate the prompt _before_ credits, lock, job, queue slot and heartbeat.
4. **F-020** make "Keep what was built" merge into the existing tree exactly as `settle-generation.ts` already does, and bump `contentVersion` + run the image sweep.
5. **F-702** give retention a keep-newest floor that cannot be defeated by a clock.
6. **F-202** refuse to push when the target repo exists and was not created by this project.

**P1 — this week**

7. **F-300 / F-071** encrypt `ApiKey`/`OrgApiKey` with the existing helper; make a decrypt failure an error, never a returned key.
8. **F-520 / F-521 / F-522 / F-523** delete the sandbox subsystem from AGENTS.md, README, `.cursor/README.md` and the always-on rule; document the real cron set and the browser-preview architecture that replaced it.
9. **F-703** call `Sentry.init` in the client entry, or stop uploading source maps.
10. **F-819 / F-705** surface detached audit failures and fix the category mismatch that pins three quality scores at 1.0.
11. **F-600 / F-620** put `tests/setup/env.ts` in `setupFiles`; pin Playwright's `baseURL` to the checkout's own port.
12. **F-301 / F-302** guard the seed on `NODE_ENV`; key the rate limiter on a trusted client address.
13. **F-201** add an exclusion list to the publish file collector before `.env` reaches another repo again.

**P2 — the dead-code sweep, as one deliberate change**

14. Remove or wire, with a decision recorded per item: `global.sandboxState` and everything behind it (`lib/context-selector.ts`, `lib/edit-intent-analyzer.ts`, `lib/edit-examples.ts`), `lib/file-parser.ts`, `packages/create-open-lovable/**`, `app/builder/page.tsx`, the `buildFix` loop, the package-detection UI, and the unreferenced `parseGenerationFiles` guards. Each is small; together they are why the map no longer matches the territory.

**P3 — the long tail**

15. Work the MEDIUM list per phase file, starting with the ones that silently swallow (`F-403`, `F-404`, `F-631`, `F-306`) — the same class as the P0/P1 items, one severity down.
