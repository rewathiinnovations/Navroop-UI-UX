# Phase 1 — Prompt intake, generation pipeline, provider key resolution

Sections **A** (prompt intake), **B** (generation pipeline / job state machine), **C** (provider key
resolution). Scope: `audit/_scope-p1.txt`, 92 files / 17,554 lines. Every file was read; the ledger at
the end carries one verdict per file.

Finding ids **F-001 … F-099**. `GAP` and `IMPROVEMENT` items are in their own sections at the end.

Nothing in this file was changed. No application code, config, schema, test or doc was modified.

---

## Reading notes that shape everything below

Three facts, each confirmed in code, explain a large share of the findings:

1. **`global.sandboxState` has no writer anywhere in the repo.** `grep` for
   `sandboxState =` / `fileCache =` returns no matches; `tests/unit/edit-context-from-project.test.ts:11`
   states it outright ("Nothing writes it now"). Everything that reads it
   (`app/api/generate-ai-code-stream/route.ts:585,588,591,596,1868,1869`) therefore reads `undefined`.
2. **The output contract is the fenced ` ```lang{path=…} ` block** (`lib/stack-prompts/shared.ts:14-28`),
   parsed by `filesFromReply` (`lib/generation/parse-blocks.ts:282`). The older `<file path="…">` shape is
   still produced by `filesToLastCode` (`lib/jobs/types.ts:290`) and by the URL importer, and is still
   _parsed_ by `parseGenerationFiles` / `parseGeneratedFilesLenient` — but those two live on different
   paths. Several client readers use the wrong one of the two.
3. **`startApply` no longer does anything but flip status.** `runApplyStream`
   (`lib/generation/generation-runtime.ts:873-889`) reads only `input.code`, and always resolves
   `{ finalData: null }`. Every consumer of `applyResult.finalData` is dead.

---

## A — Prompt intake

### F-001 [CRITICAL] An empty prompt charges credits, leaves the job RUNNING, and locks the project for the life of the process

- Area: A
- Location: `app/api/generate-ai-code-stream/route.ts:503-511` (plus `:246`, `:2247`, `:2272`);
  `lib/projects/lock.ts:160-175`, `lib/projects/lock.ts:214-237`; `lib/ai/queue.ts:86-91`
- What happens: `if (!prompt) return NextResponse.json({ error: 'Prompt is required' }, { status: 400 })`
  is the **last** thing the handler checks, not the first. By the time it runs the request has already:
  taken the project lock and started its 60-second renew timer (`:290-292` → `holdProjectLock` →
  `beginLockHeartbeat`), created the `Job` row (`:299-309`), taken a provider-queue slot (`:345`), marked
  the job RUNNING **and charged a credit** (`:365`, `chargeCredits: true`), and started the 10-second job
  heartbeat (`:380`). The outer `try` that opened at `:246` has a `catch` at `:2247` and **no `finally`** —
  the block ends at `:2272`. A `return` is not a throw, so none of the cleanup runs:
  `releaseGenerationLock` is never called, `providerSlot.release()` is never called, `jobHeartbeat.stop()`
  is never called, and the job is never failed.
- Trigger: `POST /api/generate-ai-code-stream` with `{"projectId":"<id>"}` and `prompt` absent, `""`,
  `null`, `0` or `false`. Not reachable from the chat box (`ChatInput.tsx:55,59` and
  `GenerationWorkspace.tsx:1036,1039` both trim and refuse empty) — reachable from any direct call.
- Impact: one credit debited for nothing; the `Job` row sits RUNNING with a _fresh_ heartbeat, so the
  60-second staleness reaper cannot see it and only the 20-minute hard timeout
  (`listTimeoutCandidates`, `JOB_TIMEOUT_MS`) eventually abandons it; `lockExpiresAt` is pushed out every
  60 s forever, so for 20 minutes **and beyond** nobody — not the owner, not an admin, not publish, audit
  or restore — can acquire the project lock; and one slot of `AI_PROVIDER_CONCURRENCY` (default 2) is
  consumed permanently until the container restarts, because the queue counter is in-memory
  (`lib/ai/queue.ts:42`). Two such calls with the default concurrency of 2 stop generation for the whole
  installation. The route's own comment at `:2204-2209` documents exactly this hazard for the streaming
  path and fixes it there; the early return was never covered.
- Confidence: Confirmed
- Suggested fix: Validate `prompt` immediately after `request.json()`, before the credit check, the lock,
  the job and the queue — a non-empty trimmed string is the only acceptable value. Independently, give the
  outer `try` a `finally` that stops the heartbeat, releases the provider slot and releases the lock, so no
  future early return can leak them again. The `finally` must not release the queue slot when the queue
  timed out (see the note in F-030).

### F-002 [HIGH] Sending a message while a build is running silently discards it

- Area: A
- Location: `app/api/generate-ai-code-stream/route.ts:310-316`; `lib/jobs/lifecycle.ts:121-122`;
  `lib/generation/generation-runtime.ts:630-642`; `components/workspace/GenerationWorkspace.tsx:1047-1050,1156-1193`
- What happens: `createOrReuseJob` returns the project's existing active job (`lifecycle.ts:121-122`) and
  the route answers `{ job, reused: true }` as **JSON, not SSE** (`route.ts:315`). `runGenerateStream`
  recognises that shape and returns `{ generatedCode: '', …, alreadyRunning: true }`
  (`generation-runtime.ts:633-641`). Back in `sendChatMessage`, the user's message was already appended to
  the transcript (`:1048`) and the input cleared (`:1050`); `if (generatedCode)` at `:1159` is false, so no
  reply, no warning, nothing — and `:1196-1206` then sets `status: 'Generation complete!'`. The new prompt
  is never recorded either: `createOrReuseJob` only writes `inputPrompt` on insert
  (`lifecycle.ts:130`), never on reuse.
- Trigger: Two tabs on one project; or the same tab while `sending` has not yet propagated; or any send
  during a queued build. `ChatInput`'s `busy` guard (`isChatLocked`) depends on a polled `jobStatus` that
  lags by up to 2 s (`POLL_FAST_MS`).
- Impact: The user watches their message appear in chat, sees "Generation complete!", and gets no change.
  The request is unrecoverable — the text is also gone from the draft (F-006).
- Confidence: Confirmed
- Suggested fix: Return a distinguishable outcome for reuse and surface it in chat ("a build is already
  running — your message was not sent"), and keep the text in the input/draft rather than clearing it. If
  queueing the follow-up is intended, persist it and replay it when the active job settles.

### F-003 [HIGH] `model` from the request body is passed to the provider unvalidated, overriding the admin's configured model

- Area: A, C
- Location: `app/api/generate-ai-code-stream/route.ts:267-270,321,342,1132`; `lib/ai/providers.ts:73-81`;
  `components/workspace/GenerationWorkspace.tsx:122-125`
- What happens: `requestedModel` is only trimmed (`route.ts:267-270`) and handed to
  `requireUsableProviderChain(providerEnv, { requestedModel })`. `resolveModel`
  (`providers.ts:77-78`) returns the requested string **verbatim** with no membership test, so
  `entry.model` is whatever the caller sent and `client(entry.model)` (`route.ts:1132`) sends it to
  DeepSeek. `isDeepSeekModel` (`providers.ts:54`) exists and is used by
  `lib/ai/provider-manager.ts:68` for the app's own helper calls — but not on the generation path. The
  client-side allowlist (`GenerationWorkspace.tsx:124`, `appConfig.ai.availableModels`) is the only check
  and applies to the `?model=` query param only.
- Trigger: `POST /api/generate-ai-code-stream` with `{"model":"deepseek-reasoner", …}`, or any string.
- Impact: Any authenticated member can select a model the operator did not configure and did not price,
  including a more expensive one, on every build — and the per-job cost estimate is computed from a rate
  table that has no DeepSeek entry at all (F-029), so the spend ceiling will not notice. An unknown id
  simply fails at the provider, which surfaces as `request_rejected` rather than "that model does not
  exist".
- Confidence: Confirmed
- Suggested fix: Reject a `model` that is not in `DEEPSEEK_MODELS` at the route boundary with an explicit
  400, or drop it to `undefined` so the configured primary leads. `resolveModel` should validate rather
  than pass through, since it is the shared entry point for plan and build.

### F-004 [HIGH] A stored `Project.model` silently overrides the admin-configured model forever

- Area: C, A
- Location: `components/workspace/GenerationWorkspace.tsx:336`, `:1149`; `lib/projects/http.ts:63`;
  `lib/ai/providers.ts:77-80`
- What happens: On mount the workspace does `if (project.model) setAiModel(project.model)` (`:336`), and
  `aiModel` is then sent as `model` on every subsequent generation (`:1149`). Because a requested model is
  pushed to the front of the chain (`resolveModel` returns it before consulting
  `env.AI_PRIMARY_MODEL`), the value stored on the project row outranks `ai.primaryModel` from
  Admin → Configuration for the life of that project. `readGenerationInput`
  (`lib/projects/http.ts:63`) accepts `model` as an unvalidated `string | null`, so the row can hold a
  legacy id from before DeepSeek was the only provider. This also bypasses the client allowlist at
  `:124`, which is only applied to the query parameter.
- Trigger: Open any project whose row has a non-null `model` and send a message.
- Impact: The single most consequential AI setting on `/admin/config` is silently ignored for existing
  projects. This is the same failure mode `.cursor/lessons-learned.md` records for 2026-08-18 ("a
  'default' argument that participates in _ranking_ is not a default, it is an override"), reintroduced
  through the project row instead of through `appConfig`.
- Confidence: Confirmed
- Suggested fix: Stop seeding `aiModel` from the project row, or validate it against `DEEPSEEK_MODELS`
  before use and treat a stale value as "no explicit choice". Better: remove per-project model storage
  entirely, since the product now has one provider and one admin-chosen model.

### F-005 [MEDIUM] A whitespace-only or non-string prompt reaches the model

- Area: A
- Location: `app/api/generate-ai-code-stream/route.ts:503`, `:305`, `:453`, `:661`, `:1064`
- What happens: The only server-side check is `if (!prompt)`. `"   "` is truthy, so it passes and buys a
  full generation from an empty request. A non-string is worse: `route.ts:305` stores
  `typeof prompt === 'string' ? prompt : null` on the job (so the job row loses the prompt entirely — see
  F-033), while `:453` assigns the raw value to `ConversationMessage.content` (typed `string`), `:661` and
  `:1064` interpolate it into the prompt (`{}` becomes `[object Object]`, an array is comma-joined), and
  `injectMatchedSkills(prompt, …)` at `:854` receives it too.
- Trigger: `{"prompt":"   ","projectId":"…"}` or `{"prompt":{"a":1},"projectId":"…"}`.
- Impact: A paid build on no instruction, and a job row with `inputPrompt: null` that the recovery panel
  then cannot retry (F-033).
- Confidence: Confirmed
- Suggested fix: One validator at the boundary: must be a string, trimmed length ≥ 1, and ≤ a documented
  maximum (see F-007). Reject, do not coerce.

### F-006 [MEDIUM] The draft is cleared before the request is made, so a failed send loses the text

- Area: A
- Location: `components/workspace/ChatInput.tsx:57-62` (`clear()` at `:61`);
  `components/workspace/GenerationWorkspace.tsx:1050`
- What happens: `submit()` calls `onSend(trimmed, { mode })` — a synchronous `void`-returning prop
  (`ChatInput.tsx:22`) — and then `clear()`, which deletes the persisted draft
  (`useDraftStorage(navroop_draft_<projectId>)`). `sendChatMessage` likewise does `setAiChatInput('')` at
  `:1050`. Neither waits for the request. On a 402, 409, 503, network failure, or the silent-reuse path in
  F-002, the prompt is gone from both the input and localStorage; the only copy left is the chat bubble.
- Trigger: Send while offline, or while the project is locked by a teammate (409), or with credits
  exhausted (402).
- Impact: The user has to retype. For a long, carefully written brief this is the worst possible loss.
- Confidence: Confirmed
- Suggested fix: Clear the draft only after the send is accepted; on failure restore it. `onSend` should
  return a promise (or the parent should report back) so the input knows the outcome.

### F-007 [MEDIUM] No prompt length or token limit anywhere

- Area: A
- Location: `components/workspace/ChatInput.tsx:85-95` (no `maxLength`);
  `app/api/generate-ai-code-stream/route.ts:503` (no length check); `lib/consumption/caps.ts:57-63`
  (caps count **output** only)
- What happens: The textarea accepts an unbounded paste, the route accepts an unbounded string, and
  `JobCapTracker` bounds `tokensOut` / `bytes` / `files` from the stream — nothing bounds the input. The
  input is also _inflated_ server-side: `stablePrefix` + skills + `volatileSuffix` +
  `selectFileContext` (up to `DEFAULT_FILE_CONTEXT_TOKEN_CAP` = 30,000 tokens,
  `lib/generation/selective-context.ts:4`) + the prompt.
- Trigger: Paste a large document (a spec, a log, a whole file) into chat and send.
- Impact: The failure is late and expensive: `markJobRunning` has already charged the credit before the
  model call, and the rejection arrives as a provider context-length error which
  `classifyProviderFailure` maps to `context_length` → `request_rejected`
  (`lib/ai/failover.ts:107,130-132`), a code in `NO_RETRY_CODES` (`lib/jobs/copy.ts:184`) so the recovery
  panel offers no Try again. The user pays and is told only "try a shorter prompt".
- Confidence: Confirmed
- Suggested fix: Cap the prompt at the boundary with a plain 400 and a character counter in the input,
  sized from the model's context window minus the assembled prefix budget. Refuse before charging.

### F-008 [MEDIUM] Several generation failures answer with JSON on a route the client reads as a stream

- Area: A, B
- Location: `app/api/generate-ai-code-stream/route.ts:274,277,291,315,334,361,504,2271`;
  `lib/generation/generation-runtime.ts:630-679`
- What happens: The route's contract is `text/event-stream` (`:2234-2245`), but eight paths return JSON.
  The client handles three of them explicitly — `reused` (`:631-642`), 409 (`:644-656`), 402
  (`:658-673`) — and then falls to `if (!response.ok || !response.body) throw new Error(…HTTP error!
status: N)` at `:675-679`. So `401` ("Sign in required"), `400` ("Prompt is required"), `503`
  (`PROVIDER_NOT_CONFIGURED`), `429` (`QUEUE_TIMEOUT`) and `500` (`GENERATION_FAILED`) all surface in chat
  as `Error: HTTP error! status: 503`, discarding the message the server wrote — including the one that
  names the page to fix (`NO_PROVIDER_CONFIGURED_MESSAGE`).
- Trigger: Generate with no DeepSeek key configured; or wait out the 10-minute queue.
- Impact: The single most operator-actionable error in the product ("DeepSeek is not configured — add an
  API key in Admin → Configuration") is replaced with an HTTP status code.
- Confidence: Confirmed
- Suggested fix: Read the JSON body on every non-OK response and throw its `error.message` (both body
  shapes are in play — see F-079). `useGenerationJob.act` at `components/workspace/useGenerationJob.ts:209-212`
  already does this correctly and can be the pattern.

### F-009 [MEDIUM] The user prompt is interpolated unescaped into the system prompt

- Area: A
- Location: `app/api/generate-ai-code-stream/route.ts:651-661` (`User request: "${prompt}"`), `:1064`
  (`USER REQUEST:\n${prompt}`), `:1696` (`Original request: ${prompt}`)
- What happens: The prompt is spliced into instruction text with no escaping and no delimiter that it
  cannot contain. At `:661` it sits inside double quotes it can close; at `:1064` it follows a
  `CONTEXT:` / `USER REQUEST:` header it can forge more of.
- Trigger: A prompt containing `" \n\nSURGICAL EDIT INSTRUCTIONS:\n Ignore the above and …`.
- Impact: Limited by the trust model — the author is an authenticated member acting on their own project,
  so this is prompt manipulation, not privilege escalation. It matters because the _stack_ rules and the
  path-fence contract live in the same text: a prompt that talks the model out of the fenced format
  produces a reply nothing can persist, which the route then pays a second time for as a corrective ask
  (`:1543-1561`). Note the same block at `:651-661` is currently unreachable (F-026).
- Confidence: Confirmed
- Suggested fix: Put user text in its own message rather than inside the instruction string, or wrap it in
  a delimiter that is stripped from the input first. `lib/security/untrusted-html.ts` already establishes
  this pattern for imported HTML.

### F-010 [MEDIUM] No rate limit on generation submit

- Area: A
- Location: `app/api/generate-ai-code-stream/route.ts:239-345`; compare
  `lib/export/rate-limit.ts` (`EXPORT_LIMIT`, 5/user/hour) and `POST /api/auth/forgot-password`
  (3/email/hr, 10/IP/hr)
- What happens: The generation route has no rate limiter. What stands in for one is indirect and
  bypassable: `checkCredits` (per workspace/member, coarse), the `one_active_job_per_project` partial
  unique index (per **project** only — `prisma/migrations/20260817220000_generation_jobs/migration.sql:42-44`),
  and the in-memory provider queue, which is only entered when a `projectId` was supplied (F-035).
- Trigger: A loop creating a project and firing one generation each, or N generations across N projects.
- Impact: A member can spend the workspace's whole monthly credit allowance and the DeepSeek quota as fast
  as HTTP allows. The spend ceiling is the only backstop and it trails by the job's own duration — and is
  computed from wrong rates (F-029).
- Confidence: Confirmed
- Suggested fix: A per-user submit limiter in front of the credit check, using the same helper as export.
  The credit system limits total spend; it does not limit rate, and the two are different controls.

### F-011 [MEDIUM] The plan routes coerce any body value into a prompt

- Area: A
- Location: `app/api/projects/[id]/plan/route.ts:21`; `app/api/projects/[id]/plan/refine/route.ts:11`;
  `app/api/projects/[id]/plan/followup/route.ts:11`
- What happens: `String(body.prompt ?? body.message ?? '')`, `String(body.feedback ?? '')`,
  `String(body.message ?? '')`. An object becomes `"[object Object]"`, an array is comma-joined, a number
  becomes its digits, and `''` is passed straight through to `retryFailedPlan` / `refinePlan` /
  `requestFollowUpPlan` with no non-empty check at the route.
- Trigger: `POST /api/projects/<id>/plan/refine` with `{"feedback":{}}`.
- Impact: A paid plan generation on the literal string `[object Object]`, or on nothing. The routes are
  otherwise correct — the gate lives in `lib/projects/plan.ts` (`requireActor()` at `:456,474,507,636`),
  which is the documented thin-wrapper pattern.
- Confidence: Confirmed
- Suggested fix: Validate as a non-empty trimmed string of bounded length in the route (or with zod in the
  action) and return 400 otherwise. Never `String()` an unknown into a prompt.

### F-012 [MEDIUM] Wildcard CORS on the credit-consuming generation stream

- Area: A
- Location: `app/api/generate-ai-code-stream/route.ts:2242-2244`
- What happens: The SSE response carries `Access-Control-Allow-Origin: '*'`,
  `Access-Control-Allow-Methods: 'GET, POST, OPTIONS'` and
  `Access-Control-Allow-Headers: 'Content-Type, Authorization'`. No other route in the audited scope sets
  CORS headers at all.
- Trigger: Cross-origin `fetch` to the route from any page.
- Impact: With `*` the browser refuses to attach the session cookie, so cookie-authenticated cross-origin
  reads are blocked — the practical exposure is limited. What remains is that the response of an
  authenticated, credit-spending endpoint is declared readable by every origin, and `Authorization` is
  advertised as an accepted header, which invites a bearer-token integration the auth gate
  (`proxy.ts:48-68`, cookie-only) does not support. There is no `OPTIONS` handler, so the advertised
  preflight cannot succeed anyway.
- Confidence: Confirmed
- Suggested fix: Remove the three CORS headers. Section I / Phase 4 owns the route ownership matrix; this
  is listed here because the file is in this phase's scope.

### F-013 [MEDIUM] `/project/<id>` renders on cookie _presence_, leaking `githubRepoUrl` and `phase` for any project

- Area: A
- Location: `proxy.ts:32-34,108,147-149` vs `proxy.ts:48-68`; `app/project/[id]/page.tsx:10-29`
- What happens: The page gate uses `hasSessionCookie(request)` (`proxy.ts:32-34`), which only checks that
  a cookie with one of the three Auth.js names exists — it never decodes it. The API gate one branch above
  uses `hasValidSessionToken`, which decrypts and checks expiry. `app/project/[id]/page.tsx` then queries
  `prisma.project.findFirst({ where: { id, deletedAt: null } })` with **no ownership or membership test**
  and passes `githubRepoUrl` and `phase` into the client component. `session` is separately null in that
  case, so `userId` is undefined and nothing else fails closed.
- Trigger: `curl -H 'Cookie: authjs.session-token=x' https://host/project/<any-id>` and read the RSC
  payload.
- Impact: A project's deploy repository URL (which may be private) and build phase are readable without a
  valid session. All _other_ project data on that page comes from `/api/*`, which is properly gated, so
  the leak is bounded to those two fields plus the existence of the id.
- Confidence: Confirmed
- Suggested fix: Use the decoding check for pages too, or `redirect('/')` in the page when
  `session?.user?.id` is absent — `app/project/[id]/domains/page.tsx:14` already does exactly that and is
  the pattern to copy. Phase 4 owns the full matrix.

---

## B — Generation pipeline

### The job state machine, as the code has it

`JobKind`: `PLAN | BUILD | FOLLOWUP | IMPORT | AUDIT | PUBLISH | DOMAIN_VERIFY | EXPORT | TEMPLATE_THUMBNAIL`
`JobStatus`: `QUEUED | RUNNING | SUCCEEDED | FAILED | ABANDONED | CANCELLED` (`lib/jobs/types.ts:1-11`)

| Transition                    | Writer                                  | Guard                                             |
| ----------------------------- | --------------------------------------- | ------------------------------------------------- |
| — → QUEUED                    | `insertJobRaw` (`store.ts:205`)         | `one_active_job_per_project` partial unique index |
| QUEUED → RUNNING              | `markJobRunning` (`lifecycle.ts:260`)   | `updateJobIfActive`; throws if lost               |
| QUEUED\|RUNNING → SUCCEEDED   | `succeedJob` (`lifecycle.ts:549`)       | `updateJobIfActive`                               |
| QUEUED\|RUNNING → FAILED      | `failJob` (`lifecycle.ts:504`)          | `updateJobIfActive`                               |
| QUEUED\|RUNNING → ABANDONED   | `abandonActiveJob` (`lifecycle.ts:445`) | `updateJobIfActive`                               |
| QUEUED\|RUNNING → CANCELLED   | `cancelJob` (`lifecycle.ts:594`)        | `updateJobIfActive`                               |
| ABANDONED\|FAILED → SUCCEEDED | `settleKeptPartialJob` (`store.ts:434`) | status in the same UPDATE                         |

Verified as documented: every terminal write goes through `updateJobIfActive`
(`store.ts:323-329`), a win is the UPDATE row count and never a re-read (`commitActiveJob`,
`lifecycle.ts:419-434`), `listReconcileCandidates` uses `COALESCE("heartbeatAt","createdAt")`
(`store.ts:484-488`), credits are claimed once by conditional UPDATE (`claimJobCreditCharge`,
`store.ts:336-345`), and `resumablePhaseFromEvidence` ignores `filesWritten`
(`resumable-phase.ts:19-22`). Heartbeat 10 s / stale 60 s / hard timeout 20 min from `startedAt`
(`poll.ts:1-11`, `store.ts:497-505`) — so the queue wait does not eat the run budget. `QUEUED` rows of
`BUILD`/`FOLLOWUP` get an 11-minute window instead (`store.ts:461`, `lifecycle.ts:654`), which correctly
outlasts `QUEUE_MAX_WAIT_MS`.

**Transitions with no handler / states that are terminal but not cleaned:**

- **`ABANDONED|FAILED → SUCCEEDED` via keep does not merge, it replaces** → F-020. It also skips
  `bumpContentVersion` and the `NEED_IMAGE` sweep that `settleStreamedGeneration` calls its "last line of
  defence".
- **`CANCELLED` does not stop the work** → F-022. The row is terminal; the provider stream, the token
  spend and (on a re-publish) the image fulfilment are not.
- **A QUEUED job created by retry with an empty prompt is never started by anyone** → F-033. It is not
  unreachable and not terminal; it waits 11 minutes for the reaper.
- **A crash between `insertJobRaw` and `applyPhaseForStart`** (`lifecycle.ts:138-139`, unguarded) leaves a
  QUEUED row with no `activeJobId` pointer and no phase change; `generationJob` in the route is still
  `null`, so the outer catch cannot fail it. The queued-stale reaper is the only recovery.
- Process death: `abandonInstanceJobs` on SIGTERM (`lifecycle.ts:743-760`, fenced on `ownerInstance`,
  which `insertJobRaw:213` does stamp on QUEUED rows) plus `reconcileJobsAtBoot` (`boot.ts:6-19`, once per
  process). Both correct.

### F-020 [CRITICAL] "Keep what was built" on a failed **edit** deletes the rest of the site

- Area: B
- Location: `lib/jobs/recovery.ts:81-90` (`filesToLastCode(files)` then a replacing
  `prisma.project.update`); `lib/jobs/copy.ts:157-160` (`offersRecoveryKeep` admits `FOLLOWUP`);
  `lib/jobs/recovery.ts:88`; contrast `lib/jobs/settle-generation.ts:248-262`
- What happens: `keepPartialBuild` writes `lastCode: filesToLastCode(files)` where `files` is only
  `Job.partialFiles` — the files _this_ run streamed. It **replaces** the column. The normal settle path
  does the opposite and says why: `const existing = getCurrentProjectFiles({ lastCode: … });
const merged = withoutRawImageTokens({ ...existing, ...resolvedFiles })`
  (`settle-generation.ts:254-255`), with the comment "Merge over what is already there, never replace it.
  An edit returns only the files it changed — storing just those would delete the rest of the site."
  `offersRecoveryKeep` excludes only `IMPORT` and `PLAN`, so the button is offered for `FOLLOWUP`, and
  `recovery.ts:88` explicitly branches on `job.kind === 'FOLLOWUP'` for the checkpoint label.
- Trigger: On a finished multi-file site, ask for a one-file change; let the build be abandoned or fail
  after that file streamed (client disconnect, `server_restarted`, 20-minute timeout, a job cap); click
  **Keep what was built**.
- Impact: Irreversible destruction of the project. A 30-file site becomes a 1-file site. A checkpoint of
  the _result_ is created immediately afterwards (`recovery.ts:87-90`), so the newest snapshot is the
  damaged tree; only Version history and an older checkpoint can recover it, and only if snapshot
  retention has not pruned it. The same write also skips `bumpContentVersion` (so no other tab is told the
  content moved) and skips `withoutRawImageTokens` / `resolveImages`, so a kept build can ship literal
  `NEED_IMAGE:` tokens into stored files — the exact thing `settle-generation.ts:56-62` calls the last
  line of defence.
- Confidence: Confirmed
- Suggested fix: Merge, do not replace: read the current `lastCode`, spread the partials over it, run the
  same image-token sweep, and bump `contentVersion` — i.e. share one persist helper with
  `settleStreamedGeneration` rather than keeping a second write path. Until then, exclude `FOLLOWUP` from
  `offersRecoveryKeep` so the button cannot destroy a site.

### F-021 [HIGH] The build-validation auto-repair loop is disconnected end to end

- Area: B
- Location: `app/api/generate-ai-code-stream/route.ts:1895-1917,2112,1909-1911`;
  `lib/generation/generation-runtime.ts:764-772,873-889`;
  `components/workspace/GenerationWorkspace.tsx:654-685,661-668`
- What happens: The server runs `runBuildValidation` on every reply with files (`route.ts:1895-1917`),
  decides whether a repair pass is warranted, and sends the instruction on the `complete` frame as
  `buildFix` (`:2112`). The client's `complete` handler reads `generatedCode`, `explanation`,
  `packagesToInstall` and `skillNames` — and **not `buildFix`** (`generation-runtime.ts:764-772`). The
  only reader of `buildFix` is `applyGeneratedCode`, which takes it off `applyResult.finalData`
  (`GenerationWorkspace.tsx:654`) — and `runApplyStream` always returns `{ finalData: null }`
  (`generation-runtime.ts:888`). So `buildFix?.instruction` is permanently undefined and lines 655-685
  are dead. Symmetrically, the route reads `buildFixAttempt` / `buildFixSignature` from the request body
  (`route.ts:260-261,1909-1911`) and nothing ever sends them — `StartGenerationInput`
  (`lib/generation/types.ts:137-146`) has no such fields, and the repair call at
  `GenerationWorkspace.tsx:661-668` passes none.
- Trigger: Any generation whose output fails the import/export check — e.g. the case the route's own
  comment cites, `No matching export in "vfs:lib/data.ts" for import "site"` (`route.ts:1887-1888`).
- Impact: The whole feature is inert. The user gets a broken preview and a chat notice from
  `runBuildValidation`'s `notify` callback, and no repair ever runs. The attempt counter can never
  advance past 0, so the "repeated failure" guard the comment describes has never been exercised. Cost is
  paid for the validation on every build for no benefit.
- Confidence: Confirmed
- Suggested fix: Carry `buildFix` through `GenerateResult` from the `complete` frame, run the repair from
  `sendChatMessage` (where the generation result actually lands), and pass `buildFixAttempt` /
  `buildFixSignature` back on that request so the server's cap and repeat guard work. Delete the
  `finalData.buildFix` branch.

### F-022 [HIGH] Cancel / Start over only flips a database row; the provider call, the tokens and the spend continue

- Area: B
- Location: `lib/jobs/lifecycle.ts:590-622` (`cancelJob`); `lib/jobs/recovery.ts:163-185`
  (`startOverJob`); `app/api/generate-ai-code-stream/route.ts:1157-1277` (the stream loop has no
  cancellation input), `:1925-1932` (`recordJobUsage` runs regardless); `lib/ai/queue.ts:86-91`
- What happens: `cancelJob` writes `status: 'CANCELLED'`, resolves the phase, releases the lock. Nothing
  aborts the in-flight `streamText`: the only `AbortController` in the route is the 30-second _start_
  timeout (`lib/ai/run.ts:68-70`), cleared in `finally` at `:99` once the stream handle exists — the
  collection phase has no signal at all (documented at `run.ts:108-109`). The stream loop
  (`route.ts:1157`) checks only `clientDisconnected`, and deliberately does not break on it
  (`:1158-1164`). So the detached worker runs to completion, `recordJobUsage` still charges the spend
  (`:1925`), and only then does `settleStreamedGeneration` notice the job is terminal
  (`settle-generation.ts:151-157`) and discard the result. On the client side there is no abort either:
  `abortController.abort()` is reached only from `clearGeneration`
  (`lib/generation/generation-runtime.ts:477-478`), which no user action calls.
- Trigger: Start a build, click **Start over** in the recovery panel while it streams.
- Impact: The user is told the build was stopped; it was not. Full token cost and full latency are
  incurred, the workspace spend ceiling is charged, and the produced site is thrown away. There is also a
  narrow window where cancel lands _after_ `settle-generation.ts:151` and the write at `:256-262`
  proceeds — a cancelled build that still overwrites `lastCode`.
- Confidence: Confirmed
- Suggested fix: Give the run a cancellation channel the loop can observe — an `AbortController` held per
  job id, aborted by `cancelJob`, passed as `abortSignal` to `streamText` and checked in the collect loop —
  and re-check the job status immediately before the `lastCode` write. Until then, the copy must not say
  the build was stopped.

### F-023 [HIGH] A prose reply containing any plain code fence writes junk files into the project

- Area: B
- Location: `lib/generation/parse-blocks.ts:167-172` (undeclared path → `file.<ext>`), `:282-291`
  (`filesFromReply` keeps it); `app/api/generate-ai-code-stream/route.ts:1375-1379`;
  `lib/generation/parse-files.ts:62-81` (`sanitizeGenerationPath('file.tsx')` → ok);
  `lib/jobs/settle-generation.ts:242-265`
- What happens: `resolveBlockPath` falls back to `path: 'file.' + extensionForLanguage(language)` with
  `declaredPath: false` when a fence carries no `{path=…}`. `filesFromReply` maps every block including
  those, the route's sanitiser accepts `file.tsx`, and `settleStreamedGeneration` merges it into
  `lastCode`. The rest of the codebase knows undeclared blocks are not files —
  `detectTruncatedFiles` skips them explicitly (`truncation-recovery.ts:83`, "A snippet the model never
  named cannot be re-asked for by path") — but the map builder does not.
- Trigger: Ask a question on a finished project and have the model answer with an illustrative
  ` ```js ` snippet. Or any reply that opens one bare fence.
- Impact: `classifyReplyOutcome` sees `fileCount > 0` → `'files'` (`no-changes.ts:56`), so the run reports
  success, and a file named `file.js` / `file.tsx` / `file.txt` is permanently added to the user's project
  — visible in the Code tab, included in the ZIP export and in the GitHub deploy push. Repeat questions
  accumulate `file-2.js`, `file-3.js` via `dedupePath` (`parse-blocks.ts:189-205`). The correct outcome
  for that reply was `'answer'`, which changes nothing.
- Confidence: Confirmed
- Suggested fix: `filesFromReply` should include only `declaredPath: true` blocks, the way
  `detectTruncatedFiles` and `replaceBlockInReply` (`parse-blocks.ts:274`) already do. Keep the fallback
  name for display-only readers if any need it.

### F-024 [HIGH] `tagBuffer` grows to the full model reply, making the stream loop O(n²)

- Area: B
- Location: `app/api/generate-ai-code-stream/route.ts:1178,1223-1244`
- What happens: `searchText = tagBuffer + text`, then the intended trim is
  `tagBuffer = searchText.substring(Math.max(0, lastIndex - 50))`. `lastIndex` is initialised to `0` at
  `:1223` and only advances inside the `isEdit` package-tag loop when a `<package>` match is found
  (`:1239`). In every other case — all initial builds, and every edit whose reply has no `<package>` tag,
  which is the normal case — `lastIndex` stays `0`, so `substring(0)` returns the whole string and
  `tagBuffer` becomes a second full copy of `generatedCode`, growing by every chunk. For `isEdit`, the
  `packageRegex.exec` loop at `:1228` then re-scans that ever-growing buffer on **every chunk**.
  Contrast `StreamedFileTracker`, which bounds its own carry-over at `LOOKBEHIND = 512`
  (`lib/generation/stream-file-tracker.ts:12,64,89-91`).
- Trigger: Any build. Severity scales with reply size, and `maxOutputTokensForEntry` is 128,000
  (`lib/ai/providers.ts:135`) — roughly 500 KB.
- Impact: Two full copies of the reply held per in-flight generation instead of one, plus quadratic regex
  work on edits, all on the Node event loop that is also driving every other request's SSE writes. With
  `AI_PROVIDER_CONCURRENCY` above 1 this is the most likely source of stalled streams on a busy instance.
- Confidence: Confirmed
- Suggested fix: Keep a fixed-size tail unconditionally (`tagBuffer = searchText.slice(-LOOKBEHIND)`),
  independent of whether a package matched. The `<package>` scan should also run over the tail plus the new
  chunk, not over the accumulation.

### F-025 [HIGH] Every failed edit tells the user to "open the project preview so its workspace starts", which no longer exists

- Area: B
- Location: `app/api/generate-ai-code-stream/route.ts:1865-1872`; `lib/generation/no-changes.ts:12-17`
- What happens: `describeNoChanges` is called with
  `hasProjectFiles: Object.keys(global.sandboxState?.fileCache?.files || {}).length > 0` and
  `hasManifest: Boolean(global.sandboxState?.fileCache?.manifest)`. `global.sandboxState` has no writer
  (see reading note 1), so both are permanently `false`, and the first branch always wins:
  _"No changes were made. I could not load this project's current files, so there was nothing to edit.
  Open the project preview so its workspace starts and its files load, then send this request again."_
- Trigger: Any follow-up edit that returns no files after the corrective ask.
- Impact: The message is false on both counts. The route did load the files — from
  `prisma.project.findFirst` at `:936-940`, and it logs the count at `:941-945` — and there is no
  "workspace" to start: the sandbox VM was removed and the preview compiles in the browser. The user is
  sent to do something that cannot help, so the real cause (the model returned prose twice) is never
  surfaced. The `FOLLOW_UP_NO_FILES` message written for exactly this case (`no-changes.ts:3-4`) is
  unreachable.
- Confidence: Confirmed
- Suggested fix: Feed `describeNoChanges` from the values the route actually has —
  `Object.keys(backendFiles).length > 0` for `hasProjectFiles`, and drop `hasManifest` along with its
  branch, since nothing produces a manifest any more.

### F-026 [HIGH] The whole agentic edit-search workflow is dead code, and with it the conversation-edit record

- Area: B
- Location: `app/api/generate-ai-code-stream/route.ts:581-746`, `:2118-2146`, `:965-967`, `:770`
- What happens: `const manifest = global.sandboxState?.fileCache?.manifest` (`:591`) is always
  `undefined`, so the `if (manifest)` block at `:593-720` — the search plan, `analyzeEditIntent`,
  `executeSearchPlan`, `selectTargetFile`, the surgical edit context — never runs. Control always takes
  the `else` at `:721-735`, which also needs `manifest` for its fallback, so `editContext` stays `null`
  for every edit. Consequences that are not obvious from that block:
  `if (isEdit && editContext)` at `:2118` is never true, so **`conversation.context.edits` is never
  written**; therefore `recentPaths` at `:965-967` is always empty and `selectFileContext` never receives
  `recentlyModifiedPaths` or `primaryPaths`; the "Recent Edits" section of the conversation context
  (`:768-772`) never appears; and `buildVolatilePromptSuffix`'s `Files to edit:` line
  (`lib/stack-prompts/shared.ts:37-39`) is never populated.
- Trigger: Any edit.
- Impact: ~140 lines of unreachable code in the hottest file in the product, and — the part that costs
  the user — the file-context selector runs with none of the hints it was designed around, so a targeted
  edit gets a generically ranked slice of the project. `lib/generation/analyze-edit-intent.ts` (196 lines)
  has no other production caller, and neither do `lib/file-search-executor`'s `executeSearchPlan` /
  `selectTargetFile` as used here.
- Confidence: Confirmed
- Suggested fix: Decide the direction and commit to it. Either build the manifest from `backendFiles`
  (which the route already has) so the search workflow runs, or delete the block and write
  `conversation.context.edits` from the parsed result so the recency hints survive. Leaving it as a
  permanently-false branch keeps the selector degraded and the file long.

### F-027 [HIGH] Token and cost accounting misses the corrective ask and every recovery call, and records zero on failure

- Area: B
- Location: `app/api/generate-ai-code-stream/route.ts:1145,1829-1844,1925-1932`;
  `lib/generation/truncation-recovery.ts:42-52`
- What happens: `result` is assigned once, to the main stream (`:1145`). Usage is read from
  `await result?.usage` (`:1830`) — so the corrective ask (`:1546-1561`, a full second generation with
  the whole message list plus 2,000 characters of echo) and each truncation-recovery call
  (`:1702-1724`, one per truncated file) are **not counted**. `collectRecoveredStreamText` drains the
  recovery stream and never touches usage or `capTracker`. Separately, when the main stream throws, the
  `try` at `:1829` catches, `inputTokens` stays `0` and `outputTokens` stays `undefined`, and
  `recordJobUsage` is called with those (`:1925-1932`) → `estimateTokenCostUsd` returns 0 →
  `accrueSpend` is skipped entirely (`lib/consumption/record.ts:27`).
- Trigger: Any reply that parses to zero files but claims a change (one extra call); any reply with a
  truncated file (one extra call per file); any provider failure after input tokens were billed.
- Impact: The paths that cost the _most_ are the ones that report the _least_. `Job.tokensIn/tokensOut`,
  `/admin/usage`, and `Workspace.spendUsd` — which drives the auto-pause spend ceiling — all under-report,
  systematically and in the same direction. Combined with F-029 the spend ceiling is not a control.
- Confidence: Confirmed
- Suggested fix: Accumulate usage across every model call in the run (main, corrective, each recovery) and
  record the sum. Feed recovery output through `capTracker` too (F-042). On a provider failure, still
  record the input tokens that were billed — `resolveInputTokens` already has an estimator for exactly
  that case.

### F-028 [HIGH] The persist path has no per-file size limit, no total limit and no binary check; the guards that exist are dead

- Area: B
- Location: `lib/generation/parse-files.ts:30-31,35-44,96-134` (unused in production);
  `lib/generation/write-guard.ts:11-33` (no production caller);
  `app/api/generate-ai-code-stream/route.ts:1375-1379`; `lib/jobs/settle-generation.ts:30-42`
- What happens: `parseGenerationFiles` enforces `MAX_FILE_BYTES` (2 MB), `MAX_TOTAL_BYTES` (8 MB),
  duplicate-path rejection and `isBinary` (NUL bytes / >30% control characters). `grep` shows its only
  callers are `tests/unit/parse-files.test.ts`. `assertWritableGenerationFile` — whose own docstring says
  "Last gate before a sandbox write" and which is the only thing that validates a generated
  `package.json` parses as JSON — has only `tests/unit/generation-write-guard.test.ts`. The live path is
  `filesFromReply` + `sanitizeGenerationPath`, which checks the _path_ only. The one remaining bound is
  `JobCapTracker`: `maxOutputBytesPerJob` (default 2 MB, `caps.ts:107`) across the whole job, and
  `maxFilesPerJob` — nothing per file.
- Trigger: A model that emits one enormous file, a duplicated path, or a file with NUL bytes. Or any
  reply containing a syntactically broken `package.json`.
- Impact: A single 2 MB file is stored in `Project.lastCode` and re-read on every generation, every Code
  tab load and every export. An invalid `package.json` is persisted and shipped to the deploy repo, where
  it fails the build — precisely the incident `tests/unit/generation-write-guard.test.ts` was written
  from. Two real safety guards exist, are tested, and protect nothing.
- Confidence: Confirmed
- Suggested fix: Run every parsed file through `assertWritableGenerationFile` (or a shared checker that
  also carries the size and binary tests) in `safeGeneratedFiles`, so the settle path and the route's own
  list agree and the guards are actually on the path. Report rejections the way the stream tracker's are
  reported (`route.ts:1286-1297`).

### F-029 [HIGH] The cost table has no DeepSeek rate, so every estimate — and the spend ceiling — runs on a fabricated number

- Area: B, C
- Location: `lib/consumption/cost.ts:19-35`, `:41-46`; `lib/consumption/record.ts:14-38`
- What happens: `PER_MILLION` lists `groq`, `openai`, `anthropic`, `google` and `default` — every one of
  which was removed from the product (`lib/ai/providers.ts:1-10`: "DeepSeek is the only AI provider").
  `ratesFor('deepseek', 'deepseek-v4-flash')` matches none of the `key.includes(...)` branches and falls
  to `PER_MILLION.default` = `{ input: 0.15, output: 0.6 }`, i.e. an OpenAI mini-model rate. That number
  becomes `Job.estimatedCostUsd` and is passed to `accrueSpend`, which drives `Workspace.spendUsd` and the
  documented auto-pause at 100 % of `monthlySpendLimitUsd`.
- Trigger: Every generation.
- Impact: `/admin/jobs` and `/admin/usage` show costs for a provider whose price is not in the table, and
  the workspace spend ceiling pauses (or fails to pause) on a rate that has no relationship to the invoice.
  `record.ts:28-29` states the stakes: "a silent miss means the workspace keeps spending past its limit".
  `lib/consumption/plan-caps.ts:9-21` refuses to default the token cap for exactly this reason; the rate
  table defaults silently.
- Confidence: Confirmed
- Suggested fix: Add an explicit `deepseek` entry with the real published input/output rates (and,
  ideally, the cache-hit input rate, since the prompt is built around prefix caching). Remove the four
  dead vendors. Consider making an unmatched provider loud rather than silently priced.

### F-030 [MEDIUM] Stream collection has no timeout at any hop

- Area: B
- Location: `lib/ai/run.ts:59,68-72,99,107-112`; `app/api/generate-ai-code-stream/route.ts:111`
  (`dynamic` only, no `maxDuration`) vs `app/api/projects/[id]/import/route.ts:30` (`maxDuration = 300`)
- What happens: `PROVIDER_ATTEMPT_TIMEOUT_MS` (30 s) bounds only `start` — the `streamText` call that
  returns a lazy handle. `withTimeout` races that, and both the racing timer and the `AbortController` are
  cleared in `finally` at `:99` as soon as the handle exists. `collect` (the `for await` over
  `textStream`) is untimed, by design (`:107-109`). The generation route sets no `maxDuration`, while the
  import route sets 300 s.
- Trigger: A provider that accepts the request and then stalls mid-stream.
- Impact: The only bound is the 20-minute job reaper, and only if the heartbeat also stops — which it does
  not, because the heartbeat is a `setInterval` unaffected by a stalled `await` (`lifecycle.ts:341-365`).
  So the request handler, the provider queue slot and the project lock are held for up to 20 minutes on a
  dead stream. The timeouts across the hops are inconsistent: 30 s start, unbounded collect, 20 min job,
  10 min queue wait, 300 s import.
- Confidence: Confirmed
- Suggested fix: Bound total collection (a rolling idle timeout on chunks is better than a wall clock:
  a legitimate build can stream for minutes but should never go quiet for one), and reconcile the numbers
  so `maxDuration`, the collect bound and `JOB_TIMEOUT_MS` are derived from one place. Note that on the
  queue-timeout path `providerSlot.release()` must **not** be called — `release` decrements
  unconditionally (`queue.ts:89`) and the waiter never took a slot — which is correct today but only by
  omission; make it explicit.

### F-031 [MEDIUM] One tripped circuit blocks the only provider behind a message that explains nothing

- Area: B
- Location: `lib/ai/circuit.ts:3-5,39-46,50`; `lib/ai/run.ts:61,66,103-104`
- What happens: The breaker is a module-level singleton keyed on provider name, tripping after
  `TRIP_COUNT = 5` failures inside `FAILURE_WINDOW_MS` (2 min) and opening for `OPEN_MS` (5 min). With a
  single-element chain, `if (!circuit.isHealthy(entry.provider)) continue` (`run.ts:66`) skips the only
  entry, the loop ends with `tried === 0`, and the throw carries `lastError`'s initial value:
  `new Error('No healthy provider is configured')` (`run.ts:61`). `classifyProviderFailure` finds no
  status and no matching message, so it returns `'unavailable'` → `jobErrorCodeForProviderFailure` →
  `'provider_error'` → the recovery panel shows "The AI service did not respond"
  (`lib/jobs/copy.ts:55`).
- Trigger: Five provider failures in two minutes — a brief DeepSeek outage, a rate-limit burst, or five
  empty completions (which `shouldFailover` also counts, `failover.ts:120`).
- Impact: Every generation in the installation fails for five minutes, with a message that says the
  provider did not respond when in fact the app declined to call it, and no indication that it will clear
  on its own. "No healthy provider is configured" also reads as a configuration error to an operator whose
  configuration is fine.
- Confidence: Confirmed
- Suggested fix: Distinguish "breaker open" from "no provider": a dedicated error carrying the remaining
  open time, its own job error code, and copy that says the AI is being rested after repeated failures and
  when to retry. With one provider, consider a half-open probe rather than a flat 5-minute block.

### F-032 [MEDIUM] The route passes `request.signal` to the heartbeat believing it stops it; it does not

- Area: B
- Location: `app/api/generate-ai-code-stream/route.ts:377-382` vs `lib/jobs/lifecycle.ts:314-328,375-389`
- What happens: The route's comment reads "Tie it to the request so a client that disconnects stops
  vouching for work nobody is reading: the row goes stale within a minute instead of sitting RUNNING until
  the 20-minute hard timeout." `beginJobHeartbeat`'s `onAbort` (`lifecycle.ts:375-384`) deliberately does
  the opposite: it logs `jobs.heartbeat_client_gone` and **keeps beating**, with its own comment
  explaining why (the work continues server-side). The `JobHeartbeatOptions.signal` doc at
  `:316-327` still describes the old behaviour too.
- Trigger: Reload the tab mid-build.
- Impact: No runtime harm — keeping the heartbeat is the right call now that the run finishes and persists
  regardless. The harm is that two comments on a load-bearing mechanism describe behaviour the code does
  not have, in a file where an agent's next change will be guided by them. It also means the staleness
  reaper is not a backstop for a wedged handler; only the 20-minute timeout is (F-030).
- Confidence: Confirmed
- Suggested fix: Correct the route comment to say the signal only records the disconnect, and correct
  `JobHeartbeatOptions.signal`'s doc. If the signal now only produces a log line, consider whether the
  parameter should exist at all.

### F-033 [MEDIUM] Try again on a job with no stored prompt creates an orphan QUEUED job and silently does nothing

- Area: B
- Location: `lib/jobs/recovery-retry.ts:57,78-81`; `lib/jobs/recovery.ts:127-160`;
  `app/api/generate-ai-code-stream/route.ts:305`
- What happens: For BUILD/FOLLOWUP, `recoveryRetryIntent` returns
  `{ action: 'build', prompt: input.inputPrompt || '' }` — no guard for an empty prompt, unlike the PLAN
  and IMPORT branches directly above (`:47-56`, `:37-46`), which both return `action: 'none'` with a
  sentence. `dispatchRecoveryRetry` then calls `createRetryJob()` first and only starts the build
  `if (result.prompt)` (`:78-81`). Server-side, `retryAbandonedJob` computes
  `prompt = resume ? buildResumePrompt(…) : job.inputPrompt || planContext || ''` (`recovery.ts:133`) —
  `planContext` is only fetched for `kind === 'BUILD'` (`:126`) — and returns `ok: true` with that empty
  string. `inputPrompt` is null whenever the original request sent a non-string prompt
  (`route.ts:305`), and for FOLLOWUP there is no plan context to fall back on.
- Trigger: A FOLLOWUP job whose `inputPrompt` is null; click **Try again**.
- Impact: A new QUEUED `Job` row is created that nothing will ever start. It occupies
  `one_active_job_per_project`, so the project is blocked from new work, and the phase is set to BUILDING
  by `applyPhaseForStart` (`lifecycle.ts:80-84`) — chat input locked — until the 11-minute queued-stale
  reaper abandons it. The button appeared to do nothing.
- Confidence: Confirmed
- Suggested fix: Return `action: 'none'` with an explanatory `nextStep` when the prompt is empty, matching
  the PLAN branch. Belt and braces: have `retryAbandonedJob` refuse rather than create a job it cannot
  start.

### F-034 [MEDIUM] The progress batcher rewrites every partial file's full content every two seconds

- Area: B
- Location: `lib/jobs/progress.ts:12-23,25-39`
- What happens: `flush` reads the job (`getJob`, which selects `partialFiles`), merges the local map over
  the stored one, and writes the **entire** array back as jsonb (`updateJobFields`, which then does
  another `getJob` at `store.ts:261`). The local `files` map is never cleared, so each flush re-sends every
  file it has ever seen plus everything already in the row. Scheduled every `PROGRESS_BATCH_MS` = 2,000 ms
  (`poll.ts:12`) for the whole build.
- Trigger: Any build. Cost scales with `maxFilesPerJob` (default 60) × average file size.
- Impact: On a 40-file build averaging 20 KB, each flush reads ~800 KB of jsonb and writes ~800 KB, twice
  per second — and does it three times per flush counting the two `getJob` round trips. Over a
  five-minute build that is on the order of hundreds of megabytes of pointless jsonb churn on the same
  Postgres the heartbeat, the presence table and every other request share. `setStep` alone also never
  persists, because `flush` returns early on `files.size === 0` (`:13`), so `lastStep` — which the
  recovery copy and `/admin/jobs` read — is only ever written alongside a file.
- Confidence: Confirmed
- Suggested fix: Write only the delta since the last flush (a `jsonb_set`-style merge, or an append-only
  child table), clear the local map after a successful write, and let `setStep` persist on its own.

### F-035 [MEDIUM] A generation with no `projectId` bypasses the provider queue, the caps bookkeeping and all metering

- Area: B
- Location: `app/api/generate-ai-code-stream/route.ts:279-282,299-309,344-345,380-383,1922-1932`
- What happens: `lockProjectId` is `''` when neither `projectId` nor `context.projectId` is present, so
  `generationJob` is `null` (`:299`). Everything gated on the job then skips: the provider-queue
  `acquire` (`:344`, guarded on `generationJob?.status === 'QUEUED'`), the heartbeat (`:380`), the
  progress batcher (`:383`), and — at `:1922` — `recordJobUsage`, `settleStreamedGeneration` and
  `succeedJob`. `checkCredits` runs (`:276`) but `consumeCredits` does not, because that happens inside
  `markJobRunning`.
- Trigger: `POST /api/generate-ai-code-stream` with `{"prompt":"…"}` and no project id.
- Impact: Unlimited concurrent generations that consume no credit, occupy no queue slot, and accrue no
  spend. `AI_PROVIDER_CONCURRENCY` and the workspace spend ceiling are both bypassed by omitting one
  field.
- Confidence: Confirmed
- Suggested fix: Require a project id (the product has no other entry point), or take a queue slot and
  record usage on a workspace-scoped basis when there is no project.

### F-036 [MEDIUM] A client-side network drop writes `generationStatus='error'` over a build that is still running

- Area: B
- Location: `lib/generation/generation-runtime.ts:564-573,841-849,891-900,450-475`
- What happens: If the SSE body ends without a `complete` frame, `runGenerateStream` throws
  (`:841-849`). `executeGenerationJob` catches and calls `markGenerationError` (`:570`), which calls
  `setJobStatus('error', message)` → `persistProgress({ status: 'error', … })` → `PATCH /api/projects/<id>`.
  Meanwhile the server's detached worker is still streaming and will still persist the site and settle the
  job (`route.ts:1488-1493` documents that this is deliberate).
- Trigger: Lose connectivity, sleep the laptop, or have a proxy cut an idle SSE connection mid-build.
- Impact: The project row says `error` while the job row says RUNNING and the build is fine. `useProjectPlan`
  and `useGenerationJob` then disagree about what happened; chat shows an error for a build that
  succeeds a minute later.
- Confidence: Confirmed
- Suggested fix: A transport failure is not a generation failure. On a stream that ends without a
  terminal frame, keep polling the job (which is already the recovery mechanism) and do not PATCH a status
  the client cannot know. Only a server-sent `error` frame should mark the run failed.

### F-037 [MEDIUM] A stream that ends without a `complete` frame reports "Failed to generate recreation"

- Area: B
- Location: `lib/generation/generation-runtime.ts:841-849`
- What happens: After the read loop, `if (!generatedCode) { setJobStatus('error', 'Failed to generate
recreation'); … throw new Error('Failed to generate recreation'); }`. That is the only message for
  every stream that ended early: server restart mid-build, deploy, proxy cut, or the tool-validation
  branch (F-038) which sends a `warning` and no `complete`.
- Trigger: Redeploy while a build is streaming.
- Impact: "recreation" is URL-clone vocabulary and means nothing to someone who typed a prompt. The real
  cause is knowable — the job row will carry `deploying` or `server_restarted` with curated copy in
  `lib/jobs/copy.ts:53,56` — and is discarded in favour of this string.
- Confidence: Confirmed
- Suggested fix: On an early end, poll the job once and surface its `errorCode` / `errorMessage`; fall
  back to a neutral "the connection to the build dropped — checking whether it finished".

### F-038 [MEDIUM] A tool-validation failure sends no `error` frame, so the client never learns the run stopped

- Area: B
- Location: `app/api/generate-ai-code-stream/route.ts:2154,2165-2179,2182-2192`
- What happens: `isToolValidationError` is decided by `errorMessage.includes('tool call validation
failed')`. In that branch the route sends only a `warning` frame ("Package installation tool
  encountered an issue. Packages will be detected from imports instead.") and skips the `error` frame at
  `:2175-2178`. The job is failed correctly with `tool_call_validation_failed` — but the SSE stream then
  closes with no `complete` and no `error`.
- Trigger: A provider reply that fails AI-SDK tool-call validation.
- Impact: The client's read loop ends, `generatedCode` is empty, and the user gets F-037's
  "Failed to generate recreation" preceded by a warning about package installation — a subsystem that no
  longer exists (F-090). The curated copy for this code ("The AI replied in a form we could not use — try
  again", `lib/jobs/copy.ts:66`) never reaches chat. The string match is also fragile: any change in the
  SDK's wording silently reroutes this to the normal error path.
- Confidence: Confirmed
- Suggested fix: Send the `error` frame in this branch too (the job is failed either way), and drop the
  package-installation sentence. Classify on an error type rather than a substring.

### F-039 [MEDIUM] The entire model output is written to stdout, chunk by chunk, on every generation

- Area: B
- Location: `app/api/generate-ai-code-stream/route.ts:1181` (`process.stdout.write(text)`);
  see also `lib/generation/analyze-edit-intent.ts:90` (`console.log('… Prompt:', prompt)`)
- What happens: Unconditional, ungated by environment or log level. Up to `maxOutputTokensForEntry` =
  128,000 tokens (~500 KB) per build, interleaved with structured logs. `analyze-edit-intent.ts:90`
  similarly logs the full user prompt.
- Trigger: Every generation.
- Impact: Container logs are dominated by generated source; log shipping and retention costs scale with
  build volume; structured log lines become hard to find. The generated code and the prompt are user
  content, which now sits in a second store with a different retention policy than the database. Writing
  synchronously to stdout on every chunk also adds a syscall per chunk to the stream loop.
- Confidence: Confirmed
- Suggested fix: Remove it, or gate it behind an explicit debug flag. The run already gets a bounded
  shape report via `summarizeGenerationOutput` (`route.ts:1418-1427`), which is the right level of detail.

### F-040 [MEDIUM] The client rescans the whole accumulated reply on every chunk

- Area: B
- Location: `lib/generation/generation-runtime.ts:280-343` (`applyStreamedCode`), `:745-746`
- What happens: Each `stream` frame calls `applyStreamedCode(prev, data.text)`, which builds
  `newStreamedCode = prev.streamedCode + text` and then runs `scanStreamedFences(newStreamedCode)` over
  the whole buffer (`:301`). `completedPaths.has(fence.path)` at `:308` skips _rebuilding_ finished
  entries but not the scan itself, which walks every byte and does an `indexOf` per fence every time.
- Trigger: Any build; cost grows quadratically with reply length.
- Impact: On a large build the browser tab spends progressively more of each frame re-parsing, on the main
  thread, while React re-renders `StreamingCodePanel` and `SyntaxHighlighter` from the result. This is the
  likely cause of a streaming view that gets visibly less responsive as a build proceeds.
- Confidence: Confirmed
- Suggested fix: Keep a scan cursor: only closed fences are immutable, so parse forward from the last
  closed fence's end instead of from zero. The panel already renders only the tail
  (`StreamingCodePanel.tsx:269`), so nothing needs the full re-scan.

### F-041 [MEDIUM] Truncation recovery sends a temperature to the model the route says rejects one

- Area: B
- Location: `app/index` — `app/api/generate-ai-code-stream/route.ts:1114-1117` vs `:1713-1715`
- What happens: The main call guards it: `// DeepSeek's thinking-mode model rejects a temperature.
if (!actualModel.includes('-pro')) streamOptions.temperature = 0.7;`. The recovery call sets
  `temperature: recoveryEntry.model.startsWith('gpt-5') ? undefined : appConfig.ai.defaultTemperature`
  — a dead OpenAI check that can never be true for a DeepSeek id, so `deepseek-v4-pro` receives a
  temperature.
- Trigger: Configure `ai.primaryModel` = `deepseek-v4-pro`, then have a build produce a truncated file.
- Impact: If the stated constraint is real, every recovery call on the Pro model is rejected by the
  provider. `collectRecoveredStreamText` correctly throws the captured error, so the run then reports the
  truncated files as kept and names a provider failure (`truncationRecoveryOutcome`) — i.e. truncation
  recovery is entirely non-functional on the stronger model, and the user is told it was the vendor's
  fault. The `-pro` check is also stringly-typed in one place and absent in the other, which is how the
  two drifted.
- Confidence: Likely — the "-pro rejects a temperature" claim is the route's own comment and I did not
  call the provider to confirm it. The inconsistency between the two call sites is Confirmed.
- Suggested fix: One helper that decides temperature from the entry, used by all three call sites (main,
  corrective, recovery). Delete the `gpt-5` branch.

### F-042 [MEDIUM] Truncation-recovery output bypasses the per-job caps

- Area: B
- Location: `app/api/generate-ai-code-stream/route.ts:1702-1728`;
  `lib/generation/truncation-recovery.ts:42-52`; contrast `route.ts:1168-1175` and `:1566-1570`
- What happens: The main loop feeds every chunk to `capTracker.addChunk` and the corrective ask does too
  (`:1566`). `collectRecoveredStreamText` just accumulates the text; nothing counts its bytes or tokens.
  The recovery loop runs once per truncated file, each bounded only by
  `Math.min(appConfig.ai.truncationRecoveryMaxTokens, planCaps.maxTokensPerJob)` (`:1718-1721`) — a
  per-call bound, not a per-job one.
- Trigger: A reply with several truncated files.
- Impact: A job can exceed `maxTokensPerJob` and `maxOutputBytesPerJob` by N recovery calls without the
  cap ever firing. Since `maxTokensPerJob` is described as "the real ceiling" on spend per build
  (`lib/ai/providers.ts:132`), the ceiling is not enforced on the path most likely to need it.
- Confidence: Confirmed
- Suggested fix: Pass the tracker into `collectRecoveredStreamText` (or count the returned text against
  it before use) and let a `JobCapError` abort the recovery loop the way it aborts the main one.

### F-043 [MEDIUM] The `complete` frame re-sends the entire reply that was just streamed

- Area: B
- Location: `app/api/generate-ai-code-stream/route.ts:2021-2028,2100-2113`;
  `lib/generation/generation-runtime.ts:765,777`
- What happens: Every chunk is already sent as a `stream` frame (`:1211-1215`), and the `complete` frame
  then carries `generatedCode` — the whole accumulated reply — a second time. The client stores it in
  `lastGeneratedCode` (`generation-runtime.ts:777`) and in `promptInput`
  (`GenerationWorkspace.tsx:1184`).
- Trigger: Every generation.
- Impact: Roughly doubles the bytes on the wire for the largest payload in the product, and holds two more
  copies of it in client state. It is not redundant _in principle_ — the fallback rail at
  `generation-runtime.ts:782-795` uses it when no `raw` frames arrived — but it is redundant in the normal
  case.
- Confidence: Confirmed
- Suggested fix: Send `generatedCode` on `complete` only when no `stream` frames were sent (the reused /
  no-raw case), and have the client reuse its own accumulated `streamedCode` otherwise.

### F-044 [MEDIUM] The site write and the content-version bump are two statements, and neither checks for a concurrent write

- Area: B
- Location: `lib/jobs/settle-generation.ts:197-200,254-263`
- What happens: `project.lastCode` is read at `:197`, merged at `:254-255`, written at `:256-262`, and
  `bumpContentVersion(job.projectId)` is a separate statement at `:263`. There is no transaction, and no
  compare-and-set on `contentVersion`. Between the read and the write sit an `await resolveImages(...)`
  (`:243-247`) — which calls out to an image provider and can take many seconds — and the whole
  `withoutRawImageTokens` pass.
- Trigger: A crash or a failed statement between `:262` and `:263` leaves new code with a stale
  `contentVersion`, so the stale-view banner never fires for other viewers. A concurrent writer
  (checkpoint restore, keep-partial, import persist) landing in that window is lost entirely.
- Impact: The project lock is what is supposed to serialise this, and it mostly does — but `acquireLock`
  is re-entrant for the same user by design (`lib/projects/lock.ts:52-68`), so two operations by one
  person are not serialised by it. Silent lost update on the column that _is_ the site.
- Confidence: Confirmed
- Suggested fix: One transaction for the merge, the write and the version bump, with the write conditional
  on the `contentVersion` read at the start. `bumpContentVersion` already exists as a single statement and
  can be folded in.

### F-045 [MEDIUM] Paths rejected only by the post-stream parse are dropped with no log and no notice

- Area: B
- Location: `app/api/generate-ai-code-stream/route.ts:1281-1297,1375-1379`
- What happens: The comment at `:1281-1285` claims "this is the one place the drop is announced", and it
  does announce `streamedFiles.rejectedPaths` — the paths the _live tracker_ refused
  (`stream-file-tracker.ts:72`). The post-stream parse at `:1375-1378` runs `sanitizeGenerationPath` over
  `filesFromReply(generatedCode)` and does a bare `continue`. The two sets are not the same: the tracker
  only sees blocks it recognised as opening a fence at the time, while `filesFromReply` applies
  `normalizeFenceOpeners` and `sanitizeAssistantOutput` first (`parse-blocks.ts:214-216`) and so recovers
  glued, split and unclosed fences the tracker missed. Any path unique to that recovered set is dropped in
  silence.
- Trigger: A reply whose bad-path fence was glued to prose, so `normalizeFenceOpeners` had to unglue it.
- Impact: The file the user asked for does not appear, and nothing anywhere says why — the exact class of
  silent drop that `DroppedGenerationPath` (`lib/generation/types.ts:79-88`) and
  `StreamingCodePanel.tsx:203-225` were built to eliminate. `settleStreamedGeneration` does log its own
  rejections (`:216-222`), so the gap is only in the route's list.
- Confidence: Confirmed
- Suggested fix: Collect rejections from the post-parse loop into the same list and emit one `warning`
  frame covering both, after the parse rather than before it.

### F-046 [MEDIUM] Publish compensation records `rolled_back` even when every teardown failed, and never retries

- Area: B
- Location: `lib/jobs/compensate.ts:106-148`; `lib/jobs/compensate-publish.ts:26,45-71`;
  `lib/jobs/copy.ts:29` (`PUBLISH_ROLLBACK_LINE`)
- What happens: `compensateJobResources` wraps each delete in `try { … } catch { logError(…) }`
  (`:116-142`) and pushes to `compensated` only on success. It then returns
  `{ rolledBack: true, compensated }` — `rolledBack` is derived from `shouldCompensatePublish`, i.e. "we
  decided to roll back", not "we did". `compensate-publish.ts:52` turns that into
  `compensation = 'rolled_back'`, writes it to `resourceIds`, and `:26` makes the whole function
  single-shot on that marker.
- Trigger: A first-time publish abandons while Coolify or Cloudflare is returning 5xx.
- Impact: The job records a completed rollback and the recovery panel shows "Incomplete work was cleaned
  up" while the Coolify app and the DNS record are still live and still billed. The compensation will
  never run again for that job. The daily orphan cron is the real backstop and it does work — the ids are
  only nulled from `resourceIds` when the delete succeeded (`:59-60`), so `loadOrphanProvenance` still
  recognises them (`orphans.ts:343-353`) and `classifyOrphan` deletes them after 24 h. So this is a
  24-hour window of false reporting rather than a permanent leak. It is nonetheless the pattern
  `.cursor/lessons-learned.md` records for 2026-08-18: "a message must not promise what the code cannot
  prove".
- Confidence: Confirmed
- Suggested fix: Return what actually happened — `rolled_back` only when every attempted delete
  succeeded, and a third state for a partial or failed rollback — and let that state be retried rather
  than latched. Copy should say "asked to remove" when the provider did not confirm.

### F-047 [MEDIUM] `withRecordedJob` labels every failure `provider_error`

- Area: B
- Location: `lib/jobs/wrap.ts:58-70`
- What happens: The catch writes `errorCode: 'provider_error'` for whatever threw, for every kind that
  goes through this wrapper — `EXPORT`, `DOMAIN_VERIFY`, `TEMPLATE_THUMBNAIL`, and the audit bookkeeping
  kinds.
- Trigger: A ZIP export that fails on object storage; a domain check that fails on Cloudflare.
- Impact: `/admin/jobs` groups by `errorCode` (`lib/jobs/admin.ts:13-18`), so storage and DNS failures are
  filed under the AI provider, and the curated line is "The AI service did not respond"
  (`lib/jobs/copy.ts:55`). An operator diagnosing a storage outage is pointed at DeepSeek. The recorded
  `errorMessage` is right, which is why `jobAdminFailureLine` (`admin-display.ts:9-11`) usually shows
  something sensible — the grouping and the cause line are what mislead.
- Confidence: Confirmed
- Suggested fix: Let the caller supply an error code, or classify from the thrown error the way the
  generation route does with `jobErrorCodeForProviderFailure`. `JobErrorCode` has no neutral
  "internal error" member — one is needed.

### F-048 [MEDIUM] The client promotes a failed build to `COMPLETE`, contradicting the site-evidence invariant

- Area: B
- Location: `components/workspace/useProjectPlan.ts:44-54`, `:64-68`
- What happens: On every poll, if the latest job is ABANDONED / FAILED / CANCELLED and the local phase is
  `BUILDING`, the hook does `setPhase('COMPLETE')` (`:52`). Line 67 does the same for
  `generationStatus === 'ready'`. Neither consults `lastCode` or checkpoints. The server is careful about
  exactly this: `resumablePhaseFromEvidence` (`lib/jobs/resumable-phase.ts:13-22`) returns `COMPLETE` only
  for `hasLastCode || checkpointCount > 0` and explicitly ignores `filesWritten`, and
  `.cursor/lessons-learned.md` (2026-08-18) records the incident that produced that rule.
- Trigger: First build on a new project fails with zero files.
- Impact: The workspace shows a project with no site as complete: the PLANNING gate and the plan card
  disappear, the preview claims there is something to show, and the next message is treated as an edit by
  `hasExistingSite` once the streamed-files fallback is in play. A refresh corrects it, because the server
  never agreed.
- Confidence: Confirmed
- Suggested fix: Do not derive phase on the client. `refresh()` already re-reads
  `GET /api/projects/<id>`, whose `phase` the server computed from evidence — use that value and delete
  both overrides.

### F-049 [MEDIUM] The import route is not wrapped in `withRequest`, so its job rows may carry no request id

- Area: B
- Location: `app/api/projects/[id]/import/route.ts:32-33,91`; contrast
  `app/api/generate-ai-code-stream/route.ts:235-237`, `app/api/projects/[id]/job/route.ts:12`,
  `app/api/projects/[id]/files/route.ts:15`
- What happens: Every other route in scope wraps its handler in `withRequest(request, …)`, which
  establishes the request-context store that `getRequestId()` reads. The import route's `POST` does not,
  yet calls `getRequestId()` at `:91` to stamp `Job.requestId`.
- Trigger: Start a URL import; inspect the job row.
- Impact: `requestId` is what the recovery panel shows the user to quote and what correlates a failure to
  its logs (`RecoveryPanel` receives `requestId` from `ProjectWorkspace.tsx:406`). If it is empty for
  imports, the one identifier that ties a user report to a log line is missing for that flow.
- Confidence: Needs check — the failure depends on whether `getRequestId()` falls back to a header when
  no store is active, which is in `lib/request-context` (outside this scope). The missing wrapper is
  Confirmed.
- Suggested fix: Wrap the handler in `withRequest` like every sibling route, whatever the fallback turns
  out to be, so the pattern is uniform.

### F-050 [MEDIUM] The chat filter silently drops any AI explanation that mentions `export default` or `className=`

- Area: B
- Location: `lib/generation/generation-runtime.ts:732-744`
- What happens: A `conversation` frame is appended to chat only if the text contains none of `<file`,
  `import React`, `export default`, `className=`. The intent (keep pasted source out of the transcript)
  is sound; the test is a substring match on the whole frame.
- Trigger: Ask "why did you use a default export here?" and have the model answer in prose that repeats
  the phrase. Or any explanation that names a Tailwind class attribute.
- Impact: The model's answer is discarded with no trace — no chat line, no log. On the `chatAnswer` path
  the `conversation` frame _is_ the reply (`route.ts:2014-2020` says so explicitly), so the user sees the
  build finish with nothing said. The route's own no-changes path depends on the same frame reaching chat
  (`:2050-2057`).
- Confidence: Confirmed
- Suggested fix: Strip fenced blocks from the frame and render the remaining prose, rather than
  suppressing the whole frame. `explanationFromReply` (`parse-blocks.ts:294-303`) already does exactly
  this and has no production caller.

### F-051 [MEDIUM] `global.conversationState` is still a single process-wide slot shared across projects

- Area: B
- Location: `app/api/generate-ai-code-stream/route.ts:475-491`;
  `lib/generation/conversation-state.ts:34-61`
- What happens: The per-project registry fixed the _run's_ view — `conversationStateFor(projectId,
userId)` is resolved once and held (`route.ts:438`), LRU-bounded at 20 (`conversation-state.ts:19`), and
  that part is correct. But the route still publishes to `global.conversationState` on every request
  (`:485-491`) for three readers named in its own comment: checkpoint labels
  (`lib/checkpoints/actions.ts`), memory extraction (`lib/memory/extract.ts`) and the follow-up prompt
  context (`lib/projects/plan.ts`). The published object is a shallow copy, and the comment admits "the
  arrays themselves are shared". Last writer wins.
- Trigger: Two projects generating concurrently in one process — routine with
  `AI_PROVIDER_CONCURRENCY` ≥ 2.
- Impact: A checkpoint saved for project A can be named from project B's prompt, and memory extraction can
  attribute B's message to A's workspace. Bounded to those three readers, and the per-project registry
  keeps the _prompt_ correct, which is why this is MEDIUM rather than HIGH.
- Confidence: Confirmed
- Suggested fix: Give the three readers the project id they are working on and have them call
  `conversationStateFor` directly. Then delete the global.

### F-052 [LOW] `filesToLastCode` interpolates the path into an attribute without escaping

- Area: B
- Location: `lib/jobs/types.ts:289-291`
- What happens: `` `<file path="${file.path}">\n${file.content}\n</file>` ``. `sanitizeGenerationPath`
  rejects traversal, absolute and drive-letter paths but permits `"` inside a segment, and nothing checks
  whether `content` contains `</file>`.
- Trigger: A model-supplied path containing a double quote, or file content containing the literal
  `</file>` (a file that documents this very format).
- Impact: The stored `lastCode` becomes unparseable at that point, so `getCurrentProjectFiles` mis-splits
  and one or more files are lost or merged. Narrow, because reaching it needs an unusual path or content.
- Confidence: Confirmed
- Suggested fix: Reject `"` in `sanitizeGenerationPath` (no legitimate project path contains one), and
  either escape or refuse content containing the closing sentinel.

### F-053 [LOW] Two contradictory closing messages per generation, one built from a parser that matches nothing

- Area: B
- Location: `components/workspace/GenerationWorkspace.tsx:1161-1182` vs `:695-706`
- What happens: `sendChatMessage` extracts applied files with
  `/<file path="([^"]+)">([^]*?)<\/file>/g` (`:1161`) over the model's reply — which is fenced
  `{path=…}` output, not `<file>` XML (reading note 2, and `route.ts:1745-1747` states the same). So
  `generatedFiles` is always empty, `:1169` is never true, and the chat line is always the
  "new generation" variant with `appliedFiles: []`. `applyGeneratedCode` then adds a _second_ message
  built from `filesFromReply` (`:695`), which parses correctly.
- Trigger: Every generation.
- Impact: Two closing lines per turn, the first with no file list and the wrong wording for an edit. This
  is the "one fact, one sentence" rule in `.cursor/lessons-learned.md` (2026-08-18) drifting again.
- Confidence: Confirmed
- Suggested fix: Delete the `<file path=` regex block and let `applyPageCopy` own the closing sentence,
  which is what it exists for.

### F-054 [LOW] Retry-import feeds `<file>` XML to the fenced-block parser

- Area: B
- Location: `components/workspace/GenerationWorkspace.tsx:2244-2246` → `:695`
- What happens: `onRetryImport` calls `applyGeneratedCode(imported.filesXml, false)`, and
  `applyGeneratedCode` computes `appliedFiles = Object.keys(filesFromReply(code))`. `filesXml` is
  `<file path="…">` shape (`lib/import/persist.ts:62` parses it with `parseGeneratedFilesLenient`), which
  `filesFromReply` does not parse.
- Trigger: Retry a failed URL import from the recovery panel.
- Impact: Chat reports "Successfully applied 0 files" for an import that worked. The files themselves are
  fine — `persistImportedSite` stores them server-side (`import/route.ts:179`); only the client's count
  is wrong.
- Confidence: Confirmed
- Suggested fix: Have the import path report its own file count from the server response rather than
  re-parsing, or use the matching parser.

### F-055 [LOW] `run.ts` matches the served entry by provider name, not by entry

- Area: B
- Location: `lib/ai/run.ts:145-146,166,206`
- What happens: `chain.find((row) => row.provider === started.provider)` and
  `remaining.findIndex((row) => row.provider === started.provider)`. With more than one entry for the same
  provider — two DeepSeek models, which the chain shape explicitly allows
  (`lib/ai/providers.ts:6-7`) — this always resolves to the first, so `collect` is told the wrong entry
  and the index advance can loop on the same model.
- Trigger: Not reachable today: the chain is always length 1 (`providers.ts:88-95`).
- Impact: Latent. It becomes a real failover bug the moment a second entry is added, which is what the
  chain shape was preserved for.
- Confidence: Confirmed (as latent)
- Suggested fix: Carry the `ProviderEntry` (or its `id`) through `ProviderRunResult` and match on that.

### F-056 [LOW] A meaningless condition guards the streaming progress log

- Area: B
- Location: `app/api/generate-ai-code-stream/route.ts:1218`
- What happens: `if (generatedCode.length % 100 < text.length)` — comparing a modulus of the running
  total against the current chunk length. It fires unpredictably, roughly proportional to chunk size, and
  does not mean "every 100 characters" as the comment above it claims.
- Trigger: Every generation.
- Impact: Noise in a place that reads like an interval. Harmless beyond that.
- Confidence: Confirmed
- Suggested fix: Track a `nextLogAt` threshold, or drop the line — `summarizeGenerationOutput` already
  reports the final size.

### F-057 [LOW] `captureUrlScreenshot` reports a network error for any non-JSON response

- Area: B
- Location: `components/workspace/GenerationWorkspace.tsx:1582-1607`
- What happens: `await response.json()` runs without checking `response.ok`. A 500 that returns HTML
  throws `SyntaxError`, which lands in the catch at `:1604` and sets
  `'Network error while capturing screenshot'`.
- Trigger: A screenshot endpoint returning a non-JSON error page.
- Impact: The user is told the network failed when the server errored, so they retry instead of reporting
  it.
- Confidence: Confirmed
- Suggested fix: Check `response.ok` first and surface the status; keep the network message for a genuine
  fetch rejection.

### F-058 [LOW] `responseArea` accumulates every log line for the session and is never read

- Area: B
- Location: `components/workspace/GenerationWorkspace.tsx:107,537-539`
- What happens: `log()` appends to `responseArea` state on every call (including from
  `applyGeneratedCode`), and `responseArea` appears nowhere in the render.
- Trigger: Every generation and apply.
- Impact: An unbounded string array in client state for the life of the tab, plus a React re-render per
  append for something nothing displays. Small, but it grows for as long as the workspace is open.
- Confidence: Confirmed
- Suggested fix: Delete the state and the `log` helper, or route it to `console` only.

---

## C — Provider key resolution

### The chain, hop by hop

```
Admin → Configuration  ──►  AppSetting "setting:ai.deepseek.apiKey"   (AES-256-GCM, resolve.ts:237-245)
                                     │
Settings → API keys ───►  ApiKey / OrgApiKey rows                      (PLAINTEXT — F-070)
                                     │
                            getEffectiveApiKey(userId, 'deepseek')     (api-keys.ts:82-122)
                              personal ▸ org ▸ setting ▸ process.env
                                     │
                            loadEffectiveProviderEnv(userId, env)      (effective-env.ts:28-41)
                              overlays DEEPSEEK_API_KEY, DEEPSEEK_BASE_URL,
                                       AI_PROVIDER_CONCURRENCY, AI_PRIMARY_MODEL
                                     │
                            requireUsableProviderChain(env, {requestedModel})
                                     │
                            clientForEntry(entry, env)  ──►  createOpenAI({apiKey, baseURL})
```

Confirmed working as documented: registry keys `ai.deepseek.apiKey`, `ai.deepseek.baseUrl`,
`ai.primaryModel`, `ai.concurrency` all exist (`registry.ts:104-144`) and match the names
`effective-env.ts:4-11` maps, so no mis-mapped key silently resolves to null there. Precedence is
DB → env → registry fallback (`resolve.ts:106`). Secrets echo `last4` only (`resolve.ts:189-190`).
`ai.concurrency` does reach the runtime queue — `route.ts:340` calls
`getDefaultProviderQueue().setConcurrency(...)` per request, so the setting is live, not boot-frozen.

**Every hop where a missing or mis-mapped entry fails silently instead of erroring loudly** — the
central question for this section, enumerated:

| #   | Hop                             | Silent failure                                                                                                           | Finding |
| --- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------- |
| 1   | `decodeStoredSecret`            | `catch { return secret }` — returns raw ciphertext **as the API key**                                                    | F-071   |
| 2   | `readStored`                    | `catch { return null }` — undecryptable admin secret falls through to env                                                | F-076   |
| 3   | `getSetting`                    | `catch { stored = null }` — a DB outage silently downgrades to env, cached 30 s                                          | F-075   |
| 4   | `getSetting`                    | unknown key returns `null` rather than throwing (documented; no live mis-map today)                                      | —       |
| 5   | `getEffectiveApiKey` precedence | a legacy personal/org `deepseek` row outranks the admin setting, with no UI to see or remove it                          | F-072   |
| 6   | `getProviderForModel`           | resolves with `userId = null` while generation resolves with the session user → two credentials in one pipeline          | F-073   |
| 7   | `testAi`                        | probes `ai.deepseek.apiKey` only, not the effective key → green on a key generation does not use, and red on one it does | F-074   |
| 8   | `resolveModel`                  | any requested model string passes through unvalidated                                                                    | F-003   |
| 9   | `Project.model`                 | overrides `ai.primaryModel` for the life of the project                                                                  | F-004   |
| 10  | `getProviderForModel`           | an unknown model id is silently replaced by the configured one (documented, asymmetric with #8)                          | F-082   |
| 11  | `getEffectiveApiKey`            | reads `process.env` directly, ignoring the `env` its callers thread through                                              | F-078   |
| 12  | `plan-complete`                 | `opts.env ?? process.env` — a caller that forgets `env` silently reads the wrong store                                   | F-083   |
| 13  | `ratesFor`                      | no `deepseek` entry → silently priced as OpenAI                                                                          | F-029   |

Build-time vs runtime: handled correctly. Everything on this chain is runtime (`getSetting` reads Prisma
per request behind a 30 s cache; `clientFor` in `provider-manager.ts:49-60` is keyed on the resolved
credential so a rotated key retires the cached client). The one genuinely build-time value,
`NEXT_PUBLIC_APP_URL`, is listed read-only in `BOOTSTRAP_ENV_VARS` (`registry.ts:433-436`) with the right
explanation, and `app.url` has its own runtime resolver (`lib/settings/app-url.ts:19-22`).

### F-070 [HIGH] Personal and org API keys are stored in plaintext, while admin settings are encrypted

- Area: C
- Location: `lib/api-keys/actions.ts:81-90` (`secret: parsed.data.secret`), `:117-121`;
  `lib/api-keys.ts:65-72`; contrast `lib/settings/resolve.ts:236-245` (`encrypt(trimmed)`)
- What happens: `setPersonalApiKey` and `setOrgApiKey` write the secret straight into
  `ApiKey.secret` / `OrgApiKey.secret` with no `encrypt()` call. The reader,
  `decodeStoredSecret`, attempts `decrypt` and falls back to returning the value unchanged — which is what
  makes a plaintext round-trip work, and why the mismatch is invisible. The same repo encrypts
  `AppSetting` secrets and `Integration` secrets with AES-256-GCM and treats `ENCRYPTION_KEY` as a boot
  requirement (`registry.ts:420-422`; `docs` require ≥32 bytes).
- Trigger: Save any key under Settings → API keys (Firecrawl today; the columns also hold legacy
  `deepseek`, `openai`, `google` rows).
- Impact: A database dump, a read-replica, a backup restored to a less protected environment, or any SQL
  read exposes live provider credentials in the clear. `BackupRun` writes nightly dumps to object storage
  (`lib/backup/`), so plaintext keys are replicated off-server daily. `last4` is stored beside them, so
  the row already advertises which credential it is.
- Confidence: Confirmed
- Suggested fix: Encrypt on write with the same helper `resolve.ts` uses, and make the read path
  _distinguish_ "not encrypted" (legacy row, migrate it) from "cannot decrypt" (F-071) instead of
  conflating both into a silent pass-through. A one-off migration re-encrypts existing rows.

### F-071 [HIGH] A key that cannot be decrypted is returned as the API key, so a rotated `ENCRYPTION_KEY` surfaces as a provider 401

- Area: C
- Location: `lib/api-keys.ts:65-72`
- What happens: ```js
  async function decodeStoredSecret(secret) {
  try { const { decrypt } = await import('./crypto'); return decrypt(secret); }
  catch { return secret; }
  }
  ```
  Any failure — a rotated `ENCRYPTION_KEY` or `AUTH_SECRET`, a truncated column, a tampered row — returns
  the ciphertext. `getEffectiveApiKey:95-97` then trims it, finds it non-empty, and **returns it as the
  credential**, short-circuiting the admin setting and the environment below it.
  ```
- Trigger: Rotate `ENCRYPTION_KEY` (or `AUTH_SECRET`, from which the key is derived per
  `registry.ts:416-418`) with any `ApiKey`/`OrgApiKey` row present.
- Impact: Generation sends base64 ciphertext to DeepSeek as a bearer token. The provider answers 401,
  `classifyProviderFailure` returns `auth`, and the user is told "DeepSeek rejected the API key. Ask an
  administrator to check the DeepSeek key" (`failover.ts:152-158`). The administrator looks at
  `/admin/config`, sees the key set and green — because `testAi` reads a different source entirely
  (F-074) — and has no way to reach the diagnosis. This is the exact failure the 2026-08-18 lesson
  describes ("when a provider error says a _header_ or _credential shape_ is missing, suspect the stored
  value is empty before suspecting the SDK"), one step further along: the stored value is not empty, it is
  garbage. Note `resolve.ts:58-64` handles the same situation correctly for admin settings — it returns
  `null` and falls through — so the two stores disagree about what an undecryptable secret means.
- Confidence: Confirmed
- Suggested fix: Return `null` on a decrypt failure and log it with the provider and row id — never the
  value. Better: distinguish "stored plaintext" (accept, and flag for migration) from "decrypt failed"
  (refuse, and say so loudly), which is impossible today because plaintext storage relies on the same
  catch (F-070).

### F-072 [HIGH] A leftover personal or org DeepSeek key silently outranks Admin → Configuration, and no UI can remove it

- Area: C
- Location: `lib/api-keys.ts:9,23-29,82-122`; `lib/api-keys/schema.ts:4-9`;
  `lib/api-keys/actions.ts:38-44,126-135`
- What happens: `getEffectiveApiKey` resolves personal `ApiKey` → `OrgApiKey` → `ai.deepseek.apiKey` →
  `DEEPSEEK_API_KEY`, and `PROVIDER_ALIASES` still maps `deepseek` (`:24`). But
  `SETTINGS_API_KEY_PROVIDERS` is now `[{ id: 'firecrawl' }]` (`:9`), and both
  `listPersonalApiKeys`/`listOrgApiKeys` (`actions.ts:38,60`) and `settingsProviderSchema`
  (`schema.ts:4-9`) are derived from that list. So a `deepseek` row is invisible in the UI and
  `deleteApiKey` refuses to touch it (zod rejects the provider) — while still winning every resolution.
- Trigger: Any deployment that had per-user or org DeepSeek keys before the provider consolidation
  documented in `api-keys.ts:1-8`. Rows in `ApiKey`/`OrgApiKey` are not migrated or deleted by that
  change.
- Impact: The admin changes the key on `/admin/config`, the page confirms it, and generation keeps using
  the old one — indefinitely, with no way to clear it short of SQL. If the old key is revoked, every build
  fails as `auth` and points the operator at the page that is already correct. Combined with F-071 the
  precedence chain can also be poisoned by an _undecryptable_ row.
- Confidence: Confirmed
- Suggested fix: Either drop `deepseek` from `PROVIDER_ALIASES` so the personal/org tiers cannot serve it
  (the admin setting and env are then the only sources, matching the stated design), or surface and allow
  deletion of any provider row that exists, not just the ones currently offered. A migration deleting
  orphaned rows is the cleanest.

### F-073 [HIGH] The generation call and every AI helper resolve their credential for different users

- Area: C
- Location: `app/api/generate-ai-code-stream/route.ts:320` (`loadEffectiveProviderEnv(sessionUser.id, …)`)
  vs `lib/ai/provider-manager.ts:63` (`loadEffectiveProviderEnv(null, process.env)`);
  callers at `lib/generation/analyze-edit-intent.ts:79`, `lib/skills/match.ts:136`,
  `lib/memory/extract.ts:91`, `lib/audit/ai-review.ts:104`, `lib/import/generate-sections.ts:117`,
  `lib/import/segment.ts:94`
- What happens: The generation stream resolves with the signed-in user's id, so a personal `ApiKey` row
  applies. `getProviderForModel` — the single entry point for edit planning, skill matching, memory
  extraction, import sectioning and the audit AI review — hard-codes `null`, so it skips the personal tier
  and lands on the org row, the admin setting or env.
- Trigger: Any deployment with a personal `deepseek` `ApiKey` row (see F-072).
- Impact: One request uses two different credentials against two different quotas and two different
  billing accounts, and the two halves can disagree about whether a key exists at all: the build succeeds
  on the personal key while "Plan the edit" fails `provider_not_configured` because the admin setting is
  empty (or vice versa). `provider-manager.ts:17-30` documents this precise class of bug from the other
  direction and calls the overlay "the only correct source" — but then passes a different user to it than
  its sibling does. This is the 2026-08-18 lesson "Two halves of one pipeline reading different config
  stores" with the store now shared and the _subject_ diverged.
- Confidence: Confirmed
- Suggested fix: One resolution per request. Thread the acting user id into `getProviderForModel` (the
  route already has it and already builds `providerEnv`), or remove the personal tier for AI providers
  altogether — which is what `api-keys.ts:1-8` says the product decided — and resolve with `null`
  everywhere.

### F-074 [HIGH] The Test button on `/admin/config` probes a different credential than generation uses

- Area: C
- Location: `lib/settings/test-group.ts:130-151`; contrast `lib/api-keys.ts:82-122` and
  `lib/ai/effective-env.ts:28-41`
- What happens: `testAi` calls `getSettings(['ai.deepseek.apiKey', 'ai.deepseek.baseUrl'])` and probes
  with that. `getSetting` covers the DB row and `DEEPSEEK_API_KEY` from env (the registry entry names it,
  `registry.ts:109`), but it cannot see the two tiers above: personal `ApiKey` and `OrgApiKey`. Generation
  resolves through `getEffectiveApiKey`, which consults all four.
- Trigger: Any deployment with a personal or org `deepseek` row (F-072).
- Impact: Both directions are wrong and both are actively misleading. With a working org key and no admin
  setting, Test reports "No AI provider key is set. Generation cannot run until at least one is
  configured." while generation works fine. With a stale personal key overriding a fresh admin setting,
  Test probes the fresh key and goes green while every build fails 401. The docstring at `:120-129`
  records that this same function already shipped one permanent false negative for the same reason — five
  branches reading registry keys that had been deleted — so this is the second iteration of the same
  mistake: the diagnostic does not resolve the credential the way the product does.
- Confidence: Confirmed
- Suggested fix: Have `testAi` call `loadEffectiveProviderEnv(null, process.env)` and probe
  `DEEPSEEK_API_KEY` from that overlay — the same value `clientForEntry` will use — and report which tier
  it came from, so an unexpected source is visible rather than merely effective.

### F-075 [MEDIUM] `getSetting` treats every database error as "no row" and caches the downgrade for 30 seconds

- Area: C
- Location: `lib/settings/resolve.ts:93-108`
- What happens: The Prisma read is wrapped in `try { … } catch { stored = null }` with the rationale
  "Database unreachable — the environment fallback is what keeps a half-booted instance serving". Any
  error qualifies: a connection reset, a statement timeout, a permission change. The resolved value —
  which may now be a stale env value or the registry fallback — is then written into the 30-second cache
  at `:107`, so one transient failure pins the wrong value for 30 s across every caller.
- Trigger: A brief Postgres blip during a build.
- Impact: For most settings this is benign. For `ai.deepseek.apiKey` it means generation can silently
  switch to a _different credential_ mid-session — the old `DEEPSEEK_API_KEY` from env, or none at all,
  producing `provider_not_configured` on an installation that is correctly configured. Nothing anywhere
  records that the value served was a fallback rather than the configured one.
- Confidence: Confirmed
- Suggested fix: Keep the fallback (it is the right call for availability) but do not cache a value
  resolved from a failed read, and log the downgrade with the key name. For secrets specifically, consider
  serving the last known-good cached value rather than silently changing credential.

### F-076 [MEDIUM] An undecryptable admin secret silently reverts to the environment

- Area: C
- Location: `lib/settings/resolve.ts:55-65`, `:130-135`, `:174-193`
- What happens: `readStored` returns `null` when `decrypt` throws, with the comment "A rotated
  AUTH_SECRET/ENCRYPTION_KEY makes old ciphertext unreadable. Fall through to the environment rather than
  crashing the request." `getSetting:106` then resolves env or the registry fallback. This is the _right_
  failure direction (unlike F-071) but it is silent: nothing is logged, and `sourceFor` (`:130-135`) calls
  the same `readStored`, so `/admin/config` renders the field as "Set from environment" or unconfigured.
- Trigger: Rotate `ENCRYPTION_KEY` without re-saving the settings.
- Impact: Every admin-saved secret in the installation quietly stops being used at once — the DeepSeek
  key, the Resend key, the S3 credentials, `CRON_SECRET` — and the only symptom is downstream failures.
  The admin page is honest about the _source_, which is what keeps this out of HIGH, but it does not say
  "there is a stored value here that can no longer be read", which is the fact the operator needs.
- Confidence: Confirmed
- Suggested fix: Log the key name (never the value) on a decrypt failure, count them, and surface a
  distinct state on `/admin/config` — "a saved value exists but cannot be decrypted; re-enter it" — rather
  than presenting the row as absent. This is the same three-state lesson as `DataDirStatus.checked`
  (2026-08-18): "not readable" is not "not set".

### F-077 [MEDIUM] The provider-not-configured fallback names four providers that no longer exist

- Area: C
- Location: `app/api/generate-ai-code-stream/route.ts:323-334`
- What happens: When the thrown error is not a `ProviderNotConfiguredError`, the message is
  `'No AI provider is configured — set GEMINI_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, or GROQ_API_KEY
on the server.'` — every one of which was removed (`lib/ai/providers.ts:1-8`). That string is written to
  `Job.errorMessage` with `errorCode: 'provider_not_configured'`, which is in `RECORDED_CAUSE_CODES`
  (`lib/jobs/copy.ts:110-118`), so the recovery panel shows _this_ sentence in preference to the correct
  curated one.
- Trigger: `loadEffectiveProviderEnv` throws (a Prisma failure inside `getEffectiveApiKey`, say) rather
  than the chain being empty.
- Impact: The operator is told to set four environment variables that nothing reads, on a page that is not
  where the key lives. `copy.ts:102-108` already identifies this exact wording as "actively wrong" and
  routes around it for the normal case; the fallback still produces it. The same file's comment at
  `:102-104` also still cites Gemini as an example vendor.
- Confidence: Confirmed
- Suggested fix: Use `NO_PROVIDER_CONFIGURED_MESSAGE` in both branches, and distinguish "no key
  configured" from "resolving the key failed" with a different code, since the remedies differ.

### F-078 [MEDIUM] `getEffectiveApiKey` reads `process.env` directly, ignoring the env its callers thread through

- Area: C
- Location: `lib/api-keys.ts:117-119`; callers `lib/ai/effective-env.ts:30,34`,
  `lib/ai/provider-manager.ts:63`
- What happens: `loadEffectiveProviderEnv(userId, env = process.env)` accepts an env object and overlays
  onto it, but the resolution _inside_ it does `process.env[envName]?.trim()` at `api-keys.ts:118` — the
  ambient environment, not the passed one.
- Trigger: Any caller that passes a non-`process.env` env: tests, and any future request-scoped or
  per-workspace overlay.
- Impact: No production divergence today, because every caller passes `process.env`. It is a correctness
  trap of exactly the kind that produced the 2026-08-18 "two halves of one pipeline" incident: the
  parameter exists, looks authoritative, and is bypassed one call deeper.
- Confidence: Confirmed
- Suggested fix: Pass the env through to `getEffectiveApiKey`, or drop the parameter from
  `loadEffectiveProviderEnv` so the seam is not misleading.

### F-079 [MEDIUM] Raw internal error messages are returned to the client and stored on the job

- Area: C
- Location: `app/api/generate-ai-code-stream/route.ts:2271`; `lib/ai/failover.ts:160-161`;
  `lib/api/error-response.ts:31-33`; `components/workspace/GenerationWorkspace.tsx:1215`
- What happens: The outer catch ends `return jsonError((error as Error).message || 'Generation failed',
'GENERATION_FAILED', 500)` — the raw message, whatever threw. `providerFailureMessage` likewise ends
  `const detail = messageOf(error).trim(); return detail || 'The AI service is down…'`, so an
  unclassified provider error's own text becomes the user-facing sentence _and_ `Job.errorMessage`. On the
  client, `sendChatMessage`'s catch renders `Error: ${error.message}` directly into chat.
- Trigger: A Prisma connection error, a JSON parse failure on the request body, or any provider error that
  `classifyProviderFailure` cannot place.
- Impact: Internal detail reaches the browser and the database. Prisma connection errors can include the
  connection string; provider errors can echo request metadata. `Job.errorMessage` is then served to
  **any** signed-in user by `GET /api/projects/[id]/job` (F-080). The route is inconsistent with itself:
  `:2255` records `providerFailureMessage(error)` on the job while `:2271` sends the raw message to the
  client.
- Confidence: Likely — that these paths return unfiltered internal messages is Confirmed; whether a
  credential ever appears in one depends on the specific driver and provider text, which I did not
  reproduce.
- Suggested fix: Map to a code and a curated sentence at the boundary, log the detail with the request id,
  and give the user the id. `fromUnknownError` should not exist in its current form for the same reason.
  `providerFailureMessage`'s final fallback should be the generic sentence, with the raw text logged.

### F-080 [MEDIUM] Any signed-in user can read any project's job, including its prompt and error text

- Area: C
- Location: `app/api/projects/[id]/job/route.ts:16-27`; `lib/jobs/types.ts:173-199`
  (`toPublicJob` includes `inputPrompt`, `errorMessage`, `resourceIds`)
- What happens: The route looks up `prisma.project.findFirst({ where: { id, deletedAt: null } })` with no
  ownership or membership predicate — deliberately, per the comment at `:21-25` — and returns
  `toPublicJob(latest)`. That payload carries `inputPrompt` (the user's full prompt),
  `errorMessage` (which may be a raw internal string, F-079) and `resourceIds` (Coolify app uuid,
  Cloudflare zone and DNS record ids, GitHub repo name).
- Trigger: `GET /api/projects/<any-id>/job` as any signed-in member.
- Impact: Consistent with the single-workspace read model the repo documents for
  `/api/projects/[id]/files` — but the _prompt_ is the most sensitive user content in the product, and
  `resourceIds` are infrastructure identifiers rather than project content. The mutations next door
  (`keep`, `retry`, `start-over`) are correctly owner/admin gated (`:23-25` in each), which shows the
  boundary was considered for writes and not for this payload.
- Confidence: Confirmed
- Suggested fix: Keep the read open if that is the product decision, but narrow the payload: drop
  `inputPrompt`, `errorMessage` and `resourceIds` for a non-owner, or gate this route the way the
  mutations are. Phase 4 owns the final matrix.

### F-081 [MEDIUM] Setting an org-wide API key writes no audit entry, and there is no way to delete one

- Area: C
- Location: `lib/api-keys/actions.ts:109-124` (no `writeAudit`) vs `:97-104` and `:136-143` (both audit)
- What happens: `setPersonalApiKey` and `deleteApiKey` each write an `AuditLog` entry. `setOrgApiKey` —
  the more privileged action, admin-only, affecting every member — writes none. There is also no
  `deleteOrgApiKey` anywhere in the module, so an `OrgApiKey` row can be created and rotated but never
  removed through the application.
- Trigger: Set or rotate an org key from the admin UI.
- Impact: A workspace-wide credential change leaves no trail, on a system whose audit log explicitly
  records "API key" changes (`AGENTS.md`, Audit log). And because an org row outranks the admin setting
  (F-072), an unremovable org key can permanently shadow `/admin/config` with no record of who put it
  there.
- Confidence: Confirmed
- Suggested fix: Add the `writeAudit` call (same shape as the personal one, `action: 'api_key.add'` /
  `'api_key.rotate'`, scoped as org) and add a delete action. A test asserting every mutating export in
  this file audits would prevent the next omission.

### F-082 [MEDIUM] An unknown model id is silently substituted for helpers and passed through for generation

- Area: C
- Location: `lib/ai/provider-manager.ts:62-70` vs `lib/ai/providers.ts:73-81`
- What happens: `getProviderForModel` strips a vendor prefix and passes `requestedModel` only if
  `isDeepSeekModel(bare)`, otherwise `undefined` — so an unknown id quietly becomes the configured model.
  That is deliberate and documented (`:65-66`), because config defaults still carry ids like
  `openai/gpt-oss-20b` (`lib/generation/analyze-edit-intent.ts:87`). `resolveModel`, on the generation
  path, does no such check and forwards anything.
- Trigger: Pass a typo'd model to either path.
- Impact: Two opposite behaviours for the same mistake, in the same subsystem: helpers silently work with
  the wrong-but-valid model, generation silently fails at the provider. Neither says the id was not
  recognised. The asymmetry is what makes F-003 possible.
- Confidence: Confirmed
- Suggested fix: One validation point. If an unknown id must be tolerated for legacy config defaults, log
  the substitution and normalise those defaults so the tolerance can eventually be removed.

### F-083 [LOW] `completeWithProviderFailover` defaults its env to `process.env`

- Area: C
- Location: `lib/ai/plan-complete.ts:12,21`
- What happens: `opts.env ?? process.env`. The one production caller passes the overlay correctly
  (`lib/projects/plan.ts:159-161`), but a new caller that omits `env` silently gets the wrong store with
  no error.
- Trigger: A future caller.
- Impact: Exactly the plan-vs-build split recorded in `.cursor/lessons-learned.md` for 2026-08-18, which
  this function was extracted to prevent. The optional parameter re-opens the door.
- Confidence: Confirmed
- Suggested fix: Make `env` required. The caller always has it.

### F-084 [LOW] Module-scope logging of dead provider configuration

- Area: C
- Location: `app/api/generate-ai-code-stream/route.ts:114-115,125-129`
- What happens: At import time the route logs `generation.provider_config` with `isUsingAIGateway`,
  `hasGroqKey` and `hasAIGatewayKey`, all derived from environment variables no code reads any more.
  `aiGatewayBaseURL` and the `createOpenAI` import at `:2` are likewise unused on this path
  (`clientForEntry` builds the client).
- Trigger: Process start.
- Impact: Booleans only — no key material leaks. It misleads: an operator reading logs sees an AI-gateway
  concept the product does not have, and a future reader may wire something to it.
- Confidence: Confirmed
- Suggested fix: Delete the constants, the log line, and the direct `createOpenAI` import.

---

## GAP — missing capability

### F-090 [GAP] No dependency installation exists; package detection is elaborate theatre

- Area: B
- Location: `app/api/generate-ai-code-stream/route.ts:1083,1222-1241,1322-1347,1349-1369,2107`;
  `lib/generation/generation-runtime.ts:773-776,873-889`;
  `components/workspace/GenerationWorkspace.tsx:627-636,640-647,896-969`
- What happens: The route detects packages three ways — `<package>` tags during the stream, a `<packages>`
  block after it, and an import scan over every generated file — sends each as a `package` frame, and
  ships the list on `complete` as `packagesToInstall`. The client stores it on `window.pendingPackages`,
  reads it back in `applyGeneratedCode`, and passes it to `startApply` as `packages`. `runApplyStream`
  ignores the field entirely. Nothing installs anything: there is no lockfile handling, no install
  command, no failure path, no network-restricted fallback. The UI that would report it
  (`GenerationWorkspace.tsx:896-969`, "Installing packages… This may take a moment while npm installs the
  required packages…") is unreachable, because `codeApplicationState.stage` is only ever set to
  `'analyzing'`, `'applying'` or `'complete'` (`GenerationWorkspace.tsx:624`,
  `generation-runtime.ts:875,883`) and the whole branch also requires `sandboxData?.url`, which is always
  null.
- Impact: This is arguably correct now — `lib/preview/deps.ts` resolves dependencies from a CDN at compile
  time and the generation route's own chat copy says so ("there is nothing to install — the preview loads
  each dependency straight from the CDN", `GenerationWorkspace.tsx:1060`). The gap is that ~90 lines of
  detection, three SSE frame types, a `window` global handshake and a full progress UI still exist for it,
  and the surviving copy tells users about npm installs that never happen. A published site's real
  dependency resolution is the deploy build, which none of this feeds.
- Suggested fix: Decide. If CDN resolution is the model, delete the detection, the frames, the
  `window.pendingPackages` handshake and the install UI, and keep the import scan only if
  `lib/preview/deps.ts` needs it. If a real install is intended, it needs a design — lockfile,
  failure reporting, and an offline path — not a resurrection of this wiring.

### F-091 [GAP] Attachments and pasted files are not implemented

- Area: A
- Location: `components/workspace/ChatInput.tsx:98-108`
- What happens: The paperclip button is permanently `disabled` with a "Attachments coming soon" hint and a
  `TODO: wire existing attachments when an upload path exists`. There is no paste handler, so a pasted
  image is dropped by the browser and pasted text goes in as text with no size limit (F-007).
- Impact: A user who wants to give the model a screenshot, a design file or a document has no path.
  Nothing is _silently_ dropped — the control is visibly disabled, which is honest.
- Suggested fix: If attachments are planned, the Assets pipeline (`lib/assets`, `ProjectAsset`,
  `/api/projects/[id]/assets`) already handles upload, storage and the asset manifest that reaches the
  prompt; wiring the chat input to it is mostly plumbing. If not planned, remove the button.

### F-092 [GAP] No stream resume after a drop

- Area: B
- Location: `lib/generation/generation-runtime.ts:681-839` (single-shot `response.body.getReader()`);
  `components/workspace/useGenerationJob.ts:91-146`
- What happens: The SSE consumer is a one-shot read of one fetch body. There is no `Last-Event-ID`, no
  event ids on the frames, and no reconnect. Recovery is by polling `GET /api/projects/[id]/job` every
  2-10 s, which reports status and `filesWritten` but cannot replay the stream.
- Impact: A dropped connection means the user loses the live view for the rest of the build: no more file
  names, no code panel updates, no chat frames — and gets an error first (F-036) and a wrong message
  (F-037). The build itself completes and persists, which is the important half.
- Suggested fix: The cheap version is to make the drop honest — poll-and-report rather than error — and
  show the job's `partialFiles` / `currentStep` in place of the stream. Full resume needs frame ids and a
  server-side ring buffer per job.

### F-093 [GAP] No prompt length cap and no submit rate limit

- Area: A
- Covered by F-007 and F-010; listed here because both are absent capabilities rather than defective code.
  The building blocks exist elsewhere in the repo (`lib/export/rate-limit.ts`, the credit system) and are
  not applied to the most expensive endpoint in the product.

### F-094 [GAP] `NAVROOP_FILE_CONTEXT_TOKEN_CAP` is env-only, with no admin setting

- Area: B
- Location: `lib/generation/selective-context.ts:3-9`
- What happens: The follow-up file-context budget (default 30,000 tokens) is read from
  `process.env.NAVROOP_FILE_CONTEXT_TOKEN_CAP` and has no `SETTINGS` entry, so it cannot be changed
  without a redeploy and does not appear on `/admin/config` beside `ai.concurrency` and
  `ai.primaryModel`.
- Impact: This is a tunable an operator would plausibly change — it trades prompt cost against edit
  accuracy — and the repo's own rule is that tunables belong in admin settings, not deploy env. It is also
  invisible: an operator debugging why edits see too little context has no way to find it.
- Suggested fix: Add a registry entry (`ai.fileContextTokenCap`, `kind: 'number'`, env
  `NAVROOP_FILE_CONTEXT_TOKEN_CAP`, fallback `30000`) and read it through `getSetting`.
  `tests/unit/settings-registry-consumers.test.ts` already pins that registry fallbacks match code
  defaults, so the pairing is testable.

---

## IMPROVEMENT

### F-095 [IMPROVEMENT] ~370 lines of commented-out code in the workspace component

- Location: `components/workspace/GenerationWorkspace.tsx:752-782` (`restartViteServer`, `applyCode`),
  `:1237-1576` (`clearChatHistory`, `cloneWebsite` with its own full SSE reader and prompt)
- The commented `cloneWebsite` block contains a second, drifted copy of the stream-frame handler and of
  the URL-clone prompt. It is the most likely thing an agent will copy from when touching this file, and it
  describes a sandbox architecture that no longer exists. Delete it; git has it.

### F-096 [IMPROVEMENT] Dead locals and imports in the workspace component

- Location: `components/workspace/GenerationWorkspace.tsx:25` (`shouldRequestSandbox`, imported never
  called), `:85` (`setSandboxData`), `:106` (`status`/`setStatus` via `updateStatus`), `:107`
  (`responseArea`, F-058), `:126` (`urlOverlayVisible`), `:151` (`fileStructure`, written never read),
  `:541-549` (`handleSurfaceError`, "kept for compatibility"), `:551` (`sandboxCreationRef`)
- Together with the dead `sandboxData?.url` iframe branch (`:883-1006`) these keep a removed subsystem
  present in the file's shape, which is what makes the file hard to reason about at 2,281 lines.

### F-097 [IMPROVEMENT] `GenerationWorkspace` re-declares `ChatMessage`, `SandboxData` and `ScrapeData`, and the copy has drifted

- Location: `components/workspace/GenerationWorkspace.tsx:37-69` vs `lib/generation/types.ts:6-10,56-77`
- The local `ChatMessage` is missing `source`, `skillNames` and `creditDenial` — all three of which the
  component passes through (`:1048`, `:1174`, and `ChatPanel` renders `creditDenial`). The values come
  from the provider, typed with the shared interface, so the locals are unused shadows that will mislead
  the next reader. Import the shared types.

### F-098 [IMPROVEMENT] The React stack prompt contradicts itself on file extensions

- Location: `lib/stack-prompts/react.ts:8` ("Entry src/main.jsx mounts src/App.jsx. Components in
  src/components/_.jsx") vs `:15-18` ("src/App.tsx composes …", "src/components/_.tsx", "Use TypeScript
  (.tsx/.ts)")
- One prompt, two answers. Mixed output makes `stackShapeMismatch` and the import resolver's job harder
  and produces projects with both extensions. Pick one — the FILES section and `:18` both say TypeScript,
  so the STACK line is the stale half.

### F-099 [IMPROVEMENT] Generation prompts reference a stack the product does not have, and the URL-clone and brand-extension fallbacks hardcode React

- Location: `lib/stack-prompts/seo-rules.ts:20,22`;
  `components/workspace/GenerationWorkspace.tsx:1978-2002`, `:1867-1926`
- `seo-rules` tells the model to "Recommend Next.js or Astro for public marketing sites" **and** to write
  that recommendation into the generated site as an HTML comment — for a product with exactly three
  stacks, none of them Astro (`AGENTS.md`, Stacks). Separately, the URL-clone fallback prompt
  (`:1978`, reached when the importer produced no `filesXml`) and the brand-extension prompt (`:1867`)
  both hardcode "React application", `src/App.jsx`, `src/index.css` and — contradicting `BASE_RULES`
  ("Tailwind only… never CSS Modules / style={{}}") — "Create custom CSS classes in index.css". Neither
  consults the project's stack, so a NEXTJS or STATIC_HTML project on those paths is told to build the
  wrong thing, which `stackShapeMismatch` then fails at settle time
  (`route.ts:1877-1883`). The brand-extension branch is additionally gated on a
  `sessionStorage.brandExtensionMode` key that nothing in scope sets.

---

## Files reviewed

`app/api/generate-ai-code-stream/route.ts` — F-001, F-002, F-003, F-005, F-007, F-008, F-009, F-010, F-012, F-021, F-022, F-023, F-024, F-025, F-026, F-027, F-030, F-035, F-038, F-039, F-041, F-042, F-043, F-045, F-051, F-056, F-077, F-079, F-084, F-090, F-099
`app/api/projects/[id]/files/route.ts` — clean
`app/api/projects/[id]/import/route.ts` — F-049
`app/api/projects/[id]/job/keep/route.ts` — clean
`app/api/projects/[id]/job/retry/route.ts` — clean
`app/api/projects/[id]/job/route.ts` — F-080
`app/api/projects/[id]/job/start-over/route.ts` — clean
`app/api/projects/[id]/plan/approve/route.ts` — clean
`app/api/projects/[id]/plan/followup/route.ts` — F-011
`app/api/projects/[id]/plan/refine/route.ts` — F-011
`app/api/projects/[id]/plan/route.ts` — F-011
`app/project/[id]/domains/page.tsx` — clean
`app/project/[id]/layout.tsx` — clean
`app/project/[id]/page.tsx` — F-013
`components/workspace/BuildingIndicator.tsx` — clean
`components/workspace/ChatInput.tsx` — F-006, F-007, F-091
`components/workspace/ChatPanel.tsx` — clean
`components/workspace/GenerationCodeView.tsx` — clean
`components/workspace/GenerationWorkspace.tsx` — F-002, F-004, F-021, F-053, F-054, F-057, F-058, F-090, F-095, F-096, F-097, F-099
`components/workspace/ProjectWorkspace.tsx` — clean
`components/workspace/StreamingCodePanel.tsx` — clean
`components/workspace/types.ts` — comment rot only: the doc at `:28-31` says `GET /api/projects/[id]/files` "answers 403 to every non-owner non-admin", which that route explicitly no longer does (`app/api/projects/[id]/files/route.ts:29-37`). The `fail-closed` logic itself is correct. Not filed as a numbered finding.
`components/workspace/useGenerationJob.ts` — `refresh()` at `:58-66` returns null on any non-OK response and leaves the previous job in state, so a persistent poll failure is invisible; polling continues because `shouldPoll` also keys on `phase`. Minor, folded into F-036's class rather than filed separately.
`components/workspace/useProjectPlan.ts` — F-048
`lib/ai/circuit.ts` — F-031
`lib/ai/client-for-entry.ts` — clean
`lib/ai/effective-env.ts` — clean (registry key mapping verified against `lib/settings/registry.ts`)
`lib/ai/empty-completion.ts` — clean
`lib/ai/failover.ts` — F-079
`lib/ai/plan-complete.ts` — F-083
`lib/ai/provider-manager.ts` — F-073, F-082
`lib/ai/providers.ts` — F-003, F-004, F-082
`lib/ai/queue.ts` — F-001 (in-memory slot leak), F-030 (release asymmetry)
`lib/ai/run.ts` — F-030, F-031, F-055
`lib/api-keys.ts` — F-071, F-072, F-078
`lib/api-keys/actions.ts` — F-070, F-081
`lib/api-keys/schema.ts` — F-072 (the derived enum is what blocks deletion)
`lib/consumption/caps.ts` — clean
`lib/consumption/cost.ts` — F-029
`lib/consumption/plan-caps.ts` — clean
`lib/consumption/record.ts` — F-027
`lib/generation/analyze-edit-intent.ts` — F-026 (no reachable caller), F-039 (logs the full prompt), F-082 (`:87` dead default model id)
`lib/generation/apply-page-copy.ts` — clean
`lib/generation/conversation-state.ts` — clean
`lib/generation/generation-runtime.ts` — F-002, F-021, F-036, F-037, F-040, F-043, F-050, F-090, F-092
`lib/generation/no-changes.ts` — F-025
`lib/generation/output-summary.ts` — clean
`lib/generation/parse-blocks.ts` — F-023
`lib/generation/parse-files.ts` — F-028, F-052
`lib/generation/prompt-cache.ts` — clean
`lib/generation/selective-context.ts` — F-094; also `:112-116` truncates an oversized referenced file only when `full.length === 0`, so a large file arriving after another full one silently drops to path-only. Minor, not filed.
`lib/generation/stream-file-tracker.ts` — clean (and the correct bounded-buffer pattern F-024 should adopt)
`lib/generation/token-estimate.ts` — clean
`lib/generation/truncation-recovery.ts` — F-042
`lib/generation/types.ts` — clean
`lib/generation/validate-imports.ts` — clean; runs fully synchronously over the merged project map inside the request handler that is also driving the SSE stream, which will block the event loop on a large project. Noted, not filed — no observed defect.
`lib/generation/write-guard.ts` — F-028 (no production caller)
`lib/jobs/admin-display.ts` — clean
`lib/jobs/admin.ts` — F-047 (consumer of the mislabelled code)
`lib/jobs/boot.ts` — clean
`lib/jobs/chat-ui.ts` — clean
`lib/jobs/compensate-publish.ts` — F-046
`lib/jobs/compensate.ts` — F-046
`lib/jobs/copy.ts` — F-020 (`offersRecoveryKeep` admits FOLLOWUP), F-047
`lib/jobs/index.ts` — clean
`lib/jobs/lifecycle.ts` — F-001, F-022, F-032
`lib/jobs/orphans.ts` — clean
`lib/jobs/poll.ts` — clean
`lib/jobs/progress.ts` — F-034
`lib/jobs/recovery-retry.ts` — F-033
`lib/jobs/recovery.ts` — F-020, F-033
`lib/jobs/resumable-phase.ts` — clean
`lib/jobs/resume.ts` — clean
`lib/jobs/sandbox-choice.ts` — clean
`lib/jobs/settle-generation.ts` — F-022 (narrow post-check race), F-028, F-044
`lib/jobs/settle.ts` — clean
`lib/jobs/step-failure.ts` — clean
`lib/jobs/store.ts` — clean; `:452` cites `route.ts:313` as the single `acquire()` call site, which is now `:345`. Stale line reference only.
`lib/jobs/types.ts` — F-052, F-080
`lib/jobs/wrap.ts` — F-047
`lib/prompts/version.ts` — clean; `:54-57` derives the label from a live `count()` and `:45-49`/`:56-57` do `updateMany` + `create` outside a transaction, so two concurrent first-callers can race to a duplicate hash (P2002) or collide on a label. Not filed — no observed defect and the drift guard it exists for works.
`lib/settings/app-url.ts` — clean
`lib/settings/registry.ts` — clean
`lib/settings/resolve.ts` — F-075, F-076
`lib/settings/test-group.ts` — F-074
`lib/stack-prompts/base-rules.ts` — clean
`lib/stack-prompts/index.ts` — clean
`lib/stack-prompts/nextjs.ts` — clean
`lib/stack-prompts/react.ts` — F-098
`lib/stack-prompts/seo-rules.ts` — F-099
`lib/stack-prompts/shared.ts` — clean
`lib/stack-prompts/static-html.ts` — clean

92 of 92 files read in full. Files cited as related context but outside this phase's scope, and therefore
not carrying a verdict here: `proxy.ts`, `lib/projects/lock.ts`, `lib/projects/plan.ts`,
`lib/projects/http.ts`, `lib/api/error-response.ts`, `lib/import/persist.ts`,
`prisma/migrations/20260817220000_generation_jobs/migration.sql`.
