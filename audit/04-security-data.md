# Phase 4 — Section I (auth, ownership, multi-tenancy) and Section J (data layer)

Scope: `audit/_scope-p4.txt`, 172 files. Every file was opened. Findings ids `F-300`–`F-399`.

**Method note.** A route that contains no gate helper is _not_ evidence of a missing gate in
this repo: the dominant pattern is a thin `route.ts` wrapper over a `'use server'` action
module that gates. For every route below I followed the call into the module that actually
runs the check and recorded the gate I found _there_, naming the function. Nothing is filed
as unguarded on the strength of a grep. The 30-odd "no gate helper found" rows in
`audit/_route-gates.md` were all resolved this way and **none of them is an IDOR**.

**Product model.** Navroop is a single-workspace product (`Workspace.id = 'default'`,
`lib/auth/route-policy.ts:8-11`). Reads are deliberately workspace-wide — `listProjects`
shows every member every project (`lib/projects/actions.ts:216-262`), and
`app/api/projects/[id]/files/route.ts:33-40` and `app/api/projects/[id]/preview/route.ts:20-31`
both carry an explicit comment saying so. Writes are owner-or-ADMIN via `canMutate`. I checked
every mutating route in scope against that rule; one write route has inherited the read gate
(F-323) and it is the only one.

---

## I.1 Route ownership matrix (all 97 API route files in scope)

`Gate` names the function whose source I read. `→` means the route delegates and the gate is
in the named module.

### `app/api/admin/**` — 38 files

| route                                | methods          | who can call | ownership / authz check performed                                                              | verdict           |
| ------------------------------------ | ---------------- | ------------ | ---------------------------------------------------------------------------------------------- | ----------------- |
| `admin/api-keys`                     | GET, PUT         | ADMIN        | → `lib/api-keys/actions.ts:47` `listOrgApiKeys` / `:107` `setOrgApiKey`, both `requireAdmin()` | OK                |
| `admin/audit`                        | GET              | ADMIN        | `requireAdmin()` route:9                                                                       | OK                |
| `admin/backups`                      | GET              | ADMIN        | `requireAdmin()` route:8                                                                       | OK                |
| `admin/backups/run`                  | POST             | ADMIN        | `requireAdmin()` route:8                                                                       | OK                |
| `admin/deploy`                       | GET, PUT         | ADMIN        | → `lib/coolify/actions.ts:24` / `:41`, `requireAdmin()`                                        | OK                |
| `admin/deploy/test`                  | POST             | ADMIN        | → `lib/coolify/actions.ts:76`, `requireAdmin()`                                                | OK                |
| `admin/health/rollback`              | POST             | ADMIN        | `requireAdmin()` route:13 + typed confirmation + `writeAudit`                                  | OK                |
| `admin/health`                       | GET              | ADMIN        | `requireAdmin()` route:8                                                                       | OK                |
| `admin/health/sentry-test`           | POST             | ADMIN        | `requireAdmin()` route:9                                                                       | OK                |
| `admin/integrations/check`           | POST             | ADMIN        | `requireAdmin()` route:10 + kind allowlist                                                     | OK                |
| `admin/integrations/disconnect`      | POST             | ADMIN        | `requireAdmin()` route:11 + typed confirmation + `writeAudit`                                  | OK                |
| `admin/integrations`                 | GET              | ADMIN        | `requireAdmin()` route:6                                                                       | OK                |
| `admin/integrations/sentry/restart`  | POST             | ADMIN        | `requireAdmin()` route:6 + typed confirmation                                                  | OK                |
| `admin/invite`                       | POST             | ADMIN        | `requireAdmin()` route:17 + member limit + `writeAudit`                                        | OK                |
| `admin/jobs/[id]/abandon`            | POST             | ADMIN        | `requireAdmin()` route:10 + `writeAudit`                                                       | OK                |
| `admin/jobs`                         | GET              | ADMIN        | `requireAdmin()` route:9                                                                       | OK                |
| `admin/plans`                        | GET, POST, PATCH | ADMIN        | `requireAdmin()` route:7 / :16 / :49                                                           | OK (F-312, F-316) |
| `admin/quality`                      | GET              | ADMIN        | `requireAdmin()` route:8                                                                       | OK                |
| `admin/servers/[id]`                 | PATCH, DELETE    | ADMIN        | → `lib/coolify/server-actions.ts:31` / `:68` / `:88`, `requireAdmin()`                         | OK                |
| `admin/servers/[id]/test`            | POST             | ADMIN        | → `lib/coolify/server-actions.ts:106`, `requireAdmin()`                                        | OK                |
| `admin/servers`                      | GET, POST        | ADMIN        | → `server-actions.ts:8` / `:17`; POST is a deliberate 410                                      | OK                |
| `admin/settings/github-app/callback` | GET              | ADMIN        | `requireAdmin()` route:16 + OAuth `state` bound to `csrf.userId === user.id` (route:31)        | OK                |
| `admin/settings/github-app/start`    | GET              | ADMIN        | `requireAdmin()` route:22; emits self-submitting form, attrs escaped (route:18)                | OK                |
| `admin/settings`                     | GET, PUT         | ADMIN        | `requireAdmin()` route:6 / :12 + registry key allowlist                                        | OK                |
| `admin/settings/test`                | POST             | ADMIN        | `requireAdmin()` route:9 + group allowlist                                                     | OK                |
| `admin/team/[id]/reset-link`         | POST             | ADMIN        | `requireAdmin()` route:9                                                                       | OK                |
| `admin/team`                         | GET              | ADMIN        | `requireAdmin()` route:16, `take: 500`                                                         | OK                |
| `admin/templates/[id]`               | PATCH, DELETE    | ADMIN        | → `lib/templates/actions.ts:288` / `:318`, `requireAdmin()`                                    | OK                |
| `admin/templates/[id]/test`          | POST             | ADMIN        | → `lib/templates/actions.ts:330`, `requireAdmin()`                                             | OK                |
| `admin/templates/[id]/thumbnail`     | POST             | ADMIN        | → `lib/templates/actions.ts:336`, `requireAdmin()`; size 32 B–4 MB                             | OK                |
| `admin/templates`                    | GET, POST        | ADMIN        | → `lib/templates/actions.ts:246` / `:258`, `requireAdmin()`                                    | OK                |
| `admin/templates/thumbnails`         | POST             | ADMIN        | → `lib/templates/actions.ts:346`, `requireAdmin()`                                             | OK                |
| `admin/usage/by-member`              | GET              | ADMIN        | `requireAdmin()` route:7                                                                       | OK                |
| `admin/usage/project/[id]`           | GET              | ADMIN        | `requireAdmin()` route:9                                                                       | OK                |
| `admin/usage/quality`                | GET              | ADMIN        | `requireAdmin()` route:7                                                                       | OK                |
| `admin/usage`                        | GET              | ADMIN        | `requireAdmin()` route:14, `take: 500`                                                         | OK                |
| `admin/usage/summary`                | GET              | ADMIN        | `requireAdmin()` route:7                                                                       | OK                |
| `admin/workspace`                    | GET, PATCH       | ADMIN        | `requireAdmin()` route:7 / :14 + `writeAudit` on pause flip                                    | OK                |

No admin-only setting is reachable from a non-admin route. `saveSettings` (`lib/settings/resolve.ts`)
has exactly two callers in scope, `admin/settings` PUT and `admin/settings/github-app/callback`
GET, and both `requireAdmin()` first.

### `app/api/auth/**` — 9 files

| route                  | methods   | who can call       | check performed                                                           | verdict             |
| ---------------------- | --------- | ------------------ | ------------------------------------------------------------------------- | ------------------- |
| `auth/[...nextauth]`   | GET, POST | public, per action | Auth.js CSRF double-submit; 13 actions listed one by one in the allowlist | OK                  |
| `auth/dev-login`       | POST      | public             | `isDevQuickLoginEnabled()` route:9 → 404 in production                    | OK                  |
| `auth/forgot-password` | POST      | public             | generic response; rate limit in `lib/password-reset/service`              | F-302, F-304        |
| `auth/login`           | POST      | public             | `signIn('credentials')`; `allowLoginAttempt()` route:32                   | F-302, F-304, F-321 |
| `auth/logout`          | POST      | public             | clears caller's own cookie only                                           | OK                  |
| `auth/me`              | GET       | session            | not allowlisted → proxy 401; `getSessionUser()` route:13                  | OK                  |
| `auth/register`        | POST      | public             | unconditional 403, body never read                                        | OK                  |
| `auth/reset-password`  | POST      | public             | single-use sha256 token                                                   | OK                  |
| `auth/signup`          | POST      | public             | unconditional 403                                                         | OK                  |

### `app/api/cron/**` — 14 files in scope

All fourteen call `handleCron(name, request, fn)` (`lib/cron/handle.ts:11`) →
`authorizeCron` (`lib/cron/auth.ts:4-12`): Bearer token compared against the
`app.cronSecret` setting with a length check then `timingSafeEqual`, and **fail-closed** when
the secret is unset. No session is consulted, no user data is returned. **Verdict: OK** for
`backup-db`, `check-certs`, `check-domains`, `check-integrations`, `check-uptime`,
`cleanup-orphans`, `observability-heartbeat`, `observability-quota`, `purge-projects`,
`reap-jobs`, `sweep-tmp`, `system-checks-digest`, `thin-checkpoints`, `verify-storage`.

### `app/api/projects/**`, `deployments`, `settings`, `team`, `templates`, misc — 36 files

| route                           | methods           | who can call  | ownership check performed                                                                                                               | verdict    |
| ------------------------------- | ----------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `projects`                      | GET               | any member    | → `listProjects` `requireUser()` `actions.ts:216`; workspace-wide by design                                                             | OK (F-314) |
| `projects`                      | POST              | any member    | → `createProject` `actions.ts:100` + `checkLimit('projects')`                                                                           | OK (F-307) |
| `projects/[id]`                 | GET               | any member    | → `getProject` `actions.ts:281`, session only; workspace-wide read by design                                                            | OK         |
| `projects/[id]`                 | PATCH             | owner / ADMIN | → `updateProject` `canMutate` `actions.ts:311`; `persistProjectGeneration` `canMutate` `actions.ts:~468`                                | OK         |
| `projects/[id]`                 | DELETE            | owner / ADMIN | → `deleteProject` `canMutate` `actions.ts:333`                                                                                          | OK         |
| `projects/[id]/duplicate`       | POST              | owner / ADMIN | → `duplicateProject` `canMutate` `actions.ts:~382`                                                                                      | OK         |
| `projects/[id]/export`          | GET               | any member    | `getSessionUser()` route:22 + `allowExport` 5/h; no owner check — matches the documented shared-read boundary                           | OK, noted  |
| `projects/[id]/lock/release`    | POST              | ADMIN         | `getSessionUser()` route:11 + `user.role !== 'ADMIN'` route:12 + `writeAudit`                                                           | OK         |
| `projects/[id]/presence`        | GET, POST         | any member    | `getSessionUser()` route:41 / :55; presence is workspace-wide by design                                                                 | OK         |
| `projects/[id]/quality-signals` | POST              | any member    | `getSessionUser()` route:11 **only** — a write with the read gate                                                                       | **F-323**  |
| `projects/[id]/restore`         | POST              | owner / ADMIN | → `restoreProject` `canMutate` `actions.ts:357`                                                                                         | OK         |
| `deployments`                   | GET               | any member    | → `listWorkspaceDeployments` `getSessionUser()` `lib/publish/actions.ts:247`                                                            | OK         |
| `deployments/[id]`              | POST              | owner / ADMIN | → `stopDeploymentAction` `:277`, `redeployAction` `:296`, `deleteDeploymentAction` `:311`; each loads `project.ownerId` and `canMutate` | OK         |
| `settings/api-keys`             | GET, PUT, DELETE  | self          | → `lib/api-keys/actions.ts:22` / `:70` / `:128`, `requireSessionUser()`, all queries scoped `userId: user.id`                           | OK (F-300) |
| `settings/credits`              | GET               | any member    | → `getCreditMeter` `getSessionUser()` `lib/plans/actions.ts:~330`                                                                       | OK         |
| `settings/password`             | PATCH             | self          | → `changePassword` `requireSessionUser()` `lib/profile/actions.ts:85` + current-password re-verify                                      | OK         |
| `settings/profile`              | PATCH             | self          | → `updateProfile` `requireSessionUser()` `lib/profile/actions.ts:31`, writes `where: { id: user.id }`                                   | OK         |
| `settings/storage`              | GET               | any member    | `getSessionUser()` route:8                                                                                                              | OK         |
| `settings/usage`                | GET               | any member    | → `getUsageBreakdown` `getSessionUser()`; non-admins filtered to their own row                                                          | OK (F-311) |
| `team`                          | GET, PATCH        | ADMIN         | → `lib/team/actions.ts:73` / `:84` `adminGate()`; PATCH also self-demotion guard `:90` and last-admin `:94`                             | OK         |
| `team/deactivate`               | POST              | ADMIN         | → `lib/team/actions.ts:117` `adminGate()` + self guard `:123` + last-admin `:127`                                                       | OK         |
| `team/reactivate`               | POST              | ADMIN         | → `lib/team/actions.ts:162` `adminGate()`                                                                                               | OK         |
| `templates`                     | GET               | any member    | → `listTemplates` `requireUser()` `lib/templates/actions.ts:58`; `includeInactive` needs ADMIN `:63`                                    | OK         |
| `templates/[id]`                | GET               | any member    | → `getTemplate` `requireUser()` `:79` + `isVisibleToWorkspace` `:83`                                                                    | OK         |
| `templates/[id]/create`         | POST              | any member    | → `createFromTemplate` `requireUser()` `:94` + visibility `:101`                                                                        | OK         |
| `templates/from-project`        | GET, POST         | owner / ADMIN | → `previewSaveAsTemplate` `:126` + owner check `:145`; `saveProjectAsTemplate` `:154` + owner check `:180`                              | OK         |
| `analyze-edit-intent`           | POST              | any member    | `requireSessionUser()` route:8                                                                                                          | OK         |
| `conversation-state`            | GET, POST, DELETE | any member    | `requireSessionUser()` — but the resource is process-global                                                                             | **F-303**  |
| `extract-brand-styles`          | POST              | any member    | `requireSessionUser()` route:8 + `assertSafeUrl` route:20                                                                               | OK         |
| `scrape-screenshot`             | POST              | any member    | `requireSessionUser()` route:9 + `assertSafeUrl` route:21                                                                               | OK         |
| `scrape-url-enhanced`           | POST              | any member    | `requireSessionUser()` route:24 + `assertSafeUrl` route:38                                                                              | OK         |
| `scrape-website`                | POST              | any member    | `requireSessionUser()` route:8 + `assertSafeUrl` route:22                                                                               | OK         |
| `scrape-website`                | OPTIONS           | public        | returns `Access-Control-Allow-Origin: *`, no credentials                                                                                | F-322      |
| `search`                        | GET               | any member    | `getSessionUser()` route:11; `searchProjects` binds `q` and clamps `limit`                                                              | OK         |
| `search`                        | POST              | any member    | `requireSessionUser()` route:29; unmetered paid Firecrawl call                                                                          | F-319      |
| `health`                        | GET               | public        | liveness/version only, no per-user or secret data                                                                                       | OK         |
| `health/sentry-test`            | GET               | public        | 404 unless `NODE_ENV === 'development'` route:13                                                                                        | OK         |
| `legal/accept`                  | GET, POST         | self          | `getSessionUser()` route:10 / :18, writes keyed on `user.id`                                                                            | OK         |
| `legal/data-request`            | POST              | self          | `getSessionUser()` route:9, uses session identity only                                                                                  | OK         |
| `onboarding`                    | GET, POST         | self          | `getSessionUser()` route:11 / :20, writes keyed on `user.id`                                                                            | OK         |

**No IDOR found.** Every route that takes a `projectId`, `deploymentId`, `templateId`,
`assetId`, `checkpointId` or `userId` and _mutates_ resolves the row and compares
`ownerId`/role first, or is ADMIN-gated. The only exception is F-323.

### `app/preview-static/[projectId]/[[...path]]` — signed token, checked as requested

Not a session route. `handlePreviewRequest` (`lib/preview/serve.ts:131-146`) verifies the
token **before** loading the build.

- **Scope** — the payload is `{ projectId, userId, exp }` and `verifyPreviewToken`
  (`lib/preview/token.ts:76`) rejects `payload.projectId !== options.projectId`, so a token
  minted for project A cannot open project B. Signature is HMAC-SHA256 compared with
  `timingSafeEqual` after an explicit length check (`token.ts:66-70`) — no early-return
  string compare.
- **Expiry** — 2 h (`PREVIEW_TOKEN_TTL_MS`, `token.ts:3`), enforced at `token.ts:75`. There is
  no revocation list; a leaked link stays valid for its remaining TTL. That is the documented
  design, not a defect.
- **Path escape** — `safePreviewRequestPath` (`serve.ts:70-76`) strips the caller-supplied
  leading slash once, then checks the raw form **and up to three percent-decoding rounds**
  (`decodeRounds`, `serve.ts:78-92`) with a depth counter that rejects any prefix escape,
  absolute path, drive letter or NUL (`escapesPrefix`, `serve.ts:94-108`). I traced
  `%2e%2e%2f%2e%2e%2fsnapshots/...`: round 0 is clean, round 1 decodes to `../../snapshots/...`,
  depth goes negative, `escapesPrefix` returns true, the caller answers 404. **The traversal
  is closed.** One weakness is filed as F-318 (empty-string secret fallback).

### I.2 Public-route allowlist, and whether its guards hold

`lib/auth/public-routes.ts` `PUBLIC_API_ROUTES` — 24 entries / 31 path+method pairs. I read
each and checked its `ownMechanism` against the handler:

- Nothing sensitive is listed. The Auth.js catch-all is enumerated action by action, so
  `/api/auth/me` stays private (verified: `matchPublicRoute('/api/auth/me','GET')` returns
  null because no rule matches, and there is no `/api/auth/*` entry).
- `pathMatches` (`public-routes.ts:196-214`) is correct: `:param` consumes exactly one
  segment, a trailing `/*` requires **at least** one more segment (`pathParts.length <= fixed`
  → reject), and exact rules are consulted before pattern rules (`:224-234`).
- `validatePublicRoutes` (`:245-303`) rejects `/*`, `/api/*`, `/preview-static/*`, `**`,
  partial-segment stars, non-final stars, method wildcards, lowercase methods, empty
  `reason`/`ownMechanism`, and duplicates. `scripts/check-public-routes.ts` runs it and exits 1.
- **One `ownMechanism` overstates the code.** `/api/auth/login` and `/api/auth/forgot-password`
  both claim "per-email and per-IP rate limits". The implementation is a single bucket keyed
  on the _pair_ — see F-302.

`tests/unit/api-route-auth.test.ts` genuinely covers what it claims, and covers more than I
expected. It walks the real route tree with `collectRouteEndpoints()`, pushes **every**
endpoint through the **real** `proxy` with no cookies, asserts 401 for everything not
allowlisted, and pins the resulting public set against a hardcoded 27-entry list
(`:32-58`) so a new public endpoint fails the build. It also proves the walker is not
vacuous (`:83-88`), exercises all three export styles, mints real JWTs to prove the decode
path works and that expired / wrong-secret / garbage cookies are rejected (`:180-233`), pins
`/api/auth/me` private, checks the image-extension bypass, and — the part most such tests
omit — fails on a **dead** allowlist rule that no longer matches any route (`:290-305`).
This is solid. Its one blind spot is authorization, which is F-313.

---

## Findings

### F-300 [HIGH] Provider API keys are stored in the database in plaintext

- Area: I
- Location: `prisma/schema.prisma:414-424` (`ApiKey.secret`), `prisma/schema.prisma:426-433` (`OrgApiKey.secret`); written at `lib/api-keys/actions.ts:86,89` and `:119,120`; exposed through `app/api/settings/api-keys/route.ts:14-19` and `app/api/admin/api-keys/route.ts:11-17`
- What happens: `ApiKey.secret` and `OrgApiKey.secret` are declared as bare `String` and the
  upserts write `secret: parsed.data.secret` — the raw provider key — with no encryption. Only
  `last4` is derived. Every other credential in the same schema is encrypted:
  `Integration.secrets` (AES-256-GCM per AGENTS.md), `GitHubConnection.accessTokenEncrypted`,
  and `CoolifyServer.apiToken`, which goes through `encryptServerToken`/`decryptServerToken`
  (`lib/coolify/servers.ts:7-16`) using `lib/crypto`. The mechanism and the `ENCRYPTION_KEY`
  (already required at boot) are present and simply not applied here.
- Trigger: any member saves an OpenAI/Anthropic/Groq key in Settings → API keys, or an admin
  saves an org-wide key. The plaintext then lands in every `pg_dump` produced by
  `runDbBackup` (`POST /api/cron/backup-db`, daily 02:00) and in the backup bucket.
- Impact: a database dump, a backup-bucket exposure, a read-only replica, or SQL-injection
  anywhere yields live third-party billing credentials for every member plus the org key.
  Reads are correctly `select: { provider, last4 }` everywhere, so nothing leaks to a client —
  the exposure is entirely at rest, which is exactly what the encryption already in the
  codebase exists to prevent.
- Confidence: Confirmed
- Suggested fix: route both writes through the same `encrypt`/`decrypt` pair `CoolifyServer`
  uses, and decrypt at the single point where the key is handed to a provider client. Keep
  `last4` plaintext for display. Add a one-shot migration that re-encrypts existing rows,
  tolerating already-plaintext values the way `decryptServerToken` does.

### F-301 [HIGH] Database seed unconditionally creates a member account with a hardcoded password

- Area: I
- Location: `prisma/seed.ts:52-70` and `:110`; identical copy `prisma/seed.mjs:48-66` and `:118`; constant also at `lib/ensure-member.ts:4-5`
- What happens: `main()` calls `ensureAdmin()` then `ensureMember()`. `ensureAdmin` correctly
  refuses without `SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD` (`seed.ts:26-33`). `ensureMember`
  has no such guard: it always creates `member@navroop.local` with
  `DEMO_MEMBER_PASSWORD = 'ChangeMeNow123'`, a value committed to the repository in three
  places. Nothing marks the row as a fixture and nothing removes it later.
- Trigger: running `prisma db seed` (or `prisma migrate reset`, which chains it via the
  `package.json` `prisma.seed` hook) against any database that is not a throwaway.
- Impact: the account is a normal `MEMBER` with `isActive: true`, so the ordinary credentials
  provider accepts it — the dev-only gate `isDevQuickLoginEnabled()` guards only the `devRole`
  branch of `auth.ts:31`, not an email+password sign-in. Anyone who reads the public repo can
  sign in to an invite-only product. Because reads are workspace-wide, that member can then
  list every project, read every project's full source via `/api/projects/[id]/files`, and
  download it via `/api/projects/[id]/export`.
- Confidence: Confirmed (code path); the production start sequence documented in AGENTS.md does
  not run the seed, so exploitation depends on an operator seeding a real database
- Suggested fix: gate `ensureMember()` on a non-production environment the way `ensureAdmin`
  gates on env vars, or generate a random password and print it once. Remove the shared
  constant from `lib/ensure-member.ts` so the value is not a compile-time literal, and have
  the invite flow be the only path that creates members.

### F-302 [HIGH] Login and password-reset rate limits are bypassable, and the allowlist claims a control that does not exist

- Area: I
- Location: `lib/auth/login-rate-limit.ts:8-10` (`keyFor`), `app/api/auth/login/route.ts:12-16` (`clientIp`) and `:31-34`; same `clientIp` at `app/api/auth/forgot-password/route.ts:4-8`; claim at `lib/auth/public-routes.ts:118` and `:157`
- What happens: two independent defects compound.
  1. The bucket key is `` `${email}|${ip}` `` — a _pair_, not "per-email **and** per-IP". One
     IP gets a fresh five attempts for every email it tries, so password spraying across the
     member list is unlimited; and one email gets a fresh five attempts from every source IP,
     so a distributed brute force on a known account is unlimited.
  2. `clientIp` takes the first comma-separated value of the `X-Forwarded-For` request header
     with no trusted-proxy validation. The header is fully attacker-controlled, so even the
     pair-scoped limit is defeated by incrementing a counter in the header.
     Together, `POST /api/auth/login` is effectively unthrottled for an unauthenticated caller.
     `lib/auth/public-routes.ts:118` publishes this route to the internet on the strength of
     "Password verification plus per-email and per-IP rate limits", and `:157` does the same for
     forgot-password.
- Trigger: `POST /api/auth/login` with `X-Forwarded-For: <counter>` and any candidate password.
- Impact: unlimited offline-speed-limited online password guessing against every account,
  including the seeded admin. The forgot-password path additionally becomes an unmetered mail
  and account-enumeration-by-timing amplifier.
- Confidence: Confirmed
- Suggested fix: keep two buckets, one keyed on the normalised email alone and one on the
  client IP alone, and deny when either is exhausted. Derive the IP from a configured number
  of trusted proxy hops (take the _last_ untrusted entry, or the platform-provided connection
  address) rather than the first `X-Forwarded-For` value. Then correct the two `ownMechanism`
  strings so the allowlist describes what the code does.

### F-303 [HIGH] Conversation state is one process-global object shared by every signed-in user

- Area: I
- Location: `app/api/conversation-state/route.ts:6-8` (`declare global { var conversationState }`), read at `:20-27`, written at `:45-56` and `:100-119`, cleared at `:152`
- What happens: the route stores the whole conversation context — messages, edits, project
  evolution and user preferences — in a single module-level global with no user, workspace or
  project key. `requireSessionUser()` runs on all three verbs, so the caller must be signed in,
  but authentication is the _only_ check: every session reads and writes the same object.
- Trigger: user A does anything that populates the state; user B calls
  `GET /api/conversation-state` and receives A's messages and preferences. `POST {action:'reset'}`
  or `DELETE` from any member destroys whoever's context is currently loaded.
- Impact: cross-user disclosure of prompt/edit history, and a trivial denial of another
  member's in-flight context. It is also per-process, so behaviour is already
  non-deterministic across replicas or after a restart — which is likely why the correctness
  problem has gone unnoticed.
- Confidence: Confirmed
- Suggested fix: key the state by `projectId` (and validate the caller may read that project,
  the same way the other project routes do), and persist it rather than holding it in a module
  global. If the endpoint is genuinely dead, delete it — a globally shared mutable store behind
  an authenticated route is worse than no endpoint.

### F-304 [MEDIUM] The login rate-limit store grows without bound and is per-process

- Area: I
- Location: `lib/auth/login-rate-limit.ts:6` (`const buckets = new Map()`), `:12-27`
- What happens: entries are only ever replaced when the _same_ key is seen again after its
  window expires (`:16-19`) or deleted on a successful login for that exact key (`:30-32`).
  A key that is never revisited stays in the map for the lifetime of the process. There is no
  sweep, no max size, and no TTL eviction. The map is also plain process memory, so with more
  than one replica each instance enforces its own count.
- Trigger: an unauthenticated attacker posting to `/api/auth/login` with varying email or
  `X-Forwarded-For` values (see F-302) — every distinct pair allocates a permanent entry.
- Impact: unbounded memory growth reachable without a session, ending in an OOM restart; and
  the nominal limit of 5 becomes 5 × replica count.
- Confidence: Confirmed
- Suggested fix: sweep expired buckets on write (or use a bounded LRU), and move the counter
  to shared storage — Postgres or the same `AppSetting` counter pattern `reject-log.ts` already
  uses — so the limit is per workspace rather than per process.

### F-305 [MEDIUM] The credit period roll is not atomic, so a concurrent debit can be erased

- Area: J
- Location: `lib/plans/limits.ts:81-101`, specifically the `UPDATE` at `:87-99` and its
  `WHERE id = ${workspace.id}` at `:98`
- What happens: `rollCreditPeriodIfNeeded` reads the workspace, decides in application code
  whether the window has elapsed, then issues an unconditional `UPDATE … SET "creditsUsed" = 0`
  keyed only on the row id. The statement carries no guard that `creditsPeriodStart` is still
  the value the decision was based on, so it is a read-modify-write with the check outside the
  write. Every credit path calls it first: `checkCredits:110` and `consumeCredits:189`.
- Trigger: two requests cross the month boundary concurrently. Both read the old
  `creditsPeriodStart` and both decide to roll. Request A's roll commits and its
  `consumeCredits` debits `creditsUsed = 1`. Request B's roll — already past its own check —
  then executes and sets `creditsUsed = 0` again, discarding A's charge.
- Impact: credits granted for free at each period boundary, and a permanent divergence between
  the `Workspace.creditsUsed` counter and the `CreditLedger` rows (the ledger row from A
  survives). `getUsageBreakdown` already surfaces that divergence as `unattributed`
  (`lib/plans/actions.ts:~427`) and clamps it at 0, so the drift is silently absorbed rather
  than reported. This is the one write in the credit system that is not conditional — the debit
  itself (`limits.ts:191-200`) and both alert claims are correctly written as guarded UPDATEs.
- Confidence: Confirmed
- Suggested fix: add `AND "creditsPeriodStart" = ${workspace.creditsPeriodStart}` to the
  `UPDATE`, and treat a zero row count as "someone else rolled" — re-read and continue rather
  than retry. That makes the roll idempotent under concurrency with no extra round trip.

### F-306 [MEDIUM] The 80% credit alert never sends an email

- Area: J
- Location: `lib/plans/alerts.ts:35-65`, specifically `:54-62`
- What happens: `notifyAdminsCredit80` writes the `credit-alert-80:` receipt row, calls
  `adminRecipients()`, then `console.info`s and returns `true`. It never calls `mailAdmins`.
  Its two siblings in the same file do: `notifyAdminsSpend80` calls
  `mailAdmins(admins, spendAlert80Email(input))` at `:83` and `notifyAdminsSpendLimit` at `:97`.
  The `admins` array is fetched and used only for its `.length` and ids in a log line.
- Trigger: workspace credit usage reaches 80% of `plan.monthlyCredits`.
- Impact: no admin is notified that the workspace is about to run out of credits; the first
  visible signal is generation being denied with "This month's credits are used up". The
  `true` return also tells `consumeCredits` the alert was delivered, so it keeps the
  `creditAlert80Sent` claim (`limits.ts:249-252`) and no later debit retries — the elaborate
  claim/hand-back machinery at `limits.ts:236-283` is protecting a notification that never
  leaves the process.
- Confidence: Confirmed
- Suggested fix: call `mailAdmins` with a credit-alert template and return `false` when the
  send fails, matching `notifyAdminsSpend80`. The caller already handles a `false` correctly by
  releasing the claim.

### F-307 [MEDIUM] Plan limits other than credits are check-then-act and can be exceeded concurrently

- Area: J
- Location: `lib/plans/limits.ts:346-360` (`checkLimit`), counts at `:305-327`
  (`currentForLimit`); callers `lib/projects/actions.ts:106`, `lib/projects/actions.ts:~389`,
  `app/api/admin/invite/route.ts:37`, `lib/team/actions.ts:175`
- What happens: `checkLimit` issues a plain `count()` and compares it to the plan ceiling in
  application code. Nothing locks, and the caller's subsequent `create` is a separate
  statement. Credits deliberately avoid this — `consumeCredits` enforces the ceiling inside
  the `UPDATE` itself (`:191-200`) and comments on why — but `projects`, `members`,
  `liveSites`, `previewSites` and `storage` did not get the same treatment.
- Trigger: two concurrent `POST /api/projects` at the project ceiling, or two concurrent
  `POST /api/admin/invite` at the member ceiling. Both counts return `limit - 1`, both pass,
  both insert.
- Impact: plan ceilings are advisory under concurrency. For `members` and `projects` that is
  quota leakage; for `liveSites`/`previewSites` it can over-commit a Coolify server past
  `maxDeployments`.
- Confidence: Confirmed
- Suggested fix: enforce each limit at the write. For counted resources, take the same
  transaction-scoped advisory lock `incrementPrivateReject` uses
  (`lib/security/reject-log.ts:78`) keyed on the limit name, re-count inside the transaction,
  and insert — or add a partial unique/exclusion constraint where the shape allows.

### F-308 [MEDIUM] DNS rebinding window between the SSRF check and the fetch

- Area: I
- Location: `lib/security/url-guard.ts:126-141` (resolve-and-check) and
  `lib/security/safe-fetch.ts:74-84` (the fetch that resolves again)
- What happens: `assertSafeUrl` resolves the hostname with `dns.lookup(…, {all:true})` and
  rejects if any returned address is in a blocked range. It then returns the parsed `URL`, and
  `safeFetch` calls `fetchImpl(current.href, …)` — which performs its **own, second** DNS
  resolution. Nothing pins the address that was validated. The same gap reopens on every
  redirect hop: `:88` re-runs `assertSafeUrl` on the `Location`, then loops back to `:75` and
  resolves again.
- Trigger: an attacker-controlled hostname on a very low TTL that answers with a public
  address for the guard's lookup and `169.254.169.254` (or an RFC1918 address) for the fetch's
  lookup. Reachable from any signed-in member through `POST /api/projects/[id]/import`, which
  is the documented `safeFetch` consumer.
- Impact: server-side request forgery to cloud metadata and internal services, with the
  response body returned to the caller — precisely the class of request the private-range list
  and the `ssrf.privateRejects` counter exist to stop. The four scrape routes in scope are not
  affected because Firecrawl performs the fetch from its own infrastructure; the exposure is
  the `safeFetch` path.
- Confidence: Confirmed (the pattern is unambiguous in the code); exploitation needs attacker
  DNS control, so Likely rather than trivial in practice
- Suggested fix: resolve once and connect to the validated address — pass a custom `lookup`
  (or a pinned-IP agent) into the fetch so the connection uses the address the guard approved,
  with the original hostname preserved for SNI and `Host`. Re-validate per redirect hop the
  same way.

### F-309 [MEDIUM] Four database-only invariants are invisible to `prisma/schema.prisma`

- Area: J
- Location: `prisma/migrations/20260817220000_generation_jobs/migration.sql:42-48`;
  `prisma/migrations/20260817270000_audit_invariants/migration.sql:26-59` and `:67-68`;
  compare `prisma/schema.prisma:672-712` (`Job`, whose `@@index` list names only two indexes)
  and `prisma/schema.prisma:88-120` (`User`)
- What happens: four objects that carry real correctness and security guarantees exist only in
  migration SQL and have no representation in the Prisma schema:
  1. `one_active_job_per_project` — partial unique index on `("projectId") WHERE status IN ('QUEUED','RUNNING')`
  2. `generation_job_project_idempotency_key` — partial unique index on `("projectId","idempotencyKey") WHERE "idempotencyKey" IS NOT NULL`
  3. `Deployment_dns_label_key` — expression unique index preventing a LIVE slug colliding with a PREVIEW DNS label
  4. `prevent_last_admin_removal()` + trigger `user_prevent_last_admin` — the last-admin lockout guard
     Prisma models none of these forms (partial indexes, expression indexes, triggers, functions).
     A related instance: `Project.searchVector` is declared `@default(dbgenerated(...))`
     (`schema.prisma:~230`) while the migration created it as `GENERATED ALWAYS AS (…) STORED`
     (`20260817230000_export_search_legal_onboarding/migration.sql:8-14`) — a default and a
     generated column are different things.
- Trigger: any schema-first rebuild — `prisma db push`, `prisma migrate reset` against a
  datamodel, or regenerating a baseline migration from `schema.prisma`.
- Impact: the rebuilt database silently loses last-admin protection (a workspace can be locked
  out of its own admin surface), the one-active-job invariant the whole job state machine
  assumes, job idempotency, and DNS-label collision safety. Reading `schema.prisma` — the file
  every developer treats as the model — gives no hint that any of them exist, and
  `Job.idempotencyKey` in particular reads as an unenforced column.
- Confidence: Confirmed
- Suggested fix: document the four objects in a comment block on the models they constrain so
  the schema is self-describing, and add a startup or verify-time assertion that queries
  `pg_indexes`/`pg_trigger` for them by name and fails loudly when one is missing. That turns a
  silent loss into a boot error.

### F-310 [MEDIUM] A user can never be hard-deleted, and the last-admin trigger does not cover DELETE

- Area: J
- Location: `prisma/schema.prisma:158` (`Project.owner … onDelete: Cascade`),
  `:597` (`Deployment.project … onDelete: Restrict`), `:614` (`Deployment.publishedBy … onDelete: Restrict`),
  `:461` (`Skill.createdBy … onDelete: Restrict`);
  trigger scope at `prisma/migrations/20260817270000_audit_invariants/migration.sql:56-59`
- What happens: two contradictions in the cascade graph.
  1. `Project.owner` cascades from `User`, but `Deployment.project` is `Restrict` and
     `Deployment.publishedBy` is `Restrict` directly on `User`. So deleting any user who has
     ever published — or who owns a project that has a `Deployment` — raises a foreign-key
     violation instead of deleting. `Skill.createdBy` `Restrict` blocks the same operation for
     anyone who created a skill. There is no code path that handles this: the comment at
     `lib/plans/actions.ts:~424` states as fact that "deleting a user cascades their ledger
     rows", which is a behaviour the constraints prevent from ever being reached.
  2. `user_prevent_last_admin` is declared `BEFORE UPDATE ON "User"` only. The demotion and
     deactivation paths are protected; a `DELETE` of the sole active admin is not.
- Trigger: a GDPR deletion request arriving through `POST /api/legal/data-request` (which
  emails an admin to act manually) and the admin attempting the delete; or any future
  automated erasure.
- Impact: erasure requests cannot be fulfilled without hand-unpicking `Deployment` and `Skill`
  rows, and the failure surfaces as a raw P2003 rather than an explainable refusal. The
  DELETE gap means the invariant the trigger exists to hold has a hole.
- Confidence: Confirmed
- Suggested fix: decide the policy explicitly. If publish history must survive the user, make
  `Deployment.publishedBy` and `Skill.createdBy` nullable with `SetNull` (as
  `Template.createdBy` and `Integration.connectedBy` already are) and keep the actor identity
  in `AuditLog`, which deliberately has no FK. Then extend the trigger to
  `BEFORE UPDATE OR DELETE`, and correct the comment in `lib/plans/actions.ts`.

### F-311 [MEDIUM] `getUsageBreakdown` loads every credit-ledger row of the period with a joined user

- Area: J
- Location: `lib/plans/actions.ts:~370-380` (`prisma.creditLedger.findMany`), reached by
  `app/api/settings/usage/route.ts:5-9`
- What happens: the query selects all `CreditLedger` rows since `creditsPeriodStart` with
  `include: { user: … }` and **no `take`**, then aggregates in JavaScript into `byAction` and
  `byMember` (`:383-405`). A second `aggregate` for the same window follows at `:407-410`, so
  the period is scanned twice. Postgres can produce both results with two `GROUP BY` queries
  that return a handful of rows.
- Trigger: `GET /api/settings/usage` — reachable by any member — on a workspace with a busy
  month. One row exists per credit-consuming action, so an active workspace accumulates
  thousands per period.
- Impact: response time and server memory grow linearly with monthly activity on a route any
  member can call repeatedly; the joined `user` object is duplicated on every row.
- Confidence: Confirmed
- Suggested fix: replace the row load with two grouped aggregates (`groupBy` on `action`, and
  on `userId` with a join for names), and drop the separate total — the grouped sums already
  provide it. The existing `CreditLedger(workspaceId, createdAt)` index serves both.

### F-312 [MEDIUM] `updatePlan` splits one edit across two uncoordinated writes and can leave the default plan inactive

- Area: J
- Location: `lib/plans/actions.ts:127-140` (the `isDefault` transaction) and `:142-172`
  (the second, separate `update`); consumed by `lib/plans/limits.ts:66-73` (`getEffectivePlan`)
- What happens: when `isDefault === true` the function runs a `$transaction` that clears
  `isDefault` on all plans and sets it — together with `isActive: true` — on this one. It then
  runs a **second, independent** `prisma.plan.update` with the rest of the payload. Two
  consequences:
  1. The pair is not atomic. If the second update fails, the default has already moved while
     none of the operator's other edits landed, and there is no compensation.
  2. The second update happily applies `isActive: input.isActive`, overwriting the `true` the
     transaction just set. `getEffectivePlan` selects the fallback with
     `where: { isDefault: true }` and no `isActive` filter, so an inactive plan silently
     becomes the plan every limit and credit check is evaluated against.
- Trigger: `PATCH /api/admin/plans` with `{ id, isDefault: true, isActive: false }`, or any
  transient failure between the two writes.
- Impact: the workspace's effective plan can be one the admin believes is switched off, and a
  partially applied plan edit is possible with no error surfaced.
- Confidence: Confirmed
- Suggested fix: perform the whole update — including the `isDefault` demotion of siblings — in
  one `$transaction`, and refuse `isActive: false` on a plan that is (or is becoming) the
  default. Alternatively filter `getEffectivePlan`'s fallback on `isActive: true`, but the
  refusal is the clearer contract.

### F-313 [MEDIUM] The authorization matrix covers 10 of roughly 90 mutating endpoints

- Area: I
- Location: `lib/auth/route-policy.ts:23-96` (`MUTATING_ROUTE_POLICIES`, 10 entries) and
  `:99-105` (`gatePattern`); consumed by `tests/unit/auth-matrix.test.ts:6,480,488,595-601`
- What happens: `auth-matrix.test.ts` really does drive handlers — 10 routes × 5 actors — and
  cross-checks a hand-written table against the policy list (`:480`, `:488`). That part is
  good. The limitation is coverage and mechanism:
  1. Ten routes are listed. The mutating surface in scope alone is far larger, and the routes
     that are _absent_ are exactly the delegating ones the mechanical scan flagged:
     `/api/admin/servers/*`, `/api/admin/deploy`, `/api/admin/api-keys`, `/api/team/*`,
     `/api/settings/*`, `/api/deployments/[id]`, `/api/templates/*`.
  2. The gate assertion at `:595-601` is a **source-text regex** (`gatePattern` returns
     `/requireAdmin\s*\(/`). It proves the identifier appears in the file. It cannot prove the
     gate runs before the mutation, that its result is honoured, or that the mutation is not
     reachable on another branch.
- Trigger: a refactor that removes `requireAdmin()` from, say, `lib/coolify/server-actions.ts`.
  No test in the suite fails; the proxy still returns non-401 for any signed-in member, so a
  MEMBER would reach the Coolify server-management actions.
- Impact: the delegated-gate pattern that the whole codebase depends on — and that this audit
  had to verify by hand — is almost entirely unguarded by tests. The proxy suite proves
  authentication; nothing proves authorization for ~80 mutating endpoints.
- Confidence: Confirmed
- Suggested fix: generate the policy list from the route inventory (`collectRouteEndpoints`)
  so a new mutating endpoint fails the build until it is classified, and assert behaviour by
  invoking the handler as a MEMBER and expecting 403 — the shape `auth-matrix.test.ts` already
  uses for its 10 — rather than by matching source text.

### F-314 [MEDIUM] Hot list queries have no supporting composite index and no row cap

- Area: J
- Location: `prisma/schema.prisma:236-240` (`Project` `@@index` list) and `:311-314`
  (`Checkpoint` `@@index` list); callers `lib/projects/actions.ts:216-262`
  (`findMany`, no `take`) and `app/api/projects/[id]/export/route.ts:47-62`
- What happens: two documented-hot paths have no matching index.
  1. `listProjects` filters `deletedAt: null` and orders by `updatedAt desc`. `Project` indexes
     `[ownerId]`, `[deletedAt]`, `[lockedById, lockExpiresAt]` and the GIN vector — there is no
     `[deletedAt, updatedAt]`, so Postgres filters then sorts the whole matching set. The query
     also has **no `take`/`skip`**, so the dashboard loads every non-deleted project in the
     workspace on every visit.
  2. The export route queries `checkpoints where snapshotPruned = false orderBy createdAt desc`.
     `Checkpoint` indexes `[projectId]`, `[createdAt]` and
     `[isBookmarked, snapshotPruned, createdAt]` — none of which leads with `projectId` plus
     `createdAt`, so the per-project history is filtered and sorted rather than read in order.
- Trigger: normal use as the project and checkpoint counts grow.
- Impact: dashboard latency grows linearly with total workspace projects and never plateaus,
  and the payload does too. Export slows as checkpoint history accumulates.
- Confidence: Confirmed
- Suggested fix: add `@@index([deletedAt, updatedAt])` on `Project` and
  `@@index([projectId, createdAt])` on `Checkpoint`, and give `listProjects` a `take` with
  cursor pagination. The list endpoint already returns a bounded UI; the query should match it.

### F-315 [LOW] Storage counters are 32-bit while the plan limit they are compared against is 64-bit

- Area: J
- Location: `prisma/schema.prisma:322-323` (`Workspace.storageBytes Int`, `storageLimitBytes Int?`)
  versus `:352` (`Plan.storageBytesLimit BigInt`); narrowing at `lib/plans/limits.ts:339`
  (`Number(plan.storageBytesLimit)`); same 32-bit ceiling at `:262` (`PreviewBuild.totalBytes Int`)
  and `Checkpoint.snapshotBytes Int`
- What happens: a Postgres `INTEGER` caps at 2 147 483 647 — about 2.0 GiB. The seeded Pro plan
  already sets `storageBytesLimit` to 20 GiB (`prisma/seed.ts:97`), an order of magnitude above
  what the counter column can hold. `checkLimit('storage')` compares the two after narrowing the
  `BigInt` through `Number`.
- Trigger: a workspace on Pro (or any plan above 2 GiB) accumulating snapshots and previews.
- Impact: the accumulating `storageBytes` update overflows and errors, or wraps, long before the
  plan limit is reached — so the storage limit can never be enforced on the plans that need it.
- Confidence: Confirmed
- Suggested fix: widen `Workspace.storageBytes` and `storageLimitBytes` to `BigInt` and keep the
  comparison in `BigInt` instead of narrowing through `Number`. Review `PreviewBuild.totalBytes`
  and `Checkpoint.snapshotBytes` for the same ceiling.

### F-316 [LOW] `createPlan` writes no audit entry although its siblings do

- Area: J
- Location: `lib/plans/actions.ts:63-105`; compare `updatePlan` `:173-190` and
  `assignDefaultWorkspacePlan` `:197-210`, both of which call `writeAudit`
- What happens: creating a plan — which defines credit ceilings, project/site/member limits and
  per-job token caps — leaves no `AuditLog` row. Editing one and assigning one both do.
- Trigger: `POST /api/admin/plans`.
- Impact: `/admin/audit` shows a plan being edited and assigned but never created, so the trail
  for how a limit set came into existence is incomplete.
- Confidence: Confirmed
- Suggested fix: add a `plan.create` `writeAudit` call mirroring `plan.limits_edit`, recording
  the created key and the limit fields.

### F-317 [LOW] `safeFetch` treats a missing Content-Type as an accepted type

- Area: I
- Location: `lib/security/safe-fetch.ts:25-32` (`isAcceptedContentType`), applied at `:96`
- What happens: the function returns `true` when the header is absent (`:26`) and again when the
  mime parses to an empty string (`:28`). Only a _present_ and _unrecognised_ type is rejected.
- Trigger: an origin that omits `Content-Type` on a binary response.
- Impact: the content-type allowlist — which exists to keep arbitrary binaries out of the import
  pipeline — is bypassed by omitting the header, and up to 10 MB of unknown bytes is buffered
  and handed to the caller.
- Confidence: Confirmed
- Suggested fix: treat a missing or unparseable Content-Type as not accepted, or sniff the first
  bytes. Silence should not be a pass on an allowlist.

### F-318 [LOW] The static-preview route falls back to an empty HMAC key

- Area: I
- Location: `app/preview-static/[projectId]/[[...path]]/route.ts:27-32`; verification at
  `lib/preview/serve.ts:131-136` → `lib/preview/token.ts:57-74`
- What happens: the route passes
  `secret: process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET || process.env.ENCRYPTION_KEY || ''`
  into `handlePreviewRequest`. With all three unset the token is verified against an HMAC keyed
  on the empty string, which is a value an attacker also knows. `previewSecret()`
  (`token.ts:29-37`) throws in the same situation, but it is only reached later inside
  `loadBuild`, after the signature has already been accepted.
- Trigger: a deployment booted with none of the three secrets set.
- Impact: forged preview tokens pass the signature check. The request still fails afterwards
  when `checkPreviewToken` throws inside `loadBuild`, so this is a latent weakness rather than a
  live data leak — but the ordering is the only thing preventing it.
- Confidence: Confirmed
- Suggested fix: drop the `|| ''` and let the route fail closed, reusing `previewSecret()` so
  there is one definition of "which secret signs preview tokens" and a missing secret is an
  error rather than a key.

### F-319 [LOW] `POST /api/search` lets any member spend Firecrawl credits without a limit

- Area: I
- Location: `app/api/search/route.ts:28-72`, request at `:41-56`
- What happens: the handler checks the session and then issues a Firecrawl search for 10 results
  with `markdown` and `screenshot` scraping per result. There is no rate limit, no per-user
  quota, no credit consumption (`CREDIT_COSTS` has no entry for search) and no result cap beyond
  the hardcoded 10.
- Trigger: a signed-in member looping the endpoint.
- Impact: unbounded third-party spend attributable to no one, on the account whose key is
  `FIRECRAWL_API_KEY`. It is also invisible to `/admin/usage`, which reports credits and tokens.
- Confidence: Confirmed
- Suggested fix: apply the same per-user hourly limiter the export route uses
  (`allowExport`), and either charge a credit action or record a `GenerationEvent` so the spend
  appears on the usage dashboard.

### F-320 [LOW] `checkLimit` ignores its `workspaceId` argument for two limit kinds

- Area: J
- Location: `lib/plans/limits.ts:305-327` — `case 'projects'` at `:307-308` and
  `case 'members'` at `:317-318`
- What happens: both branches count globally —
  `prisma.project.count({ where: { deletedAt: null } })` and
  `prisma.user.count({ where: { isActive: true } })` — while the sibling branches for
  `liveSites`, `previewSites` and `storage` all scope by `workspaceId`. The parameter is
  accepted and silently unused.
- Trigger: none today; the product is single-workspace so the counts coincide.
- Impact: a latent multi-tenancy bug. The moment a second workspace exists, every workspace is
  measured against the global project and member counts, and the first workspace to fill the
  plan blocks all the others. The signature actively conceals this by taking the id.
- Confidence: Confirmed
- Suggested fix: either scope both counts by workspace now — `Project` would need a
  `workspaceId`, which it currently lacks — or drop the parameter from those branches and state
  in a comment that the counts are global by design, so the next reader is not misled.

### F-321 [LOW] The public login route performs an admin-seeding database write on every request

- Area: I
- Location: `app/api/auth/login/route.ts:21` (`await ensureAdminUser()`), implementation
  `lib/ensure-admin.ts:4-38`; same call at `app/api/auth/me/route.ts:7`
- What happens: `ensureAdminUser()` runs before any rate-limit check or input validation. It
  issues a `user.findFirst({ where: { role: 'ADMIN' } })` on every call, and — when no admin
  exists — a bcrypt hash and a `user.create`.
- Trigger: any unauthenticated `POST /api/auth/login`, including the flood described in F-302.
- Impact: an unauthenticated caller drives a database query per request, ahead of the throttle
  that is supposed to bound them. On a fresh deployment it also drives a bcrypt cost-12 hash.
  Minor on its own; it compounds F-302.
- Confidence: Confirmed
- Suggested fix: move seeding to boot (it already has a natural home alongside `ensureDataDir`)
  or memoise the "an admin exists" answer per process. It does not belong on the hot path of a
  public endpoint.

### F-322 [LOW] The public CORS preflight advertises a wildcard origin

- Area: I
- Location: `app/api/scrape-website/route.ts:113-122`; allowlisted at
  `lib/auth/public-routes.ts:206-211`
- What happens: `OPTIONS` returns `Access-Control-Allow-Origin: *` with
  `Allow-Methods: POST, OPTIONS`. The allowlist entry's `ownMechanism` — "Returns CORS headers
  only; the POST itself requires a session" — is accurate, and because
  `Access-Control-Allow-Credentials` is absent, a browser will not attach the session cookie to
  the cross-origin POST, so it 401s.
- Trigger: any origin issuing the preflight.
- Impact: no data exposure today. The risk is that the wildcard is a standing invitation for
  someone to later "fix" the POST by echoing the same headers, at which point the cookie
  question becomes live. The `POST` handler returns no CORS headers at all, so the preflight
  describes a request that can never succeed.
- Confidence: Confirmed
- Suggested fix: either delete the `OPTIONS` handler and the allowlist entry — nothing in the
  product needs a cross-origin scrape — or reflect a configured origin instead of `*`.

### F-323 [LOW] `POST /api/projects/[id]/quality-signals` accepts a write with the read gate

- Area: I
- Location: `app/api/projects/[id]/quality-signals/route.ts:11-14` (session check) and
  `:17-24` (project loaded with `select: { id: true }` and no owner comparison), write at `:32`
- What happens: the route authenticates, confirms the project exists and is not deleted, then
  calls `recordThumbs(id, rating)`. It never loads `ownerId` and never calls `canMutate`. Every
  sibling mutation on the same resource does: `updateProject`, `deleteProject`,
  `restoreProject`, `duplicateProject` and `persistProjectGeneration` all compare `ownerId`
  (`lib/projects/actions.ts:311, 333, 357, ~382, ~468`), and `persistProjectGeneration` carries
  a comment describing the incident where that check was missing. This is the read gate used by
  `files` and `preview` applied to a write.
- Trigger: any signed-in member posting `{ kind: 'thumbs', rating: 'down' }` to another
  member's project id.
- Impact: quality signals are the input to `/admin/quality` and to prompt-version
  attribution, so a member can distort another project's quality record. There is no
  per-user uniqueness on `QualitySignal` either, so the same caller can repeat it without bound.
- Confidence: Confirmed
- Suggested fix: load `ownerId` and apply the same `canMutate` check the sibling project
  mutations use. If thumbs are intended to be a workspace-wide signal, record the rater's
  `userId` on the row and enforce one signal per user per generation so the data means
  something.

---

## Gaps

### F-350 [GAP] No CSRF token on cookie-authenticated state-changing API routes

- Area: I
- Location: `auth.ts:15-19` (session config, no `cookies` override), and every mutating route in
  the matrix above
- The product authenticates with an Auth.js JWT session cookie and none of the non-Auth.js
  routes carry a CSRF token or an origin check. Today this is covered by Auth.js's default
  `sameSite: 'lax'`, which keeps the cookie off cross-site POSTs, and by the fact that all
  mutations are JSON `POST`/`PATCH`/`DELETE`. That is one implicit default away from being a
  real hole: a future `sameSite: 'none'` (needed if previews are ever embedded cross-origin) or
  a route that accepts a form encoding would silently open every mutation. Worth an explicit
  origin/`Sec-Fetch-Site` check in `proxy.ts` for state-changing methods, so the protection is
  stated rather than inherited.

### F-351 [GAP] The `Invite` model cannot express a pending invitation

- Area: J
- Location: `prisma/schema.prisma:400-411`; acknowledged in `lib/auth/public-routes.ts:130-137`
  and `lib/team/actions.ts:70`
- `Invite` has no token, no expiry and no status beyond `acceptedAt`. `POST /api/admin/invite`
  creates the `User` outright and writes the invite already accepted
  (`app/api/admin/invite/route.ts:52-59`), handing the admin a temporary password to relay
  out-of-band. So the model records history and cannot gate anything, the temporary password
  travels over whatever channel the admin picks, and the new user is never forced to change it.
  A single-use hashed invite token — the mechanism `PasswordResetToken` already implements
  correctly — would replace the out-of-band password entirely.

### F-352 [GAP] No integrity check that the four database-only invariants are present at runtime

- Area: J
- Companion to F-309. Nothing verifies at boot or in `pnpm run verify` that
  `one_active_job_per_project`, `generation_job_project_idempotency_key`,
  `Deployment_dns_label_key` and the `user_prevent_last_admin` trigger actually exist in the
  connected database. Their absence is silent and would only show up as a duplicate row, a
  double charge, or an admin lockout much later.

---

## Improvements

### F-360 [IMPROVEMENT] `AppSetting` is four different stores wearing one table

- `prisma/schema.prisma:483-487` is `key`/`value`/`updatedAt`, and it holds: namespaced
  configuration (`setting:*`, encrypted secrets), a JSON counter blob read-modify-written under
  an advisory lock (`ssrf.privateRejects`, `lib/security/reject-log.ts:78-98`), alert receipts
  (`credit-alert-80:*`, `spend-alert-80:*`), and deploy history (`deploy.history`). Each has a
  different lifetime, retention and concurrency story. Counters in particular want a numeric
  column and an atomic increment rather than JSON plus a lock.

### F-361 [IMPROVEMENT] Auth.js adapter tables are dead under the JWT strategy

- `Account`, `Session` and `VerificationToken` (`prisma/schema.prisma:122-155`) exist because
  `PrismaAdapter` is wired in (`auth.ts:13`), but `session.strategy` is `'jwt'` and the only
  provider is `Credentials`, so no OAuth account and no session row is ever written.
  `passwordChangeWrites` deletes from `Session` as documented belt-and-braces
  (`lib/auth/session-invalidation.ts:36`). Keeping them is defensible; a schema comment saying
  why would stop the next reader assuming sessions are server-side and revocable.

### F-362 [IMPROVEMENT] Three history tables have no retention policy

- `thin-checkpoints` prunes presence, audit logs, preview builds and observability history
  (`lib/checkpoints/thin.ts:5-8, 103-117`) — that is genuinely well covered, and `CronRun` and
  `ObservabilityCheck` are included. `GenerationEvent`, `QualitySignal` and `CreditLedger` are
  not. `GenerationEvent` gains a row per generation and is scanned by
  `getUsageByMember`/`getUsageSummary` over arbitrary ranges. If the retention is deliberate
  (billing history), say so on the model; otherwise add them to the same prune.

### F-363 [IMPROVEMENT] `CreditLedger.projectId` is a pointer with no foreign key and no index

- `prisma/schema.prisma:381` declares `projectId String?` with no relation. Deleting a project
  leaves the value dangling, and there is no index on it, so any per-project attribution is a
  scan. If it is deliberately unconstrained so billing survives project deletion, a comment
  saying so — as `AuditLog.actorId` implicitly enjoys — plus an index would make it usable.

---

## Invariants checked against the code

| Invariant (AGENTS.md / `.cursor/lessons-learned.md`)                         | Result                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Proxy denies `/api` + `/preview-static` unless allowlisted                   | **Holds** — `proxy.ts:87-91`, pinned by `tests/unit/api-route-auth.test.ts`                                                                                                                                          |
| The gate is coarse; routes still check membership/ownership/ADMIN/`isActive` | **Holds** — `getSessionUser` re-reads `isActive` (`lib/auth.ts:26-28`); `auth.ts:104-119` strips a revoked or pre-password-change token                                                                              |
| Denials are JSON 401, never a redirect                                       | **Holds** — `proxy.ts:74-83`                                                                                                                                                                                         |
| No composed `Prisma.sql` inside a tagged template                            | **Holds** — `lib/projects/list-sql.ts` numbers its own placeholders for `$queryRawUnsafe`; `lib/search/projects.ts`, `lib/plans/limits.ts:87`, `lib/plans/spend.ts` and `lib/plans/actions.ts` all bind scalars only |
| Credits consume atomically                                                   | **Partly** — the debit is a guarded `UPDATE` and the member cap is enforced inside the transaction (`limits.ts:191-224`); the period roll that precedes it is not (**F-305**)                                        |
| Credits charged once, at RUNNING                                             | Out of scope (`lib/jobs/lifecycle.ts`), not contradicted by anything read here                                                                                                                                       |
| Secrets never returned to a client, `last4` only                             | **Holds at the API boundary** — every `ApiKey`/`OrgApiKey` read selects `provider, last4`; **fails at rest** (**F-300**)                                                                                             |
| Cron routes require `Bearer CRON_SECRET`                                     | **Holds** — `lib/cron/auth.ts:4-12`, timing-safe and fail-closed                                                                                                                                                     |
| Password change invalidates other sessions                                   | **Holds** — both paths share `passwordChangeWrites`; the whole-second truncation is deliberate and explained                                                                                                         |
| SSRF: http(s) only, ports 80/443, private ranges, ≤3 redirects, 10 MB        | **Holds as written**, with a rebinding window (**F-308**) and a content-type gap (**F-317**)                                                                                                                         |
| Private-range rejects increment `AppSetting` and reach `/admin/usage`        | **Holds** — awaited, non-throwing, advisory-locked (`reject-log.ts:38-46, 78-98`)                                                                                                                                    |
| Migration safety: destructive migrations marked and gated                    | **Holds** — the two destructive migrations both carry `-- navroop:reviewed-destructive` and name `ALLOW_DESTRUCTIVE_MIGRATION`                                                                                       |

### Migration history (44 migrations in scope)

All 44 read. Two are destructive and both are correctly marked:
`20260819000000_stacks_three_only` (rebuilds the `Stack` enum — I verified the original enum at
`20260816113000_project_stack/migration.sql:2` did contain `ASTRO`/`VUE`/`SVELTE`, so the remap
`UPDATE`s at `:9-12` are valid and no row is lost) and `20260819010000_drop_sandbox_columns`
(drops the sandbox subsystem; every statement is `IF EXISTS`, and the `PreviewMode` enum rebuild
back-fills rows before the type swap). Enum additions use `ADD VALUE IF NOT EXISTS`; every
re-runnable file uses `IF NOT EXISTS` / `DO $$ … duplicate_object` guards. The FK action changed
by `20260817270000` (`Deployment.projectId` CASCADE → RESTRICT) matches
`prisma/schema.prisma:597`. **No unmarked destructive migration, and no schema/migration column
drift found.** The drift that does exist is structural, not column-level: F-309.

---

## Handed to other phases (defect confirmed, primary file outside my scope)

Reported to `Main` rather than filed here, since the owning file belongs to another phase:
`lib/team/actions.ts:161-184` `reactivateMember` writes no `writeAudit` while its
deactivate/role-change siblings do; `lib/api-keys/actions.ts:106-124` `setOrgApiKey` writes no
audit entry while the personal-key add/rotate/delete paths do;
`lib/coolify/server-actions.ts:76-86` `forceDeactivateServer` bypasses the live-deployment
guard and writes no audit entry; `lib/templates/actions.ts:288-311` `adminUpdateTemplate` writes
no audit entry while create/delete do; `lib/preview/serve.ts:171` computes `cacheImmutable` as
`build.storagePrefix.includes(build.storagePrefix.split('/').pop() || '')`, which is always true,
so every preview object including HTML is served immutable; `lib/search/projects.ts:32-50`
swallows a full-text failure into a silent ILIKE fallback, permanently masking a broken GIN
index; `lib/projects/actions.ts:246-259` swallows the Prisma error before falling back to raw
SQL, and `:294` swallows the deployment lookup.

---

## Files reviewed (172)

### Routes — `app/api/admin/**` (38)

- `app/api/admin/api-keys/route.ts` — clean
- `app/api/admin/audit/route.ts` — clean
- `app/api/admin/backups/route.ts` — clean
- `app/api/admin/backups/run/route.ts` — clean
- `app/api/admin/deploy/route.ts` — clean
- `app/api/admin/deploy/test/route.ts` — clean
- `app/api/admin/health/rollback/route.ts` — clean
- `app/api/admin/health/route.ts` — clean
- `app/api/admin/health/sentry-test/route.ts` — clean
- `app/api/admin/integrations/check/route.ts` — clean
- `app/api/admin/integrations/disconnect/route.ts` — clean
- `app/api/admin/integrations/route.ts` — clean
- `app/api/admin/integrations/sentry/restart/route.ts` — clean
- `app/api/admin/invite/route.ts` — F-351 (related)
- `app/api/admin/jobs/[id]/abandon/route.ts` — clean
- `app/api/admin/jobs/route.ts` — clean
- `app/api/admin/plans/route.ts` — F-312, F-316 (related)
- `app/api/admin/quality/route.ts` — clean
- `app/api/admin/servers/[id]/route.ts` — clean
- `app/api/admin/servers/[id]/test/route.ts` — clean
- `app/api/admin/servers/route.ts` — clean
- `app/api/admin/settings/github-app/callback/route.ts` — clean
- `app/api/admin/settings/github-app/start/route.ts` — clean
- `app/api/admin/settings/route.ts` — clean
- `app/api/admin/settings/test/route.ts` — clean
- `app/api/admin/team/[id]/reset-link/route.ts` — clean
- `app/api/admin/team/route.ts` — clean
- `app/api/admin/templates/[id]/route.ts` — clean
- `app/api/admin/templates/[id]/test/route.ts` — clean
- `app/api/admin/templates/[id]/thumbnail/route.ts` — clean
- `app/api/admin/templates/route.ts` — clean
- `app/api/admin/templates/thumbnails/route.ts` — clean
- `app/api/admin/usage/by-member/route.ts` — clean
- `app/api/admin/usage/project/[id]/route.ts` — clean
- `app/api/admin/usage/quality/route.ts` — clean
- `app/api/admin/usage/route.ts` — clean
- `app/api/admin/usage/summary/route.ts` — clean
- `app/api/admin/workspace/route.ts` — clean

### Routes — `app/api/auth/**` (9)

- `app/api/auth/[...nextauth]/route.ts` — clean
- `app/api/auth/dev-login/route.ts` — clean
- `app/api/auth/forgot-password/route.ts` — F-302, F-304
- `app/api/auth/login/route.ts` — F-302, F-304, F-321
- `app/api/auth/logout/route.ts` — clean
- `app/api/auth/me/route.ts` — F-321 (related)
- `app/api/auth/register/route.ts` — clean
- `app/api/auth/reset-password/route.ts` — clean
- `app/api/auth/signup/route.ts` — clean

### Routes — `app/api/cron/**` (14)

- `app/api/cron/backup-db/route.ts` — clean
- `app/api/cron/check-certs/route.ts` — clean
- `app/api/cron/check-domains/route.ts` — clean
- `app/api/cron/check-integrations/route.ts` — clean
- `app/api/cron/check-uptime/route.ts` — clean
- `app/api/cron/cleanup-orphans/route.ts` — clean
- `app/api/cron/observability-heartbeat/route.ts` — clean
- `app/api/cron/observability-quota/route.ts` — clean
- `app/api/cron/purge-projects/route.ts` — clean
- `app/api/cron/reap-jobs/route.ts` — clean
- `app/api/cron/sweep-tmp/route.ts` — clean
- `app/api/cron/system-checks-digest/route.ts` — clean
- `app/api/cron/thin-checkpoints/route.ts` — clean
- `app/api/cron/verify-storage/route.ts` — clean

### Routes — projects, deployments, settings, team, templates, misc (36)

- `app/api/analyze-edit-intent/route.ts` — clean
- `app/api/conversation-state/route.ts` — F-303
- `app/api/deployments/[id]/route.ts` — clean
- `app/api/deployments/route.ts` — clean
- `app/api/extract-brand-styles/route.ts` — F-308 (related)
- `app/api/health/route.ts` — clean
- `app/api/health/sentry-test/route.ts` — clean
- `app/api/legal/accept/route.ts` — clean
- `app/api/legal/data-request/route.ts` — F-310 (related)
- `app/api/onboarding/route.ts` — clean
- `app/api/projects/[id]/duplicate/route.ts` — clean
- `app/api/projects/[id]/export/route.ts` — F-314 (related)
- `app/api/projects/[id]/lock/release/route.ts` — clean
- `app/api/projects/[id]/presence/route.ts` — clean
- `app/api/projects/[id]/quality-signals/route.ts` — F-323
- `app/api/projects/[id]/restore/route.ts` — clean
- `app/api/projects/[id]/route.ts` — clean
- `app/api/projects/route.ts` — F-307, F-314 (related)
- `app/api/scrape-screenshot/route.ts` — clean
- `app/api/scrape-url-enhanced/route.ts` — clean
- `app/api/scrape-website/route.ts` — F-322
- `app/api/search/route.ts` — F-319
- `app/api/settings/api-keys/route.ts` — F-300 (related)
- `app/api/settings/credits/route.ts` — clean
- `app/api/settings/password/route.ts` — clean
- `app/api/settings/profile/route.ts` — clean
- `app/api/settings/storage/route.ts` — clean
- `app/api/settings/usage/route.ts` — F-311 (related)
- `app/api/team/deactivate/route.ts` — clean
- `app/api/team/reactivate/route.ts` — clean
- `app/api/team/route.ts` — clean
- `app/api/templates/[id]/create/route.ts` — clean
- `app/api/templates/[id]/route.ts` — clean
- `app/api/templates/from-project/route.ts` — clean
- `app/api/templates/route.ts` — clean
- `app/api/admin/api-keys/route.ts` — F-300 (related) _(listed above under admin; counted once)_

### Auth, security, plans, db (24)

- `auth.ts` — clean
- `proxy.ts` — clean
- `lib/auth.ts` — clean
- `lib/auth/login-rate-limit.ts` — F-302, F-304
- `lib/auth/public-login.ts` — clean (open-redirect parser is correct: origin comparison, not prefix matching)
- `lib/auth/public-routes.ts` — F-302 (inaccurate `ownMechanism`)
- `lib/auth/route-inventory.ts` — clean
- `lib/auth/route-policy.ts` — F-313
- `lib/auth/session-invalidation.ts` — clean
- `lib/db.ts` — clean
- `lib/plans/actions.ts` — F-311, F-312, F-316, F-310 (stale comment)
- `lib/plans/alerts.ts` — F-306
- `lib/plans/billing.ts` — clean
- `lib/plans/http.ts` — clean
- `lib/plans/index.ts` — clean
- `lib/plans/job-credits.ts` — clean
- `lib/plans/limits.ts` — F-305, F-307, F-315, F-320
- `lib/plans/messages.ts` — clean
- `lib/plans/spend.ts` — clean
- `lib/plans/types.ts` — clean
- `lib/security/reject-log.ts` — clean
- `lib/security/safe-fetch.ts` — F-308, F-317
- `lib/security/untrusted-html.ts` — clean
- `lib/security/url-guard-messages.ts` — clean
- `lib/security/url-guard.ts` — F-308

### Prisma — schema, seeds, migration lock (7)

- `prisma/schema.prisma` — F-300, F-309, F-310, F-314, F-315, F-363
- `prisma/seed.ts` — F-301
- `prisma/seed.mjs` — F-301
- `prisma/seed-templates.ts` — clean
- `prisma/seed-templates.mjs` — clean
- `prisma/builtin-templates.mjs` — clean (prompt data only; `example.com` placeholders, no secrets)
- `prisma/migrations/migration_lock.toml` — clean

### Prisma — migrations (44, all read in full)

- `20260816031950_init` — clean
- `20260816044049_authjs_adapter` — F-361 (related)
- `20260816090000_project_generation_status` — clean
- `20260816093000_navroop_admin` — clean
- `20260816101700_project_workspace_fields` — clean
- `20260816103000_user_is_active` — clean
- `20260816105000_generation_event` — clean
- `20260816111800_project_plan_build` — clean
- `20260816113000_project_stack` — clean
- `20260816120000_project_star` — clean
- `20260816121000_org_api_key` — F-300 (related)
- `20260816125000_github_connection` — clean
- `20260816131000_project_plan_source_trigger` — clean
- `20260816134600_design_direction_input_tokens` — clean
- `20260816140000_checkpoint` — clean
- `20260816152000_seo_audit` — clean
- `20260816152100_project_asset` — clean
- `20260816161000_code_audit` — clean
- `20260816162000_import_source` — clean
- `20260816163000_workspace_skill` — F-310 (related: `Skill.createdById` RESTRICT)
- `20260816164000_memory_entry` — clean
- `20260816165000_quality_signal` — clean
- `20260816171000_checkpoint_object_storage` — F-315 (related: `Workspace.storageBytes INTEGER`)
- `20260816172000_project_sandbox_lifecycle` — clean (superseded)
- `20260817120000_plan_credits` — F-363 (related)
- `20260817130000_publish_deployments` — F-310 (related: `publishedById` RESTRICT)
- `20260817140000_integrations` — clean
- `20260817150000_password_reset_token` — clean
- `20260817180000_custom_domains` — clean
- `20260817190000_backup_run` — clean
- `20260817200000_project_lock_presence` — clean
- `20260817210000_templates` — clean
- `20260817220000_generation_jobs` — F-309
- `20260817230000_export_search_legal_onboarding` — F-309 (generated column vs `dbgenerated` default)
- `20260817250000_jobs_generalize` — clean
- `20260817260000_consumption_caps` — clean
- `20260817270000_audit_invariants` — F-309, F-310
- `20260817280000_preview_builds` — clean
- `20260817290000_sandbox_providers` — clean (superseded)
- `20260817300000_observability_checks` — clean
- `20260817310000_sentry_integration` — clean
- `20260819000000_stacks_three_only` — clean (destructive, correctly marked and back-filled)
- `20260819010000_drop_sandbox_columns` — clean (destructive, correctly marked)
- `20260819020000_template_stack_no_default` — clean

### Read for context, outside scope (cited as related, not judged here)

`lib/api-keys/actions.ts`, `lib/coolify/actions.ts`, `lib/coolify/server-actions.ts`,
`lib/coolify/servers.ts`, `lib/projects/actions.ts`, `lib/projects/list-sql.ts`,
`lib/publish/actions.ts`, `lib/team/actions.ts`, `lib/profile/actions.ts`,
`lib/templates/actions.ts`, `lib/search/projects.ts`, `lib/cron/handle.ts`, `lib/cron/auth.ts`,
`lib/preview/token.ts`, `lib/preview/serve.ts`, `lib/ensure-admin.ts`, `lib/ensure-member.ts`,
`lib/dev-quick-login.ts`, `lib/checkpoints/thin.ts`,
`app/api/projects/[id]/files/route.ts`, `app/api/projects/[id]/preview/route.ts`,
`app/preview-static/[projectId]/[[...path]]/route.ts`,
`scripts/check-public-routes.ts`, `tests/unit/api-route-auth.test.ts`,
`tests/unit/auth-matrix.test.ts`.

**Nothing in scope went unread.**
