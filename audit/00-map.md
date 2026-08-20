# Audit map — routes, state machine, data model, invariants

Built from the code, not from the docs. Where the docs and the code disagree, the
disagreement is a Section M finding, and this file records what the _code_ says.

Counts at audit time: **140** `route.ts` handlers, **35** `page.tsx`, **38** Prisma models,
**45** migrations, 1859 non-generated files / 228,899 lines.

## 1. Route inventory

Generated with `find app -name route.ts` / `page.tsx`; the per-route ownership matrix
(who may call it, which check it performs) is in `04-security-data.md` — that is where
Section I lives, and the table is too long to duplicate here.

Groups:

| Group                                          | Count  | Gate expected                             |
| ---------------------------------------------- | ------ | ----------------------------------------- |
| `app/api/admin/**`                             | see P4 | `requireAdmin`                            |
| `app/api/projects/[id]/**`                     | see P4 | session + project ownership (`canMutate`) |
| `app/api/cron/**`                              | 16     | `Bearer CRON_SECRET` via `handleCron`     |
| `app/api/auth/**`                              | see P4 | public by allowlist, own mechanism        |
| `app/api/github/**`, `app/api/integrations/**` | see P4 | session, admin for writes                 |
| `app/(app)/**` pages                           | 35     | layout-level `requireAdmin` for `admin/*` |
| `app/preview-static/**`                        | —      | signed token, not a cookie                |

## 2. Job state machine (from `prisma/schema.prisma:45-64` and `lib/jobs/`)

`JobKind`: `PLAN | BUILD | FOLLOWUP | IMPORT | AUDIT | PUBLISH | DOMAIN_VERIFY | EXPORT | TEMPLATE_THUMBNAIL`
`JobStatus`: `QUEUED | RUNNING | SUCCEEDED | FAILED | ABANDONED | CANCELLED`

```
            startJob
               │
               ▼
   ┌───────► QUEUED ──────────────┐
   │           │ claim/RUNNING     │ cancelJob
   │           ▼                   ▼
   │        RUNNING ──────────► CANCELLED (terminal)
   │        │  │  │
   │        │  │  └── failJob ──► FAILED (terminal)
   │        │  └───── succeedJob ► SUCCEEDED (terminal)
   │        └──────── abandonJob ► ABANDONED (terminal)
   │                    ▲
   │                    │ reaper: stale heartbeat (>60s), 20 min timeout,
   │                    │ boot reconcile (instrumentation.ts), SIGTERM drain
   └────────────────────┘
```

Documented invariants to verify (AGENTS.md "Jobs"):

- every terminal write goes through `updateJobIfActive` (`WHERE status IN ('QUEUED','RUNNING')`)
- a win is the UPDATE row count, never a re-read
- heartbeat 10 s, stale 60 s, hard timeout 20 min even with a fresh heartbeat
- `listReconcileCandidates` uses `COALESCE("heartbeatAt","createdAt")`
- credits charged once at RUNNING (`creditsChargedAt`)
- `ProjectPhase` (`PLANNING | BUILDING | COMPLETE`) is a side effect of job transitions
- `COMPLETE` requires site evidence (`lastCode` / checkpoint), never `filesWritten`

## 3. Data model summary

> **Correction, made during the audit.** This table originally listed
> `SandboxProviderConfig` and treated the AGENTS.md "sandbox provider rules" as an
> invariant to check. That was wrong, and it was wrong because I trusted the product
> map. Migration `prisma/migrations/20260819010000_drop_sandbox_columns` deleted the
> whole sandbox subsystem: `lib/sandbox/` does not exist, `PreviewMode` has one member
> (`STATIC`, `prisma/schema.prisma:41-43`), and neither `SandboxStatus` nor
> `SandboxProviderConfig` is in the schema. Previews are now built in the browser
> (`components/workspace/BrowserPreview.tsx` + esbuild-wasm) and on the server by
> `lib/preview/server-bundle.ts`. The documentation defect is F-520/F-521/F-522/F-523;
> the audit invariant "sandbox provider rules match the code" is void and is replaced
> by "no code path still references the deleted subsystem".

| Model                               | Role                             | Notes to check                                                             |
| ----------------------------------- | -------------------------------- | -------------------------------------------------------------------------- |
| `Project`                           | the unit of work                 | `phase`, `lastCode`, `previewMode`, lock fields, `searchVector` (unmapped) |
| `Job` (`@@map("GenerationJob")`)    | all background work              | `steps`, `resourceIds`, `creditsChargedAt`                                 |
| `Checkpoint`                        | snapshot per generation          | object storage via `snapshotKey`; `fileSnapshot` legacy                    |
| `PreviewBuild`                      | static preview snapshot          | `activePreviewBuildId` on Project                                          |
| `ProjectAsset`                      | images                           | `kind: generated \| stock \| uploaded`, `storageKey`                       |
| `AppSetting`                        | admin config + counters          | `setting:` namespace, encrypted secrets                                    |
| `Integration`                       | GitHub/Cloudflare/Coolify/Sentry | AES-256-GCM secrets                                                        |
| `Deployment`                        | publish result                   | `ON DELETE RESTRICT` per docs                                              |
| `CustomDomain`                      | client hostnames                 | Path A / Path B                                                            |
| `Plan`, `CreditLedger`, `Workspace` | limits and spend                 | atomic consume claimed                                                     |
| `AuditLog`                          | operator trail                   | scrubbed, non-throwing                                                     |
| `Skill`, `MemoryEntry`              | prompt injection surfaces        | prefix placement rules                                                     |
| `PasswordResetToken`                | reset                            | sha256 only                                                                |

## 4. Invariants this audit checks

Drawn from AGENTS.md and `.cursor/lessons-learned.md`, each one either confirmed in code
or filed as a finding:

1. **Auth gate** — `proxy.ts` denies `/api` + `/preview-static` unless allowlisted; routes still check ownership.
2. **No self-fetch** — no API route calls a sibling route on its own origin.
3. **Terminal-write race** — job settle uses row count, not a re-read.
4. **`[]`/`{}`/`false` is not "nothing happened"** — a caught error may not become an innocent empty value.
5. **`NEED_IMAGE:` tokens never reach stored files** — parser plus textual sweep.
6. **Generated images carry no text** — subject substitution, verified against the live worker.
7. **Snapshot reads throw** — `SnapshotReadError` never falls back to `lastCode`.
8. **Client/server boundary** — no `'use client'` file reaches Prisma/logger/`node:*`.
9. **`'use server'` exports are all async.**
10. **Raw SQL** — no composed `Prisma.sql` inside a tagged template.
11. **Provider resolution** — one path (`loadEffectiveProviderEnv` + `clientForEntry`); `requestedModel` explicit-only.
12. **Credits** — charged once, at RUNNING; per-job caps abort the stream.
13. **Secrets** — never logged, never returned to a client, `last4` only.
14. **Notify** — all user feedback through `lib/notify.ts`.
15. **Tests** — `TEST_DATABASE_URL` only; loopback blocked unless `allowLocalhost`.
16. ~~**Sandbox teardown copy** — "not billed" only on proven `stopped`/`already_gone`.~~
    **Void**: the subsystem was deleted (see the correction in §3). Replaced by: **no code
    path, doc, or test still references `lib/sandbox`, `SandboxStatus`,
    `SandboxProviderConfig`, or `/api/cron/reap-sandboxes`** — every surviving reference is
    a finding.
17. **Settings precedence** — DB row → env → registry fallback, secrets encrypted.
18. **Cron** — every run writes a `CronRun`, success or failure.

## 5. Method note

Phase scopes are disjoint and cover all 1859 inventoried files
(`audit/_scope-*.txt`, generated by `audit/_scope.mjs`). Every phase agent read its own
list in full; the ledger in `00-inventory.md` records the verdict per file.
