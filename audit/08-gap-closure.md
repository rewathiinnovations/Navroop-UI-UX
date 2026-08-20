# Section P (gap closure) — the files Phase 7 did not finish reading

Scope: the 12 partially-read files plus the digest-only set declared at
`audit/07-everything-else.md:5-31`. Finding ids **F-800 … F-849**.

Method: every file below was read front to back. Claims that could not be confirmed from a
line I actually opened were dropped — see **§4 Hypotheses I killed** for the ones that looked
like findings and were not. Two read-only scouts read `packages/create-open-lovable/**` and the
five `scripts/verify-*` files; **every claim they returned was re-verified against the source
before it was filed here**, and one of their claims was wrong (noted in §4).

---

## 1. Per-file verdict

| File                                                      | Lines | Verdict                                                 |
| --------------------------------------------------------- | ----- | ------------------------------------------------------- |
| `lib/projects/actions.ts`                                 | 614   | F-804, F-805, F-806, F-807, F-808, F-809                |
| `lib/projects/plan.ts`                                    | 672   | F-810, F-811, F-812, F-813, F-814                       |
| `lib/audit/actions.ts`                                    | 363   | F-819, F-820, F-821, F-822 (+ confirms F-705)           |
| `lib/seo/actions.ts`                                      | 345   | F-819, F-820, F-821, F-822                              |
| `lib/signals/collect.ts`                                  | 343   | F-815, F-816, F-817, F-818                              |
| `lib/templates/actions.ts`                                | 445   | F-823, F-824, F-825, F-826, F-827, F-828                |
| `lib/context-selector.ts`                                 | 363   | F-800, F-801                                            |
| `lib/edit-intent-analyzer.ts`                             | 509   | F-800, F-802                                            |
| `lib/edit-examples.ts`                                    | 252   | F-800, F-801                                            |
| `lib/file-parser.ts`                                      | 264   | F-800 (fully dead — no importer anywhere)               |
| `lib/ui-ux-pro-max/build-design-brief.ts`                 | 243   | F-829, F-830, F-831, F-832                              |
| `tailwind.config.ts`                                      | 407   | F-833, F-835, F-836                                     |
| `colors.json`                                             | 181   | F-833, F-834                                            |
| `scripts/verify-plan-build-fn.ts`                         | 217   | F-837, F-813 (sole consumer of the global)              |
| `scripts/verify-plan-build.mjs`                           | 233   | F-837, F-839                                            |
| `scripts/verify-projects-api.mjs`                         | 217   | F-837, F-840                                            |
| `scripts/verify-projects-data.mjs`                        | 120   | F-837, F-838                                            |
| `scripts/verify-usage-http.mjs`                           | 148   | F-837, F-840                                            |
| `packages/create-open-lovable/package.json`               | —     | F-841                                                   |
| `packages/create-open-lovable/index.js`                   | —     | clean                                                   |
| `packages/create-open-lovable/lib/prompts.js`             | —     | F-841 (sandbox-provider drift; security in F-720)       |
| `packages/create-open-lovable/lib/installer.js`           | —     | F-720 (existing) — confirmed, not re-filed              |
| `packages/create-open-lovable/templates/e2b/README.md`    | —     | F-841 (documents the deleted sandbox)                   |
| `packages/create-open-lovable/templates/e2b/.env.example` | —     | clean (placeholders only)                               |
| `eslint.config.mjs`                                       | 58    | F-803 (read as the root cause of the dead-code cluster) |

Files outside the assigned list that a finding here necessarily touches:
`components/ui/shadcn/button.tsx` (F-833), `components/app/(home)/sections/ai-readiness/MetricBars.tsx`
(F-833), `styles/colors.json` (F-834), `components/workspace/useCodeAudit.ts` +
`useSeoAudit.ts` (F-819), `lib/audit/static/tool-fail.ts` (F-705 confirmation),
`pnpm-workspace.yaml` (F-842), `docs/codegen-vs-open-lovable.md` (F-801).

---

## 2. Direct answers to the brief's questions

**Dead code.** All four candidates are dead, but not equally:

| Module                        | Status                                                         | Evidence                                                                                                                                                                                                                                                                            |
| ----------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/file-parser.ts`          | **Fully dead** — zero importers in the entire repo             | grep for `lib/file-parser` / `parseJavaScriptFile` / `buildComponentTree` returns only the file itself and the audit ledger                                                                                                                                                         |
| `lib/context-selector.ts`     | **Imported, unreachable**                                      | `app/api/generate-ai-code-stream/route.ts:5` imports `selectFilesForEdit`; both call sites (`:718`, `:727`) sit inside `if (manifest)`, and `manifest` is `global.sandboxState?.fileCache?.manifest` (`:591`), which has no writer (Phase 1, `audit/01-prompt-generation.md:17-20`) |
| `lib/edit-intent-analyzer.ts` | **Unreachable** — only importer is `lib/context-selector.ts:2` | transitively dead behind the same `if (manifest)`                                                                                                                                                                                                                                   |
| `lib/edit-examples.ts`        | **Unreachable** — only importer is `lib/context-selector.ts:3` | same                                                                                                                                                                                                                                                                                |

They are **not** an unwired intended replacement — they are the superseded originals. The
replacement exists and is wired: `lib/generation/selective-context.ts` `selectFileContext`
(route.ts:29) over `getCurrentProjectFiles` (route.ts:43) reading `Project.lastCode`. Note the
sandbox provenance is visible in the dead code itself: `lib/context-selector.ts:102,140,147`
and `lib/edit-intent-analyzer.ts:426` still strip/append the E2B path prefix `/home/user/app/`.
Same category as `parseGenerationFiles` / `assertWritableGenerationFile`. See F-800/F-801.

**`lib/templates/actions.ts`.** All 12 exports are `export async function` and there is no
other export form in the file, so the `'use server'` rule (AGENTS.md:94) holds with nothing to
qualify. Authorization gates, per export: `listTemplates` session +
`canManageTemplates` for `includeInactive` (`:60-64`); `getTemplate` session (`:84`);
`createFromTemplate` session (`:96`); `previewSaveAsTemplate` owner/ADMIN (`:142`);
`saveProjectAsTemplate` owner/ADMIN (`:191`); the seven `admin*` exports each `requireAdmin`
(`:241, 258, 290, 315, 332, 338, 348`). No gap.

The AGENTS.md:42 workspace-scoping claim **holds on every read path**: `listTemplateRows`
applies `WHERE ("workspaceId" IS NULL OR "workspaceId" = $n)` unconditionally
(`lib/templates/store.ts:79`) — including when `includeInactive` is true, which is what
`listTemplates:73-75` relies on when it skips its own filter — and `getTemplate` /
`createFromTemplate` re-check via `isVisibleToWorkspace` (`lib/templates/visibility.ts:13-20`).
The three admin **write** paths are the exception (F-826).

**`duplicateProject`.** The TODO at `lib/projects/actions.ts:467` is accurate and understates
it. Confirmed: F-805.

**`lib/signals/collect.ts` / F-705.** **Confirmed**, with a more precise mechanism than F-705
states — see §3. Also produced two findings F-705 does not cover (F-815, F-816).

**`lib/seo/actions.ts` / `lib/audit/actions.ts` failure paths.** They do **not** surface.
Confirmed: F-819.

**`tailwind.config.ts` + `colors.json`.** No value contradicts the light-theme default —
`darkMode: "class"` (`tailwind.config.ts:58`) with `.dark` as an opt-in block
(`styles/main.css:61`), and nothing sets `class="dark"` on `<html>`. The token system _is_
duplicated, and three tokens are broken: F-833, F-834.

**`packages/create-open-lovable/**`.** A `bin`-declaring CLI scaffolder for the deleted
e2b/modal/daytona sandbox providers. **Dead**: F-841. No hardcoded credentials — the only keys
are placeholders in `templates/e2b/.env.example`; the plaintext-key _writing_ is F-720's
`installer.js` behaviour, which I re-read and confirm.

---

## 3. Confirmations of existing findings (not re-filed)

**F-705 — CONFIRMED, and the mechanism is not the one F-705 names.** F-705 attributes the
perfect scores to the four static checks reporting "could not run". The actual pin is a
**category mismatch**: `toolFailedFinding` emits `category: 'tool'`, `status: 'low'`
(`lib/audit/static/tool-fail.ts:8-9`), while `metricsFromFindings` counts
`category === 'typescript'` / `'lint'` / `'a11y'` (`lib/audit/findings.ts:86-89`). So the
"could not run" finding is counted in **no** metric bucket and every metric is a hard `0`:

- `tsErrors: 0` → `typeSafetyScore(0)` returns `1` (`lib/signals/score.ts:120-122`)
- `a11yViolations: 0` → `a11yScoreFromAxe([])` returns `1` (`score.ts:107-108`)
- and a third F-705 does not cite: `lib/audit/actions.ts:132` computes
  `buildOk: !findings.some((item) => item.id === 'bundle:build-failed')`. With `sandbox = null`
  (`:99`) the bundle step can only emit `tool:bundle`, never `bundle:build-failed`, so
  `buildOk` is unconditionally `true` → `buildSuccessScore(true)` returns `1`
  (`score.ts:116-118`).

Three of the weighted `/admin/quality` signals are therefore constant `1.0` on every audit
forever, so the overall score is inflated by construction and can never register a regression
in type safety, accessibility, or build success. Add `lib/audit/actions.ts:132` and
`lib/audit/static/tool-fail.ts:8-9` to F-705's locations.

**F-750 — confirmed live.** `lib/usage-estimates.ts:6,22-26` does add `E2B_SANDBOX_ESTIMATE`
(0.02) to every `initial`/`followup` event cost. New: a second, hand-copied instance of the
same model in a dead script — F-839.

**F-720 — confirmed.** `packages/create-open-lovable/lib/installer.js:25-37` prompts
`Directory ${name} already exists. Overwrite?` and on confirm calls `fs.remove(projectPath)`;
`:75` runs `execSync('npm install', { cwd: projectPath })`. F-841 adds the workspace-membership
evidence that proves the "unreferenced" half.

**Phase 4's ruling on `GET /api/projects/[id]` stands.** `audit/04-security-data.md:104` calls
the missing ownership check "workspace-wide read by design", and `listProjects`'s `mine: false`
branch (`lib/projects/actions.ts:236`) corroborates that cross-member read is intended. I am
**not** filing that as a security finding. F-809 is narrower: the field breadth, not the access.

---

## 4. Hypotheses I killed

Recording these because each looked like a finding and would have been a false positive.

1. **`peekActor()` is not a cross-request auth bypass.** `lib/projects/actions.ts:104,509` and
   the `requireActor()` helpers in `plan.ts:106`, `audit/actions.ts:43`, `seo/actions.ts:43` all
   read a store that is an `AsyncLocalStorage` (`plan.ts:1,73,81-83`), so it is request-scoped.
2. **`tailwind.config.ts` is not inert.** The project is on Tailwind **3.4.17** (`package.json`,
   and `node_modules/tailwindcss/package.json` agrees) with `tailwindcss` in
   `postcss.config.mjs`, so the JS config is fully live. A v4 CSS-first setup would have made
   all 407 lines dead; it is not one.
3. **The `cs-*` utility is not broken.** I expected `matchUtilities`' `{ width: 100 }`
   (`tailwind.config.ts:371-372`) to serialise to invalid unitless CSS. It does not:
   `postcss-js@4.0.1/parser.js:44-48` appends `px` to numeric values for non-unitless
   properties. Verified empirically — `{'.cs-10':{width:10,...}}` renders `width: 10px`.
   The residual defect is only the non-numeric `sizes` entries (F-836).
4. **`Project.phase` is not nullable.** `prisma/schema.prisma:169` is
   `phase ProjectPhase @default(PLANNING)`, so `requestFollowUpPlan`'s fall-through branch
   (`plan.ts:524-526`) is unreachable, not a wrong-message bug. The `phase: … | null` in
   `ListProjectRow` (`actions.ts:294`) is an over-wide type, nothing more.
5. **`stablePrefix` really is a prefix.** I suspected `plan.ts:356` (raw `project.stack`) and
   `:358` (`getStack(stack).id`) could disagree and make `systemPrompt.replace(stablePrefix,'')`
   (`:360`, `:170`) a no-op that duplicates the prefix. They cannot:
   `buildStablePromptPrefix` throws unless `isStackId(stack)` (`lib/stack-prompts/index.ts:38-40`),
   so `project.stack` is already canonical and both calls produce the same bytes.
6. **`globalThis.conversationState` does have writers** — `app/api/conversation-state/route.ts:47,71,156`
   and `generate-ai-code-stream/route.ts:485`. It is not in the same no-writer category as
   `sandboxState`; the defect is that it is process-global, which is F-812.
7. **The scout's claim that `E2B_SANDBOX_ESTIMATE` is "unused" in `verify-plan-build.mjs` is
   wrong.** It is used, at `:23`, inside `calculateEventCost`. F-839 states the real defect.

---

## 5. Findings

### F-800 [MEDIUM] Four sandbox-era generation-context modules, 1,388 lines, are unreachable dead code

- Area: P
- Location: `lib/file-parser.ts` (whole file, no importer); `lib/context-selector.ts:1-363`;
  `lib/edit-intent-analyzer.ts:1-509`; `lib/edit-examples.ts:1-252`; reachability gate at
  `app/api/generate-ai-code-stream/route.ts:591,593,716-718,726-727`
- What happens: `selectFilesForEdit` is imported at route.ts:5 but both call sites are inside
  `if (manifest)`, and `manifest` is `global.sandboxState?.fileCache?.manifest` (`:591`) — a
  global with no writer anywhere in the repo. `lib/edit-intent-analyzer.ts` and
  `lib/edit-examples.ts` are reachable only through `lib/context-selector.ts:2-3`, so they die
  with it. `lib/file-parser.ts` — which is the only thing that could ever have produced the
  `componentInfo` / `componentTree` fields `context-selector.ts:110,119,264` reads — has no
  importer at all. The route's own comment at `:960-964` admits the situation: "a manifest only
  ever came from a sandbox sync". The provenance is still in the source: `/home/user/app/`
  is stripped at `context-selector.ts:102,140,147` and synthesised at
  `edit-intent-analyzer.ts:426`.
- Trigger: every follow-up edit. The `else` branch at route.ts:721-734 is the only branch that
  ever executes, and it emits "⚠️ No file manifest available, will use broad context".
- Impact: 1,388 lines that read as the edit-context engine and are not. Three of the four
  contain their own latent defects (F-802), and `file-parser.ts:199` misclassifies any file
  containing the word `children` as a layout — invisible today, live the moment anyone "wires
  it back up". A reader looking for why targeted edits behave generically will read the wrong
  module.
- Confidence: Confirmed
- Suggested fix: delete all four files and the `if (manifest)` branch in the generate route,
  along with the `sandboxState` global declaration at route.ts:230-233 and the four dead reads
  at `:585-596,1868-1869`. The live path (`lib/generation/selective-context.ts` over
  `getCurrentProjectFiles`) is already wired and needs nothing from them. Before deleting,
  harvest the prompt text called out in F-801.

### F-801 [MEDIUM] The "surgeon" and "do not recreate files" edit instructions exist only in dead code, and a doc asserts they are live

- Area: P
- Location: `docs/codegen-vs-open-lovable.md:86`; text at `lib/context-selector.ts:152`,
  `:190-200`; `lib/edit-examples.ts:5-226`
- What happens: the doc states that `lib/context-selector.ts` and `lib/edit-examples.ts` are
  "**still wired** — `selectFilesForEdit` is imported in the generate route and its
  `buildSystemPrompt()` output is injected into the prompt. That carries the 9 worked edit
  examples, 'DO NOT CREATE NEW FILES WITH SIMILAR NAMES', and the 'surgeon making a precise
  incision' instructions." The import is real; the injection is not (F-800). A repo-wide grep
  for `surgeon`, `precise incision`, `preserve 99%` and `DO NOT CREATE NEW FILES` returns only
  `lib/context-selector.ts` and that doc line — **nothing in `lib/stack-prompts/**`**.
- Trigger: every generation. The model never receives any of it.
- Impact: two defects in one. The doc will stop the next person from looking for the missing
  instructions, and the instructions are genuinely missing: the anti-duplicate-file rule, the
  9 worked examples, and the surgical-edit discipline are absent from every production prompt
  while the repo believes they are present. This is a plausible contributor to follow-up edits
  rewriting more than they were asked to.
- Confidence: Confirmed
- Suggested fix: move the still-wanted prompt text into `lib/stack-prompts/base-rules.ts` so it
  lands inside the cacheable prefix, then correct `docs/codegen-vs-open-lovable.md:86` to say
  the modules are dead. Do not delete them (F-800) until the text has been moved.

### F-802 [LOW] Two classification defects inside the dead intent analyzer, including a fully shadowed pattern

- Area: P
- Location: `lib/edit-intent-analyzer.ts:13-109` (pattern table), `:17` vs `:53`, `:34`;
  instructions that are consequently unreachable at `lib/context-selector.ts:219-226`
- What happens: patterns are tested in array order (`:94-96`), so an earlier entry shadows a
  later one. `UPDATE_COMPONENT`'s `/change\s+(the\s+)?(\w+)/i` (`:17`) matches every
  `change the <word>`, which makes `UPDATE_STYLE`'s `/change\s+(the\s+)?(color|theme|style|styling|css)/i`
  (`:53`) **unreachable**. Verified by replaying the table: "change the color to blue",
  "change the theme to dark" and "change the styling" all classify `UPDATE_COMPONENT`, so the
  much stricter style instructions at `context-selector.ts:219-226` ("Change ONLY the specific
  style/class mentioned … DO NOT refactor or 'improve' the styling") never apply.
  Separately, `ADD_FEATURE`'s `/add\s+(\w+)\s+to\s+(?:the\s+)?(\w+)/i` (`:34`) cannot match a
  two-word subject, so "add a search bar to the header" — the repo's own canonical example at
  `lib/edit-examples.ts:62` — falls through to the `:112-118` default: confidence `0.3` and
  `targetFiles: [manifest.entryPoint]`, i.e. App.jsx, which is precisely the mistake
  `edit-examples.ts:69-71` tells the model to avoid. Also dead within the dead file:
  `resolveImportPath` / `resolveRelativePath` (`:398-449`) are never called, and `lowerPrompt`
  (`:316`) is never read.
- Trigger: latent — the module is unreachable (F-800).
- Impact: none today. Filed because the brief asks whether these files are a viable replacement:
  they are not, and restoring them would ship a style-edit path that cannot be reached and an
  add-feature path that contradicts the examples shipped beside it.
- Confidence: Confirmed
- Suggested fix: delete with F-800. If any of it is revived, order patterns most-specific-first
  and drive classification from the live `lib/generation/analyze-edit-intent.ts` model call
  rather than a regex table.

### F-803 [MEDIUM] `no-unused-vars` is disabled repo-wide, so the verify gate cannot see dead code

- Area: P
- Location: `eslint.config.mjs:11` (and `:10` for `no-explicit-any`); gate described at
  AGENTS.md:79
- What happens: `'@typescript-eslint/no-unused-vars': 'off'`. `pnpm run verify` runs
  `eslint --max-warnings 0`, so the gate is strict — but blind to unused imports, unused
  locals, and unused module-level functions. Every neighbouring disable in the file carries a
  justification comment (`:12-14` for `no-empty`, `:16-17` for `exhaustive-deps`, `:19-21` for
  `set-state-in-effect`); `:10` and `:11` carry none. The `depcheck`/`knip` step that could
  catch unused exports is a _report_, not a gate.
- Trigger: every `verify` run.
- Impact: the structural reason this gap-closure phase exists. It is why
  `lib/edit-intent-analyzer.ts:398-449,316`, the dead `previewUrl` assignments at
  `lib/audit/actions.ts:98` and `lib/seo/actions.ts:88`, and the unused `fileInfo` destructures
  at `edit-intent-analyzer.ts:153,164` all pass CI. Dead code accumulates with no signal.
- Confidence: Confirmed
- Suggested fix: turn the rule on as `warn` with `argsIgnorePattern: '^_'` and fix the
  resulting set file by file, or scope the `off` to the directories that genuinely need it with
  a comment saying which and why. Promote the `knip` unused-export report to a gate once the
  backlog is clear.

### F-804 [MEDIUM] `listProjects` swallows every database error into a fallback that returns a different row shape

- Area: P
- Location: `lib/projects/actions.ts:231-286` (`catch {` at `:271`), fallback mapper `:303-349`
- What happens: the Prisma query at `:232` is wrapped in a bare `catch {` that discards the
  error entirely and re-runs the list as raw SQL. The comment at `:272` justifies it for one
  cause ("Stale Prisma client (pre-phase/stars DMMF)"), but the catch has no discrimination — a
  connection-pool exhaustion, a permissions error, or a genuine schema break all silently take
  the fallback. Worse, the two paths do not agree on the payload: the primary maps to
  `{ …project, starred }` (`:265-268`), while the fallback adds `liveUrl`, `previewUrl` and
  `publishBadge` (`:318-320,336-345`). So the publish badge on a project card is populated
  **only when the primary query fails**.
- Trigger: any Prisma error on the list query — including transient ones.
- Impact: two failure modes. A real outage is reported as a successful list (audit invariant 4,
  `audit/00-map.md:96`: "`[]`/`{}`/`false` is not 'nothing happened'"). And whichever of the two
  shapes the UI was built against, the other one is wrong — a field present on the degraded
  path and absent on the healthy path is a rendering difference nobody will reproduce, because
  reproducing it requires breaking the database.
- Confidence: Confirmed
- Suggested fix: catch the specific Prisma error the comment names (`PrismaClientValidationError`
  / `PrismaClientKnownRequestError` with the DMMF code) and rethrow everything else; log the
  caught one through `logError`, which this file already imports at `:30`. Then make the two
  paths return one shared shape — either both compute the deployment badge or neither does.

### F-805 [MEDIUM] `duplicateProject` produces an empty project, drops the import source, and writes no audit row

- Area: P
- Location: `lib/projects/actions.ts:453-482`; TODO at `:467`; `prisma/schema.prisma:169`
- What happens: the `select` at `:459` reads five columns and the `create` at `:468-477` writes
  six. Not copied: `lastCode` (the site), any `Checkpoint`, any `ProjectAsset`, the
  `ImportSource` row, `thumbnailUrl`, `previewUrl`, `designDirection` is copied but `phase` is
  not — so the duplicate falls to the schema default `PLANNING` (`schema.prisma:169`) with no
  `ProjectPlan` row at all. The user gets a project that is in the planning phase, has no plan
  to approve, and shows an empty preview. For a URL-import project the lost `ImportSource` also
  removes the source-URL link from the workspace top bar and makes the import unresumable.
  It is also the only project-creating action in the file that does not `writeAudit` — compare
  `createProject:193`, `deleteProject:414`, `restoreProject:442`.
- Trigger: **Duplicate** on any project.
- Impact: the action is named for copying and copies nothing but the prompt. It consumes a
  project slot from the plan limit (`:464`) to produce a shell, and it does so without an audit
  trail, contrary to AGENTS.md:51 which lists project changes as recorded.
- Confidence: Confirmed
- Suggested fix: decide which of the two products this is. If it is "duplicate the site", copy
  `lastCode` plus the latest checkpoint snapshot and set `phase: 'COMPLETE'`; if it is "start a
  new project from this prompt", rename it in the UI and say so. Either way add the
  `project.duplicate` audit row and copy `ImportSource` when one exists.

### F-806 [MEDIUM] Soft-deleting a project reports success when stopping its live deployments failed

- Area: P
- Location: `lib/projects/actions.ts:401-422` (catch at `:410-412`)
- What happens: `deletedAt` is stamped at `:401`, then `stopProjectDeployments(id)` runs inside
  a try whose catch does nothing but `console.warn` at `:411`. The action returns
  `{ ok: true }` at `:422` regardless. The same file imports `logError` at `:30` and uses it at
  `:77,594,596`, so the `console.warn` is not a convention — it is a gap: the failure reaches
  neither the user nor Sentry.
- Trigger: delete a published project while Coolify is unreachable, the token is expired, or
  the Coolify Integration is disconnected.
- Impact: the project disappears from the dashboard while its Coolify apps stay up, serving the
  deleted site on its live and preview hostnames and consuming a publish slot and server
  resources. Nothing will retry: the purge cron only runs after `PURGE_DELETED_DAYS` (30), and
  the row is already soft-deleted so no user-facing surface can reach it. A cost and a data
  exposure that is invisible by construction.
- Confidence: Confirmed
- Suggested fix: replace the `console.warn` with `logError` and return the failure to the caller
  as a warning field on the success payload (the pattern `persistProjectGeneration` already uses
  with `previewNotice`, `:613`), so the UI can say "deleted, but the live site could not be
  stopped". Better: enqueue the stop as a compensating job so it is retried.

### F-807 [MEDIUM] A generation whose checkpoint failed to write reports success

- Area: P
- Location: `lib/projects/actions.ts:561-611`; catch at `:601-603`
- What happens: on `generationStatus === 'ready'`, `createCheckpointAfterGeneration` (`:564`)
  and the preview build (`:570-591`) run inside one try whose catch is
  `console.error('[checkpoints] create after generation failed', error)` at `:602`. The action
  then returns `{ ok: true, data: project, previewNotice }` at `:613` with `previewNotice` still
  `null`, because the assignment at `:592` is inside the try that threw.
- Trigger: object-storage failure, gzip failure, or a plan storage-limit rejection inside
  `createCheckpointAfterGeneration`.
- Impact: the checkpoint is the source of truth for a project with no sandbox — AGENTS.md:55
  says so, and ZIP export, publish `collectPublishFiles`, and version restore all read it.
  A build that silently produced no checkpoint leaves the user with a project they cannot
  export, cannot publish from a snapshot, and cannot roll back, while the UI reported a clean
  completion. The preview build is skipped too, so the workspace shows the previous preview.
- Confidence: Confirmed
- Suggested fix: use `logError` (imported at `:30`) instead of `console.error`, and surface the
  failure through the `previewNotice` channel that already exists on the return value — assign
  the notice in the catch. The generation itself should stay successful; the user must simply be
  told the snapshot is missing.

### F-808 [LOW] `createProject` is not transactional, so a plan failure leaves an orphan project row

- Area: P
- Location: `lib/projects/actions.ts:125-191`; compensation at `:179`
- What happens: the row is created at `:125`, then `upsertImportSource` (`:141`),
  `applyCreateProjectPlanFlow` (`:166`) and `incrementUsageCount` (`:190`) each run outside any
  transaction. Exactly one failure mode is compensated: `ProviderNotConfiguredError` deletes the
  row at `:179` — and that delete itself is `.catch(() => undefined)`, so a failed cleanup is
  invisible. Every other throw from the plan flow re-throws at `:186` with the row already
  committed.
- Trigger: any plan-generation failure that is not `ProviderNotConfiguredError` — a provider
  429/5xx that exhausts failover, a Zod rejection of the model's plan JSON
  (`plan.ts:146`), a `createOrReuseJob` failure.
- Impact: an "Untitled project" corpse in PLANNING with no plan, counting against the plan's
  project limit (`:112`). The comment at `:174-178` shows the author reasoned about exactly this
  and fixed one case; the general case remains.
- Confidence: Confirmed
- Suggested fix: wrap creation and its dependents in `prisma.$transaction`, or move the
  detached-plan path (`:150-163`) to be the only path so the row is always created alone and the
  plan always fails asynchronously into the recovery panel that already handles it.

### F-809 [LOW] The project detail read returns the whole row while the list read deliberately narrows it

- Area: P
- Location: `lib/projects/actions.ts:351-362` vs `:251-262`; route `app/api/projects/[id]/route.ts:16`
- What happens: `listProjects` uses an explicit 10-field `select` (`:251-262`). `getProject`
  uses `include: { owner, importSource }` with no `select` (`:357`), so it returns every scalar
  on `Project` — including `lastCode` (the complete generated source of the site), `initialPrompt`,
  `model`, `previewUrl` and the lock fields — and it performs no ownership check, which
  `audit/04-security-data.md:104` accepted as "workspace-wide read by design".
- Trigger: `GET /api/projects/<any id>` as any signed-in member.
- Impact: not an access-control finding — cross-member read is intended, and `mine: false`
  (`:236`) confirms it. The finding is that the two reads disagree about _what_ is shareable:
  the list is curated, the detail is everything. Another member's full site source and prompt
  are one request away, which is more than the product's own list view is willing to show.
- Confidence: Confirmed
- Suggested fix: give `getProject` an explicit `select` covering what the workspace actually
  renders, and require ownership for the heavy fields (`lastCode`) or move them to the existing
  `GET /api/projects/[id]/files` route, which is the caller that needs them.

### F-810 [MEDIUM] `ProjectPlan.version` is computed outside its transaction and the column has no unique constraint

- Area: P
- Location: `lib/projects/plan.ts:404-426`; `prisma/schema.prisma:392-404`
- What happens: `:404-409` reads the current max version with a `findFirst` **outside** the
  transaction, then `:411-426` opens a transaction that supersedes pending plans and inserts at
  `version`. Two concurrent plan generations for one project both read the same max and both
  insert the same number. `model ProjectPlan` has `@@index([projectId])` and **no**
  `@@unique([projectId, version])` (`schema.prisma:403`), so Postgres accepts the duplicate
  instead of rejecting it.
- Trigger: two plan generations racing on one project — a refine and a follow-up, a retry
  arriving while the first is still running, or `refinePlan` from two tabs.
- Impact: duplicate versions make `orderBy: { version: 'desc' }` non-deterministic, and three
  places depend on it picking the right row: `approvePlan:570-573` chooses which plan to
  approve, `getLatestPlan:465-468` chooses what to display, and
  `lib/templates/actions.ts:134-138` chooses what to turn into a template (F-828). The
  `updateMany … status: 'PENDING' → 'SUPERSEDED'` at `:412-415` races too, so both plans can
  end up PENDING and `approvePlan` approves an arbitrary one.
- Confidence: Confirmed
- Suggested fix: add `@@unique([projectId, version])` and compute the version inside the
  transaction, retrying on the unique violation — or drop the counter and order by `createdAt`
  with the id as a tiebreak. The PLAN job already exists as a natural mutex; taking the project
  lock around plan generation would also serialise it.

### F-811 [MEDIUM] `approvePlan` gates on a read-then-write phase check, so a keyless double-approve charges two builds

- Area: P
- Location: `lib/projects/plan.ts:560-628`; route `app/api/projects/[id]/plan/approve/route.ts:10-11`
- What happens: the phase is read at `:560-563` and asserted `PLANNING` at `:566`; the pending
  plan is read at `:570`; only then does `:579-589` transactionally flip the plan to APPROVED
  and the project to BUILDING. Nothing links the check to the write — no row-count guard, no
  conditional `WHERE phase = 'PLANNING'`. Two concurrent approvals both pass `:566`, both
  commit, and both reach `createOrReuseJob` at `:597`. The only thing that stops a second BUILD
  job is `input.idempotencyKey`, which is optional and comes from the request body
  (`approve/route.ts:10`, defaulting to `undefined` when the body fails to parse). The UI does
  send one (`components/workspace/useProjectPlan.ts:149`), so the browser path is safe.
- Trigger: two direct `POST /api/projects/<id>/plan/approve` calls with no `idempotencyKey`, or
  any non-browser client.
- Impact: two BUILD jobs for one plan. `markJobRunning` charges credits at RUNNING, so the
  workspace is billed twice and two generations write `lastCode` for the same project
  concurrently. This is precisely the pattern AGENTS.md:68 forbids for job settling — "a lost
  write is the UPDATE row count … never a re-read of the row's status" — applied there and not
  here.
- Confidence: Confirmed (the race); Likely for the double charge, which depends on
  `createOrReuseJob`'s own read-then-create at `lib/jobs/lifecycle.ts:109-110`
- Suggested fix: make the phase transition the mutex — `updateMany({ where: { id, phase: 'PLANNING' } , data: { phase: 'BUILDING' } })`
  and treat a zero row count as the 409, exactly as the job layer does. Then the idempotency key
  is an optimisation rather than the only defence.

### F-812 [MEDIUM] Follow-up plans splice another project's chat messages in from a process-global

- Area: P
- Location: `lib/projects/plan.ts:270-297` (`recentFollowUpMessages`, `buildFollowUpPromptContext`);
  consumed at `:533`; writers at `app/api/generate-ai-code-stream/route.ts:485` and
  `app/api/conversation-state/route.ts:47,71,156`
- What happens: `recentFollowUpMessages()` reads `globalThis.conversationState.context.messages`
  and slices the last 20. That slot is a single process-wide variable overwritten on every
  generate request (route.ts:485) and on every workspace mount via `/api/conversation-state`
  (`:47,71`), with **no project id anywhere in the lookup**. `buildFollowUpPromptContext`
  (`:280-297`) then embeds those messages as "Recent messages:" in the plan prompt for whichever
  project called it.
- Trigger: user A generates or opens project X, user B requests a follow-up plan on project Y
  in the same server process.
- Impact: user A's prompt text is sent to the model as context for user B's plan, and the plan
  is shaped by requirements from a different project. In the other direction,
  `/api/conversation-state`'s `clear-old` sets the slot to `null` (`:156`), after which every
  follow-up plan silently loses its conversation context and nobody can tell. Phase 2 filed the
  memory-extractor consumer of this global (`audit/02-chat-images-preview.md:37-41`); the plan
  pipeline is a second, separate consumer and was not covered.
- Confidence: Confirmed (the unscoped read); the cross-project leak is live whenever two
  members share a process
- Suggested fix: `requestFollowUpPlan` already loads the project at `:512-515`; pass the
  project's own conversation through the existing per-project registry
  (`conversationStateFor(projectId, userId)`) instead of reading the global, and delete
  `recentFollowUpMessages`.

### F-813 [LOW] Production writes a test-only module global on every generation start, and exports a seam that can replace the plan generator

- Area: P
- Location: `lib/projects/plan.ts:74-75,86-88,236-241`; only consumer
  `scripts/verify-plan-build-fn.ts:11,131,198`
- What happens: `startLoggedGeneration` assigns `lastGenerationStart = input` (`:241`) on every
  initial and follow-up generation, holding `{ projectId, userId, promptContext, kind }` in
  module memory for the life of the process. `peekLastGenerationStart()` (`:236-238`) is read
  by nothing except an unwired acceptance script. Alongside it, `setPlanCompleter(fn)`
  (`:86-88`) is an exported production function that replaces the plan generator process-wide
  for all users (`completePlan:225-228`), documented at `:85` as an "acceptance-script seam".
- Trigger: every generation, for the global; the seam requires an in-process caller.
- Impact: the retained `promptContext` is the full user prompt plus the approved plan JSON, kept
  indefinitely with no bound — a small, needless retention of user content and a last-writer-wins
  value the script's own assertions would read wrongly under any concurrent traffic. The seam is
  a broader shape problem: a mutable global that swaps out an AI call for everyone is reachable
  from any module that imports this file.
- Confidence: Confirmed
- Suggested fix: delete `lastGenerationStart` and `peekLastGenerationStart`, and have the script
  assert against the `GenerationEvent` row that `startLoggedGeneration` already writes at
  `:242-247` — that is the durable record and it is per-project. Move `setPlanCompleter` behind
  a dependency parameter on `generatePlan` so the substitution is call-scoped.

### F-814 [LOW] A failed memory block is swallowed and the plan runs without Brain memory

- Area: P
- Location: `lib/projects/plan.ts:350-356`; rollback warnings at `:446`, `:544`, `:611`
- What happens: `buildMemoryBlock(projectId)` is wrapped in a try whose catch is
  `console.warn('[memory] plan block failed', error)` (`:354`), leaving `memoryBlock` as `''`.
  Both `buildStablePromptPrefix` (`:356`) and `buildPlanSystemPrompt` (`:358`) then build a
  prefix with no memory in it. Three other catches in this file do the same
  (`:446`, `:544`, `:611`) — one of them, `:611-616`, is a compensation failure that leaves the
  project "stuck in BUILDING" by its own comment and reports it only to stdout.
- Trigger: any failure inside `buildMemoryBlock`.
- Impact: memory is described as always-on and inside the cacheable prefix (AGENTS.md:61); when
  it silently vanishes, the plan is generated without the workspace's durable context and the
  prefix bytes change, so the prompt cache misses too. Neither the user nor Sentry learns why
  the plan ignored known context. The `:611` case is worse: the operator is told nothing about
  a project that can no longer leave BUILDING.
- Confidence: Confirmed
- Suggested fix: route all four through `logError` so they reach Sentry with the project id;
  for `:611`, also write a job step failure so `/admin/jobs` shows the stranded project rather
  than only stdout.

### F-815 [HIGH] Thumbs and revert signals are stamped with the currently active prompt version, not the one that produced the output

- Area: P
- Location: `lib/signals/collect.ts:83-103` (`recordRevertRate`), `:203-228` (`recordThumbs`),
  `:41` (the fallback), `:25-31` (`latestBuildEvent`)
- What happens: `latestBuildEvent` selects `promptVersion` (`:29`), and both collectors throw it
  away — `:85` and `:209` keep only `?.id`. Neither passes `promptVersion` to `writeSignal`, so
  `:41` (`data.promptVersion || (await stampActivePromptHash())`) stamps whatever version is
  active **at the moment the user clicks**. `maybeSettleFollowups` does it correctly
  (`:132`, `:148` pass `event.promptVersion`), and so does `recordSeoScore` (`:252`) and
  `recordCodeAuditSignals` (`:266`), which makes the omission an inconsistency rather than a
  design. `recordVisualEditRate` has the same hole on one branch: when `generationEventId` is
  supplied, `:176-177` fabricates `{ id, promptVersion: null }`, so `:193` yields `null` and
  `:41` substitutes the current version.
- Trigger: a thumbs-up/down or a version restore taken after any stack-prompt edit — and
  AGENTS.md:62 says such an edit rolls a new labeled version automatically.
- Impact: this corrupts exactly the two signals that carry human judgement. A thumbs-down on
  output from `v2` is recorded against `v3`, so `/admin/quality`'s per-version comparison
  attributes old failures to the new prompt and hides the new prompt's own results. It is the
  same defect class AGENTS.md:62 records as already fixed once ("prompt edits kept stamping
  generations with the stale version, so output changes were never attributable") — inverted,
  and still present on the feedback path.
- Confidence: Confirmed
- Suggested fix: pass `event.promptVersion` through in both collectors, exactly as
  `maybeSettleFollowups:132` does, and make `writeSignal`'s fallback a last resort that only
  applies when no generation event was found at all. On `recordVisualEditRate`, look the event
  up instead of fabricating it when an id is supplied.

### F-816 [MEDIUM] Every accessibility violation is scored as "moderate" because the production caller never passes the real axe results

- Area: P
- Location: `lib/signals/collect.ts:269-295` (fabrication at `:280-281`); caller
  `lib/audit/actions.ts:128-133`; weighting `lib/signals/score.ts:107-113`
- What happens: the a11y branch accepts either `axeViolations` (real impacts) or a bare
  `metrics.a11yViolations` count. When only the count is present, `:280-281` synthesises the
  violations: `Array.from({ length: n }, () => ({ impact: 'moderate' }))`. `a11yScoreFromAxe`
  then weights by impact (`score.ts:109-113`), so critical and serious violations are penalised
  as if they were moderate. The only production caller,
  `lib/audit/actions.ts:128-133`, passes `metrics` and `buildOk` and **never** `axeViolations`
  — so the synthesised path is the only path that ever runs. The `||` at `:269` compounds it:
  an empty `axeViolations: []` is truthy, so a run that found nothing because axe could not
  start is treated identically to a clean page.
- Trigger: every code audit.
- Impact: the `a11y_score` on `/admin/quality` is a count-based approximation presented as an
  impact-weighted score. A page with two critical violations scores the same as one with two
  moderate ones, so the metric cannot detect the regressions it exists to detect. Combined with
  F-705, `a11yViolations` is in practice always `0`, so the score is pinned at `1.0` anyway —
  but the fabrication is the defect that survives fixing F-705.
- Confidence: Confirmed
- Suggested fix: pass `scanned` axe results from `lib/audit/actions.ts` into
  `recordCodeAuditSignals` and delete the fabrication branch; if no real violation list is
  available, record no signal rather than a guessed one. Replace the `||` at `:269` with an
  explicit `!== undefined` test so an empty array is distinguishable from an absent one.

### F-817 [MEDIUM] The signal collectors run unbounded queries and sequential awaits that grow with project history

- Area: P
- Location: `lib/signals/collect.ts:61-80` (`hasSignal`), `:135-150`, `:156-168`
  (`settleIdleProjects`); render-path caller `lib/signals/metrics.ts:123`
- What happens: `hasSignal` issues `findMany` with **no `take`**, selecting `rawValue` for every
  `QualitySignal` row matching `(projectId, kind)`, then filters in JavaScript at `:77`. It is
  called up to three times per code audit (`:272,300,322`) and — worse — **inside the loop** at
  `:136-140`, so `maybeSettleFollowups` re-reads the project's entire `revert_rate` history once
  per event: O(N²) reads for N unsettled generations, with a `writeSignal` awaited serially
  after each (`:142`). `settleIdleProjects` (`:158-162`) then does the same at global scale: a
  `findMany` over **every** `GenerationEvent` ever written, `distinct: ['projectId']`, no date
  bound and no `take`, followed by a sequential `await maybeSettleFollowups` per project
  (`:163-165`).
- Trigger: `settleIdleProjects()` is awaited as the first statement of `getQualityDashboard`
  (`lib/signals/metrics.ts:123`), i.e. on every load of `/admin/quality`.
- Impact: the cost of an admin page load grows with total project count multiplied by each
  project's unsettled generation count, all serialised. Phase 7's F-732 already flags
  `/admin/quality` as the slowest page and notes the write-on-GET; this finding is the
  collector-side mechanism it did not open — the unbounded `findMany`s and the O(N²) inner
  loop live here, and they will also slow the audit path that calls `recordCodeAuditSignals`.
- Confidence: Confirmed
- Suggested fix: replace `hasSignal` with a targeted `findFirst` plus a `@@unique` on
  `(projectId, kind, generationEventId)` so existence is one indexed lookup and the insert can
  be an upsert; hoist the `revert_rate` lookup out of the loop into one `findMany` keyed by the
  event ids already in hand; bound `settleIdleProjects` by date and batch it, and move it off
  the dashboard render path onto a cron.

### F-818 [LOW] `revert_rate` records the failure on every restore but the success only after a 30-minute settle

- Area: P
- Location: `lib/signals/collect.ts:83-103` vs `:105-154` (`:124`, `:135-150`)
- What happens: `recordRevertRate` writes `value: 0` (`:99`) immediately on every restore
  (`lib/checkpoints/actions.ts:426`). The compensating `value: 1` for generations that were
  _not_ reverted is written only by `maybeSettleFollowups`, and only after `:124` confirms at
  least `SETTLE_MS` (30 minutes, `:14`) has elapsed since the last build. A project still being
  iterated on never satisfies that, and `:112` bounds the scan with `createdAt: { gt: after }`
  where `after` is the last settle timestamp — so events sharing that exact timestamp are
  skipped permanently.
- Trigger: any project under active iteration; every restore.
- Impact: for the projects that generate the most signal, the `revert_rate` population is all
  zeros and no ones, so the aggregate reads as though every generation was rejected. The metric
  is biased against the prompt version that happens to be active during heavy use — the
  opposite of what it is for.
- Confidence: Confirmed
- Suggested fix: write the paired `revert_rate: 1` at generation success time (the
  `persistProjectGeneration` "ready" branch already fires three detached collectors), and let
  `recordRevertRate` update it to 0 on restore — the update branch at `:89-93` already exists.
  Use `gte` with an id tiebreak at `:117` so equal timestamps are not dropped.

### F-819 [HIGH] A background audit that fails surfaces nowhere — the poller clears the error and stops the spinner

- Area: P
- Location: `lib/audit/actions.ts:196-218` and `lib/seo/actions.ts:192-214`;
  `components/workspace/useCodeAudit.ts:20-30,36-42` (and the identical
  `useSeoAudit.ts:20-30`)
- What happens: `runCodeAudit` / `runSeoAudit` return `{ ok: true, data: { scanning: true } }`
  (`audit:225`, `seo:221`) and let the scan run detached. When `performCodeAudit` throws, the
  `.catch` at `audit:205-213` does `console.warn` plus `failJob`, and the `finally` at `:214-218`
  removes the project from the `inflight` map. The client polls `getLatestCodeAudit`, whose
  `scanning` field is just `inflight.has(projectId)` (`audit:249`) — so the poll returns
  `{ audit: <previous row or null>, scanning: false }`, and `useCodeAudit.ts:27` executes
  `setError(null)` on every successful poll. There is no channel by which the background failure
  can reach `error`.
- Trigger: any throw inside `performCodeAudit` / `performSeoAudit` — a storage failure in
  `captureFileSnapshot`, an AI-review provider error, a `prisma.codeAudit.create` failure — and
  also a server restart mid-scan, which empties `inflight` with the same result.
- Impact: the user presses Scan, the spinner runs and then stops, and the panel shows the
  previous audit or "no audit yet" with no error and no explanation. Credits were already
  charged: `markJobRunning(..., { chargeCredits: true })` at `audit:181` / `seo:177` runs before
  the scan. So the failure mode is "paid, nothing happened, told nothing" — audit invariant 4
  (`audit/00-map.md:96`) and the `lib/notify.ts` convention (invariant 14) both point the other
  way. The only trace is `/admin/jobs` and stdout.
- Confidence: Confirmed
- Suggested fix: have the poll return the AUDIT job's terminal state alongside `scanning` — the
  job row already carries `errorCode`/`errorMessage` from `failJob` — and render it through
  `lib/notify.ts`. Stop clearing `error` unconditionally at `useCodeAudit.ts:27`; clear it only
  when a newer audit row actually arrives.

### F-820 [MEDIUM] "Fix" marks findings as fixed and logs a generation event before any generation has run

- Area: P
- Location: `lib/audit/actions.ts:315-318,342-347` and `lib/seo/actions.ts:311-313,338-343`;
  `markFixed` at `audit:280-291` / `seo:276-287`; client
  `components/workspace/CodeAuditPanel.tsx:170-172` (and `SeoPanel.tsx:145-147`)
- What happens: the server action builds the fix instruction, calls
  `startFollowUpGeneration` — which only writes `lastGenerationStart` and a `GenerationEvent`
  (`lib/projects/plan.ts:260-266`), it does not start anything — then calls `markFixed`, which
  stamps `fixed: true` on the findings, and returns the `promptContext`. The **client** starts
  the actual generation afterwards: `const result = await fixOne(id); … if (result.ok) onSend(result.promptContext, { mode: 'build' })`
  (`CodeAuditPanel.tsx:170-172`). So the findings are marked fixed before the build exists, let
  alone succeeds. `markFixed` also re-reads `latestRow` (`audit:281`), which may be a _newer_
  audit than the one `fixAllCodeFindings` selected from at `:335`, so the flags can land on a
  different row than the one whose findings were collected.
- Trigger: press Fix or Fix all, then let the build fail, cancel it, hit the credit limit, or
  close the tab between the action returning and `onSend`.
- Impact: the Quality panel says the issue is fixed while the code is untouched, and the next
  audit will re-report it as new — so the panel's state is not trustworthy on either side. The
  premature `GenerationEvent` also inflates `followups_to_settle` (`lib/signals/collect.ts:113-131`)
  and the usage-cost roll-up for a generation that never happened. `toggleIgnoreCodeFinding`
  (`audit:254-278`) shares the underlying weakness: it read-modify-writes the whole findings
  JSON with no optimistic concurrency, so two toggles lose one.
- Confidence: Confirmed
- Suggested fix: return the instruction without mutating anything, and stamp `fixed` from the
  generation-settled path once the follow-up build has actually written files — the settle path
  already knows the job and the project. Move the `GenerationEvent` write to the same place.
  Add `contentVersion`-style optimistic concurrency (the project already has one) to the
  findings-JSON updates.

### F-821 [LOW] Dead preview-URL work in both audit twins, and a deleted project is reported as a provider error

- Area: P
- Location: `lib/audit/actions.ts:81,98,104-110,199-203`; `lib/seo/actions.ts:79,88,93-99,195-199`
- What happens: both `perform*Audit` select `previewUrl` from the project (`audit:81`,
  `seo:79`), assign it to a local (`audit:98`, `seo:88`), and then unconditionally overwrite
  that local — in the try (`audit:104`, `seo:93`) or in the catch (`audit:109`, `seo:98`). The
  initial read is dead on every path, and it is the kind of dead assignment `no-unused-vars`
  would not catch and F-803 explains. Separately, `perform*Audit` returns `false` when the
  project row is missing (`audit:83`, `seo:81`), and the caller maps that to
  `failJob({ errorCode: 'provider_error', errorMessage: 'Audit did not run' })`
  (`audit:200-203`, `seo:196-199`).
- Trigger: every audit, for the dead assignment; deleting a project while its audit is queued,
  for the mislabel.
- Impact: minor but misleading in an operator surface — `/admin/jobs` attributes a
  deleted-project audit to the AI provider, which is where an operator would then go looking.
  The dead assignment invites the reader to believe `project.previewUrl` is a fallback when it
  never is.
- Confidence: Confirmed
- Suggested fix: delete the `previewUrl` column from both `select`s and the dead local; start
  from `null`. Add a distinct `errorCode` for "project no longer exists" rather than reusing
  `provider_error`.

### F-822 [IMPROVEMENT] `lib/seo/actions.ts` and `lib/audit/actions.ts` are a ~200-line copy of each other and have already drifted

- Area: P
- Location: `lib/seo/actions.ts:21-74,135-222,250-345` against
  `lib/audit/actions.ts:21-76,137-226,254-349`
- What happens: `ActionErr`/`ActionOk`, the `inflight` map, `unauthorized`/`notFound`/`forbidden`,
  `canMutate`, `requireActor`, `toPublic`, `latestRow`, `is*ScanInFlight`, the entire
  `run*Audit` job-and-lock scaffold, `getLatest*Audit`, `toggleIgnore*`, `markFixed`,
  `fix*Finding` and `fixAll*Findings` are duplicated near-verbatim. They have already begun to
  diverge cosmetically — `audit:75` is `return await Promise.resolve(...)`, `seo:73` is
  `return Promise.resolve(...)` — and functionally, since F-706 is a bug in the SEO twin's live
  fetch with no counterpart in the audit twin.
- Trigger: every fix to either file.
- Impact: F-819, F-820 and F-821 each had to be filed against both files, and each will need
  fixing twice. The next reader has no way to know which differences are intentional.
- Confidence: Confirmed
- Suggested fix: extract the shared scaffold — actor/gate helpers, the `inflight` registry, and
  a generic `runDetachedAudit({ kind, perform })` — into one module and leave each file with
  only its scan, its findings mapper, and its fix-instruction builder.

### F-823 [MEDIUM] `adminGenerateThumbnails` runs an unbounded loop of real project creations and real Coolify deploys inside one server action

- Area: P
- Location: `lib/templates/actions.ts:347-445`; loop `:362-432`; leak path `:408` → `:424-431`
- What happens: for every built-in template without a thumbnail (`:359`) the loop creates a real
  project via `createProject` (`:364-371`) — which runs the full plan flow, an AI call — then
  calls `publishProjectAndWait` (`:392-396`), a real Coolify deploy, then captures a thumbnail,
  then soft-deletes the project (`:423`). All of it sequential, all inside one server action
  that returns nothing until the last iteration finishes. The plan limit is checked once for a
  single project (`:351`) even though the loop creates one per template. Cleanup is on the inner
  paths but not the outer: if `updateTemplateRow` (`:408`) or anything else throws past the
  inner catch, control jumps to `:424-431` and **line 423's `deleteProject` never runs**, so the
  created project is leaked. `createProject` itself leaves an orphan row on most plan failures
  (F-808), which is a second leak source in the same loop.
- Trigger: press **Generate thumbnails** on `/admin/templates` with the ten seeded built-ins
  lacking thumbnails.
- Impact: ten sequential AI plan calls plus ten Coolify deploys in one request — far past any
  gateway or server-action timeout, so the operator sees a failure while the work continues and
  the results array is lost. Each iteration consumes credits and a publish slot, and leaked
  "Thumbnail <name>" projects accumulate (soft-deleted ones linger until the 30-day purge cron).
- Confidence: Confirmed
- Suggested fix: make this a job, not a server action — one `TEMPLATE_THUMBNAIL` job per
  template, enqueued and reported through `/admin/jobs`, which the code already half-uses at
  `:398-407`. Move the cleanup into a `finally` so the throwaway project is always removed, and
  check the plan limit per iteration.

### F-824 [MEDIUM] An admin cannot Test an inactive template — the action it delegates to requires `isActive`

- Area: P
- Location: `lib/templates/actions.ts:331-335` → `:95-118` (gate at `:103`);
  `lib/templates/visibility.ts:18`
- What happens: `adminTestTemplate` checks `requireAdmin` and then delegates verbatim to
  `createFromTemplate(id, {})`. That function's gate is
  `if (!row || !isVisibleToWorkspace(row, WORKSPACE_ROW_ID)) return notFound()` (`:103`) —
  called **without** `{ includeInactive: true }`, so `visibility.ts:18` rejects any row with
  `isActive === false`. Meanwhile `adminListTemplates` passes `includeInactive: true` (`:245`),
  so the admin table lists inactive templates and offers Test on them.
- Trigger: create or edit a template with `isActive: false`, then press Test.
- Impact: "Template not found" on a template the same screen is displaying — an error that reads
  as data corruption. Test-before-activate is the natural workflow and it is the one that does
  not work.
- Confidence: Confirmed
- Suggested fix: give `createFromTemplate` an internal variant that takes the visibility options,
  and have `adminTestTemplate` pass `includeInactive: true` — `getTemplate` already does exactly
  this at `:88-91` and is the precedent to copy.

### F-825 [LOW] Template update and thumbnail upload write no audit row while create and delete do

- Area: P
- Location: `lib/templates/actions.ts:289-312` and `:337-345`, against `:278-285`, `:320-327`,
  `:207-214`
- What happens: `adminCreateTemplate` (`:278`), `adminDeleteTemplate` (`:320`) and
  `saveProjectAsTemplate` (`:207`) each call `writeAudit`. `adminUpdateTemplate` — which can
  change the prompt, the slug, `isActive`, `isBuiltIn`, `workspaceId` and `sortOrder` — and
  `adminUploadThumbnail` write nothing.
- Trigger: any admin template edit.
- Impact: AGENTS.md:51 lists template changes among what `AuditLog` records. The mutation with
  the widest blast radius (rewriting the prompt behind a built-in template every future project
  is generated from) is the one with no trail, so `/admin/audit` cannot answer "who changed this
  template's prompt".
- Confidence: Confirmed
- Suggested fix: add `template.update` and `template.thumbnail` audit rows with `before`/`after`
  on the changed fields, matching the shape already used at `:278-285`.

### F-826 [LOW] Admin template writes skip the workspace filter that every read path applies

- Area: P
- Location: `lib/templates/actions.ts:294,317,340`; `lib/templates/store.ts:42-50`
- What happens: `adminUpdateTemplate`, `adminDeleteTemplate` and `adminUploadThumbnail` resolve
  the row with `findTemplateById(id)`, whose SQL is `WHERE id = $1` with **no** workspace
  predicate (`store.ts:47`), and then mutate it without calling `isVisibleToWorkspace`. Every
  read path does check: `listTemplateRows` filters in SQL (`store.ts:79`), and `getTemplate`
  (`:89`) and `createFromTemplate` (`:103`) re-check in JS.
- Trigger: an admin request naming a template id belonging to another workspace.
- Impact: none today — `WORKSPACE_ROW_ID` is a single constant row, so no second workspace
  exists to cross. Filed because AGENTS.md:42 states the invariant absolutely ("never leak
  another workspace") and the write paths are the ones that do not enforce it; the day a second
  workspace is introduced, the reads stay safe and the writes do not.
- Confidence: Confirmed (the missing check); impact contingent on multi-workspace
- Suggested fix: add a `workspaceId` predicate to `findTemplateById`, or wrap the three admin
  writes in the same `isVisibleToWorkspace(row, WORKSPACE_ROW_ID, { includeInactive: true })`
  check `getTemplate` uses.

### F-827 [LOW] A duplicate admin-supplied slug throws a raw Postgres unique violation out of the server action

- Area: P
- Location: `lib/templates/actions.ts:264,298`; `lib/templates/store.ts:38-40,108-135`;
  `prisma/schema.prisma:667`
- What happens: `Template.slug` is `@unique` (`schema.prisma:667`). `adminCreateTemplate` uses
  `data.slug || uniqueSlug(data.name)` (`:264`) and `adminUpdateTemplate` passes `data.slug`
  straight through (`:298`); the schema validates only the slug's _shape_
  (`lib/templates/schema.ts:26-32`), never its availability. `insertTemplate` is a raw
  `$queryRaw` INSERT (`store.ts:108`) with no conflict handling, so a collision surfaces as an
  unhandled Prisma error rather than an `ActionErr`. The generated fallback
  (`uniqueSlug`: slug + 3 random bytes, `store.ts:39`) makes accidental collision negligible —
  the exposed case is the admin typing a slug that exists.
- Trigger: create or rename a template using a slug already in use.
- Impact: every other validation failure in this module returns a typed `ActionErr` the UI
  renders; this one throws, so the admin gets a generic server-action failure with no indication
  that the slug is the problem.
- Confidence: Confirmed
- Suggested fix: check slug availability before insert/update and return a
  `{ ok: false, status: 409 }` naming the field, or catch the unique violation and map it to
  that same result.

### F-828 [LOW] "Save as template" can build its prompt from a superseded or rejected plan

- Area: P
- Location: `lib/templates/actions.ts:134-138,144-150`
- What happens: the project query takes `plans: { orderBy: { version: 'desc' }, take: 1 }` with
  **no** `status` filter, so it will happily return a `PENDING`, `SUPERSEDED` or rejected plan.
  That content is fed to `buildTemplatePromptFromProject` (`:145-150`) and its `summary` becomes
  the template description (`:156`). With F-810's duplicate versions, `version: 'desc'` is not
  even deterministic among same-numbered rows.
- Trigger: save a template on a project whose latest plan was refined (superseding the approved
  one) or is still pending.
- Impact: the template — reused by every future project created from it — is seeded from a plan
  the user rejected. Silent: the preview at `:152-162` shows the wrong prompt as if it were
  right.
- Confidence: Confirmed
- Suggested fix: filter `where: { status: 'APPROVED' }` and order by `createdAt` desc, matching
  `getApprovedPlanGenerationContext` (`lib/projects/plan.ts:664-667`), which is the existing
  correct precedent in the codebase.

### F-829 [MEDIUM] Glassmorphism is the de-facto default design style for almost every prompt, contradicting the documented `minimal` default

- Area: P
- Location: `lib/ui-ux-pro-max/build-design-brief.ts:157-168` (`pickBest`), `:35-43` (STYLES[0]),
  `:191-194`; documented default `lib/design/directions.ts:12`
- What happens: `pickBest` seeds `bestScore = -1` and advances only on strict `>` (`:162`).
  Every candidate scores `≥ 0`, so the first item wins any tie — and ties are the norm, because
  `scoreKeywords` only rewards literal keyword hits. `STYLES[0]` is Glassmorphism (`:36-43`),
  whose prompt mandates "Frosted glass cards, backdrop-blur 12-20px, translucent overlays". I
  replayed the real tables against realistic prompts: **6 of 7** landed on Glassmorphism —
  "a website for my restaurant", "a bakery site with a menu", "a portfolio for a photographer",
  "a landing page for a law firm", "a homepage for a plumbing company", "a site for a hair
  salon". The `fallbackIndex` parameter (`:157`) is dead: `best` is overwritten by `items[0]` on
  the first iteration regardless.
- Trigger: any prompt that does not literally contain a style keyword — i.e. most of them.
- Impact: the product ships one house style it never announces. `DEFAULT_DESIGN_DIRECTION` is
  `'minimal'` (`lib/design/directions.ts:12`) and AGENTS.md:47 says the PromptHero picker
  defaults to minimal, so the two style systems that both feed the same prompt disagree about
  the default, and the louder one wins silently. A bakery and a law firm get frosted glass.
- Confidence: Confirmed (replayed the scoring functions and keyword tables verbatim)
- Suggested fix: make "no match" explicit — return a neutral default (Minimalist, matching
  `DEFAULT_DESIGN_DIRECTION`) when the top score is 0, instead of falling out of a tie onto
  array position. Better: derive the style from `Project.designDirection`, which the user
  actually chose, and use keyword scoring only to refine it.

### F-830 [MEDIUM] Substring keyword matching picks palettes and typefaces from accidental letter sequences

- Area: P
- Location: `lib/ui-ux-pro-max/build-design-brief.ts:153-155`; keyword sets `:125` (`'ai'`),
  `:119` (`'home'`), `:127` (`'kids'`, `'fun'`), `:103` (`'flat'`)
- What happens: `scoreKeywords` scores with `text.includes(keyword)` — raw substring, no word
  boundary. Confirmed by replay:
  - "a site for a hair salon" → typography **Tech Startup** (Space Grotesk / DM Sans), because
    "h**ai**r" contains the keyword `'ai'` (`:125`).
  - "a homepage for a plumbing company" → palette **Real Estate** (navy + amber), because
    "**home**page" contains `'home'` (`:119`).
    `'ai'` also fires on "main", "retail", "training", "airline", "chair", "detail", "campaign" —
    a large fraction of ordinary English website copy.
- Trigger: any prompt containing a word that happens to embed a keyword.
- Impact: fonts and colour systems are assigned from letter coincidences, and the brief presents
  the result to the model as "the source of truth" (`:208`). The failure is invisible: the site
  generates successfully and simply looks wrong, with no signal that keyword matching misfired.
- Confidence: Confirmed (replayed the scoring functions and keyword tables verbatim)
- Suggested fix: tokenise the prompt and match whole words (`\b`-anchored, or a `Set` of
  tokens), and drop keywords shorter than three characters. Require a minimum score before
  accepting a non-default profile.

### F-831 [MEDIUM] Style and colour palette are chosen independently, so the brief can contradict itself

- Area: P
- Location: `lib/ui-ux-pro-max/build-design-brief.ts:191-194`, emitted at `:210-222`;
  conflicting data `:64-66` vs `:116`, and `:72-74` vs `:111`
- What happens: style, palette, typography and page structure are four independent `pickBest`
  calls with no compatibility check, and all four are emitted into one brief. Confirmed:
  "a minimal bank website" selects style **Minimalist** ("Swiss grid, generous whitespace …
  almost no shadows or gradients", `--shadow: none`, `:64-65`) _and_ palette **Fintech**
  (`background: '#020617'`, `foreground: '#F8FAFC'` — a dark palette, `:116`). The brief then
  adds "Cards: white or 6-8% tinted surface" at `:220`. The reverse pairing is equally
  reachable: style **Dark Mode** (`--bg: #0A0E17`, and its own `avoid:` line forbids "Pure white
  cards", `:73-74`) with palette **SaaS** (`background: '#F8FAFC'`, `:111`).
- Trigger: any prompt whose strongest style keyword and strongest palette keyword come from
  different rows — e.g. any "minimal"/"clean"/"dark" adjective plus an industry noun.
- Impact: the model receives two incompatible backgrounds and a card rule that fights both, in a
  block labelled "MANDATORY FOR THIS CREATION". Whichever it obeys, the other instruction is
  violated, and low-contrast text is the likely outcome — against the brief's own 4.5:1 rule at
  `:144`.
- Confidence: Confirmed
- Suggested fix: mark each palette light or dark and each style light, dark or either, then
  reject incompatible pairs by falling back to the style's own token set. At minimum, derive the
  surface/card guidance at `:220` from the selected palette's `background` rather than
  hardcoding "white".

### F-832 [LOW] The design brief forbids non-standard Tailwind classes and then requires them twelve lines later

- Area: P
- Location: `lib/ui-ux-pro-max/build-design-brief.ts:148` vs `:222`
- What happens: `UX_RULES` line `:148` states "Standard Tailwind classes only (bg-white,
  text-gray-900, bg-blue-600). No bg-background / text-foreground / bg-primary tokens." The
  colour section at `:222` states "Use these hex values in Tailwind arbitrary colors when needed
  (e.g. bg-[#2563EB])." An arbitrary-value class is not a standard Tailwind class. Both appear
  in the same generated brief — `:222` above, `:235` interpolating `UX_RULES` below.
- Trigger: every initial generation (both lines are in the non-edit branch).
- Impact: a direct contradiction inside a prompt block presented as authoritative. The model
  resolves it arbitrarily, so the palette selected by `:215-221` may be dropped entirely in
  favour of stock Tailwind colours — which would make the whole colour-selection system a no-op
  some fraction of the time, undetectably.
- Confidence: Confirmed
- Suggested fix: reword `:148` to name what it actually bans (shadcn semantic token classes,
  which generated projects have no CSS for) and explicitly permit arbitrary-value colour
  classes, so the two instructions agree.

### F-833 [MEDIUM] Three `heat-*` colour utilities resolve to nothing, including the shared Button's hover background

- Area: P
- Location: `tailwind.config.ts:7-14,273`; `colors.json` (`heat-90`); definitions
  `styles/design-system/colors.css:9-16,78-85`; call sites
  `components/ui/shadcn/button.tsx:66`,
  `components/app/(home)/sections/ai-readiness/MetricBars.tsx:25,168,180`
- What happens: `tailwind.config.ts:7-14` maps every key of `colors.json` to `var(--<key>)` and
  spreads them into the palette at `:273`, so a Tailwind utility exists for all 45 keys whether
  or not a CSS variable backs it. Cross-checking the 45 keys against every `--*` declaration
  under `styles/` and `app/globals.css` leaves **three keys with no definition anywhere**:
  `heat-90`, `accent-forest`, `accent-honey`. The heat scale defined in CSS is
  4/8/12/16/20/40/100/200 (`colors.css:9-16`) — there is no `--heat-90`, `--heat-50` or
  `--heat-150`. Live consequences:
  - `components/ui/shadcn/button.tsx:66` — `hover:bg-[color:var(--heat-90)]` on the shared
    shadcn Button: **every** such button's hover background is an undefined variable.
  - `MetricBars.tsx:25` — `bg-heat-90` for scores 60-79 renders no background.
  - `MetricBars.tsx:180` (`text-heat-50`) and `:168` (`text-heat-150`) name keys that are in
    _neither_ `colors.json` nor the CSS, so Tailwind never generates the class at all and the
    text falls back to inherited colour.
    Inversely, `--heat-200` is defined in CSS (`colors.css:16`) but absent from `colors.json`, so
    no utility exists for it.
- Trigger: hover any shadcn Button; load the public home page's AI-readiness section with a
  metric scoring 60-79, or read its Passing/Failing counters.
- Impact: silent visual regressions on the shared button component and the public home page. An
  invalid `var()` drops the declaration, and an ungenerated class emits nothing — so the build
  is green, editors autocomplete the class, and nothing anywhere reports it.
- Confidence: Confirmed
- Suggested fix: define `--heat-50`, `--heat-90` and `--heat-150` in
  `styles/design-system/colors.css` (both the sRGB and the display-p3 block) and add `heat-200`
  to `colors.json`; drop `accent-forest`/`accent-honey`, which nothing uses. Then add a unit
  test asserting the `colors.json` key set equals the `--*` set declared in `colors.css` — the
  drift is mechanically checkable and currently unchecked.

### F-834 [MEDIUM] `colors.json` exists twice, byte-identical, with two different importers

- Area: P
- Location: `colors.json` and `styles/colors.json` (byte-identical, 45 keys each);
  importers `tailwind.config.ts:5` and `components/shared/color-styles/color-styles.tsx:1`
- What happens: the two files are identical byte for byte. `tailwind.config.ts:5` imports the
  repo-root copy to generate the Tailwind palette; `color-styles.tsx:1` imports
  `@/styles/colors.json` to render the design-system colour reference. Neither re-exports the
  other; there is no generator and no test tying them together.
- Trigger: editing either file.
- Impact: two sources of truth for the token manifest with no drift detection. A token added to
  one gets a Tailwind utility but no swatch, or a swatch but no utility — which is exactly the
  shape of F-833. The duplication makes F-833 harder to spot and guarantees it recurs.
- Confidence: Confirmed
- Suggested fix: keep one file and import it from both places. Since `tailwind.config.ts` sits
  at the repo root and `styles/` is the design-system home, keep `styles/colors.json` and point
  `tailwind.config.ts:5` at it.

### F-835 [LOW] Five of seven Tailwind `content` globs point at directories that do not exist

- Area: P
- Location: `tailwind.config.ts:59-67`
- What happens: of the seven globs, only `./components/**` and `./app/**` resolve. `./pages/**`
  (`:60`), `./components-new/**` (`:63`) and the three
  `./styling-reference/ai-ready-website/**` entries (`:64-66`) name directories that are absent
  from the tree. Tailwind silently ignores non-matching globs.
- Trigger: every build.
- Impact: no missing styles today — the two live globs cover the source — but the config
  advertises a `pages/` router, a `components-new/` tree and a vendored styling reference that
  the project does not have, and every future reader has to check. If any of those directories
  is ever re-created for an unrelated reason it silently joins the scan.
- Confidence: Confirmed
- Suggested fix: delete the five dead entries. Also drop the now-inert
  `/* eslint-disable @typescript-eslint/no-require-imports */` at `:1` — the file's only
  imports are ESM (`:2-5`); the two `require()` calls at `:402-403` are inside `plugins` and
  would need the disable only if the rule were on, which F-803 shows it is not.

### F-836 [LOW] The custom centring utilities `parseInt` their size, so the non-numeric scale entries produce NaN or wrong offsets

- Area: P
- Location: `tailwind.config.ts:349-400`, values from `sizes` (`:16-37`)
- What happens: `matchUtilities` is given `{ values: sizes }` (`:399`), and `sizes` contains
  non-pixel entries — `max: "max-content"`, `unset`, `full: "100%"`, `inherit`, and the
  fractions `"1/2": "50%"` … `"5/6": "83.3%"` (`:23-35`). Each handler does `parseInt(value)`:
  `cw-max` yields `parseInt("max-content")` → `NaN` → `left: calc(50% - NaNpx)`, an invalid
  declaration that is dropped while `width: max-content` still applies, so the element sizes but
  does not centre. `cw-1/2` yields `parseInt("50%")` → `50` → `left: calc(50% - 25px)`,
  treating 50% as 50px. `mw`/`cmw` (`:377-397`) have the same flaw and are used nowhere.
- Trigger: using `cw-`/`ch-`/`cs-` with a non-numeric or fractional value. No current call site
  does — the six live usages are all pixel values (`cw-686`, `cw-768`, `cw-316`, `ch-470`,
  `ch-80`, `cs-10`), and all six work correctly.
- Impact: latent only. Filed because the failure is silent (one declaration disappears, the
  other applies) and the utility's name promises centring, so the next person to write `cw-full`
  will spend time on it.
- Confidence: Confirmed (the code path); no live call site is affected
- Suggested fix: pass a `type: ['length']` constraint to `matchUtilities` and restrict `values`
  to the numeric subset of `sizes`, so a non-length value produces no class rather than a
  half-broken one. Delete `mw`/`cmw`, which nothing uses.

### F-837 [MEDIUM] All five `verify-*` scripts write to and delete from the real `DATABASE_URL`, with no `TEST_DATABASE_URL` guard

- Area: P
- Location: `scripts/verify-plan-build.mjs:11-12,228-230`; `scripts/verify-plan-build-fn.ts:212-214`;
  `scripts/verify-projects-api.mjs:210`; `scripts/verify-projects-data.mjs:114`;
  `scripts/verify-usage-http.mjs:143-144`
- What happens: each script loads `.env` then `.env.local` with `override: true`
  (`verify-plan-build.mjs:11-12` and equivalents) and instantiates the generated Prisma client
  against whatever `DATABASE_URL` that yields — the developer's shared Postgres. None of them
  reads `TEST_DATABASE_URL`, and none checks that it is not pointed at a real database. Each
  then creates real `Project`, `ProjectPlan` and `GenerationEvent` rows and deletes them in a
  `finally`. The deletes are correctly scoped to ids the script collected, so there is no
  unscoped `deleteMany` — the blast radius is bounded to rows the script itself made.
- Trigger: running any of the five, which their own headers instruct
  (`verify-plan-build.mjs:5`: "node scripts/verify-plan-build.mjs").
- Impact: audit invariant 15 (`audit/00-map.md:107`) is "`TEST_DATABASE_URL` only". These five
  violate it. Even on the happy path they leave real `GenerationEvent` rows long enough to
  pollute `/admin/usage` cost roll-ups and `/admin/quality` signals; on a crash before an id is
  pushed, or a `SIGINT` mid-run, the rows persist. Per AGENTS.md:29-30 the database is shared
  across both working trees, so the damage is not even confined to the tree that ran the script.
- Confidence: Confirmed
- Suggested fix: have each script require `TEST_DATABASE_URL` and refuse to run without it —
  `scripts/ensure-test-db.ts` and `lib/verify/ensure-db.ts` already exist for exactly this — and
  assert the resolved URL is not equal to `DATABASE_URL` before the first write.

### F-838 [LOW] `verify-projects-data.mjs` tests a reimplementation of `duplicateProject` and asserts on a dropped column

- Area: P
- Location: `scripts/verify-projects-data.mjs:96-110` (assertion at `:109`)
- What happens: instead of calling `duplicateProject`, the script hand-builds the copy with its
  own `prisma.project.create({ data: { … } })` (`:96-105`) and then asserts
  `copy.initialPrompt === created.initialPrompt && copy.ownerId === other.id && copy.status === 'draft' && copy.sandboxId == null && copy.lastCode == null`
  (`:109`). Two problems. It verifies its own payload, so it cannot detect any regression in the
  production action. And `sandboxId` no longer exists — migration
  `20260819010000_drop_sandbox_columns` dropped it — so `copy.sandboxId` is `undefined`, and
  `undefined == null` is `true`: the clause passes vacuously and always will.
- Trigger: running the script.
- Impact: a check named "duplicate copies name + initialPrompt, new owner, draft" that tests
  nothing about duplication, and one of its five clauses is permanently true. It would not have
  caught F-805.
- Confidence: Confirmed
- Suggested fix: call `duplicateProject` through `runWithActor` (the sibling script's pattern)
  and assert on its return value; delete the `sandboxId` clause and add the assertions F-805
  needs — that `phase`, `lastCode` and the `ImportSource` are what the product intends.

### F-839 [LOW] `verify-plan-build.mjs` hand-copies the cost model, including the deleted sandbox charge

- Area: P
- Location: `scripts/verify-plan-build.mjs:14-26`, against `lib/usage-estimates.ts:5-27`
- What happens: the script re-declares `PLAN_GENERATION_ESTIMATE`,
  `FIRECRAWL_SCRAPE_ESTIMATE`, `E2B_SANDBOX_ESTIMATE` and `AI_GENERATION_ESTIMATE` (`:14-17`)
  and re-implements `calculateEventCost` (`:19-26`) — a duplicate of
  `lib/usage-estimates.ts:15-27`, already missing that module's `image` branch (`:19-21`). Both
  copies still add `E2B_SANDBOX_ESTIMATE` for a subsystem that no longer exists; F-750 covers
  the production copy, and this is a second instance of it.
- Trigger: running the script; and every edit to the real cost model, which will not reach here.
- Impact: a verification script whose expected values are computed by a stale fork of the code
  it is verifying. It will keep passing after the production model is corrected — the definition
  of a check that cannot fail for the right reason.
- Confidence: Confirmed
- Suggested fix: import `calculateEventCost` from `lib/usage-estimates.ts` (the `.ts` sibling
  `verify-plan-build-fn.ts` already imports from `lib/`) and delete the copy. Fix the shared
  model per F-750.

### F-840 [LOW] Two verify scripts default to `http://localhost:3000` — the other working tree's server

- Area: P
- Location: `scripts/verify-projects-api.mjs:4`; `scripts/verify-usage-http.mjs:12`
- What happens: `const BASE = process.env.VERIFY_BASE_URL || 'http://localhost:3000'` and
  `process.env.BASE_URL || 'http://localhost:3000'`. Both scripts then make real authenticated
  HTTP calls that create and delete projects.
- Trigger: running either from the primary checkout without setting the env var.
- Impact: AGENTS.md:26-34 documents two live servers — the primary tree on `:3001` and the
  `main` worktree on `:3000`. The default therefore points at the _other_ branch's server, so a
  script run to verify this tree exercises and mutates the other one, against the same shared
  database (F-837). The env var names also disagree between the two scripts, so there is no one
  variable to set.
- Confidence: Confirmed
- Suggested fix: require the base URL with no default and fail with a message naming the
  variable, or read `APP_URL`/`NEXT_PUBLIC_APP_URL` from the loaded env — which is per-tree and
  already correct. Use one variable name across both scripts.

### F-841 [MEDIUM] `packages/create-open-lovable` is not a workspace member and has zero references — a publishable CLI for the deleted sandbox

- Area: P
- Location: `pnpm-workspace.yaml` (no `packages:` key), root `package.json` (no `workspaces`
  field), `packages/create-open-lovable/package.json` (`bin` + public `publishConfig`);
  `lib/prompts.js`; `templates/e2b/README.md`
- What happens: a repo-wide grep for `create-open-lovable`, excluding the package itself and
  `audit/`, returns **0 matches** — no `package.json` script, no CI workflow, no Dockerfile
  reference. `pnpm-workspace.yaml` has no `packages:` key at all and the root `package.json` has
  no `workspaces` field, so pnpm never installs the package's dependencies and never links its
  `bin`; it cannot be executed from this checkout. Its content is built entirely around the
  removed subsystem: `lib/prompts.js` offers e2b/modal/daytona sandbox providers (only the e2b
  template exists), and `templates/e2b/README.md` documents E2B sandbox timeouts and a Python
  runtime that no longer exist anywhere in the product.
- Trigger: none — it is unreachable. The risk is publication or a manual `npx` run.
- Impact: this is the evidence for the "unreferenced" half of F-720, whose security findings
  (recursive `fs.remove` of a user-named directory at `installer.js:25-37`, plaintext API keys,
  `execSync` at `:75`) I re-read and confirm. Because the package declares a public
  `publishConfig` and a `bin`, an `npm publish` from this directory would ship a scaffolder for
  a deleted architecture, carrying that destructive path, under the project's name.
- Confidence: Confirmed
- Suggested fix: delete the directory. It documents an architecture the product removed, cannot
  run from this repo, and its only executable path is the one F-720 flags as destructive. If a
  scaffolder is genuinely wanted, start from the three real stacks in `lib/stacks/templates/**`
  in its own repository.

### F-842 [LOW] `pnpm-workspace.yaml` still pins Daytona SDK versions for a deleted sandbox provider

- Area: P
- Location: `pnpm-workspace.yaml` (`minimumReleaseAgeExclude`: `@daytona/analytics-api-client@0.205.0`,
  `@daytona/api-client@0.205.0`, `@daytona/sdk@0.205.0`, `@daytona/toolbox-api-client@0.205.0`)
- What happens: four `@daytona/*` packages at pinned version `0.205.0` are excluded from the
  minimum-release-age policy. Daytona was one of the three sandbox drivers
  (`e2b | modal | daytona`) removed with the sandbox subsystem; no source file imports any of
  them.
- Trigger: every `pnpm install`.
- Impact: install configuration carrying exceptions for dependencies the product no longer uses.
  Harmless mechanically, but it is one more surviving signal that the sandbox subsystem is
  current, and it will outlive anyone who remembers why the exclusion was added.
- Confidence: Confirmed
- Suggested fix: remove the four entries; if the packages are still in `pnpm-lock.yaml`, drop
  them from the dependency tree in the same change.

---

## 6. GAP

### F-843 [GAP] Nothing tests that the Tailwind colour manifest and the CSS variables agree

- Area: P
- Location: `colors.json`, `styles/design-system/colors.css`, `tailwind.config.ts:7-14`
- What happens: the config generates a utility per `colors.json` key on the assumption that a
  matching `--<key>` exists. That assumption is unverified, and it is currently false for three
  keys and false in the other direction for one (F-833). The check is a five-line set
  comparison.
- Trigger: adding a token to `colors.json` without adding the CSS variable, or vice versa —
  which is what already happened for `heat-90`, `accent-forest`, `accent-honey` and `heat-200`.
- Impact: F-833 shipped to the shared Button component and the public home page and would have
  been caught on the first run of such a test.
- Confidence: Confirmed
- Suggested fix: add `tests/unit/color-token-parity.test.ts` asserting that the `colors.json`
  key set equals the `--*` names declared in `styles/design-system/colors.css`, in both the
  sRGB and display-p3 blocks. The repo already uses this pattern for other invariants
  (`tests/unit/admin-nav-coverage.test.ts`, `tests/unit/client-import-boundary.test.ts`).

### F-844 [GAP] No test asserts the design brief's selectors behave sanely

- Area: P
- Location: `lib/ui-ux-pro-max/build-design-brief.ts:153-194`
- What happens: `buildUiUxProMaxBrief` shapes every generated site and has no test. F-829,
  F-830 and F-831 were all found by replaying the pure functions by hand — they are trivially
  testable and completely untested.
- Trigger: any edit to the keyword tables, the profile arrays, or `pickBest`'s tie-break.
- Impact: the default style, the keyword matcher and the style/palette compatibility are all
  free to regress silently, and their output is only visible as "the generated site looks
  wrong".
- Confidence: Confirmed
- Suggested fix: table-test `pickBest`/`pickStyle` over a dozen realistic prompts, asserting the
  default when nothing matches, whole-word matching, and that the selected palette's background
  lightness is compatible with the selected style.

---

## 7. IMPROVEMENT

### F-845 [IMPROVEMENT] `canMutate` and the actor/gate helpers are copy-pasted across five modules

- Area: P
- Location: `lib/projects/actions.ts:47-61`, `lib/projects/plan.ts:90-112`,
  `lib/audit/actions.ts:27-49`, `lib/seo/actions.ts:27-49`, `lib/templates/actions.ts:34-52`
  (and the inline equivalents at `lib/templates/actions.ts:142,191`)
- What happens: `unauthorized`/`notFound`/`forbidden`, `canMutate` and `requireActor`/`requireUser`
  are declared five times. `lib/templates/actions.ts` does not even use its local helper for the
  owner check — `:142` and `:191` inline `user.id !== project.ownerId && user.role !== 'ADMIN'`.
- Trigger: adding any new mutating action or route — the gate must be re-derived by hand each
  time.
- Impact: the authorization predicate for the whole product exists in six places. Phase 4 found
  a route where it was simply forgotten (`quality-signals`, `audit/04-security-data.md:689-693`),
  which is the natural consequence: there is no single definition to reach for.
- Confidence: Confirmed
- Suggested fix: one `lib/auth/action-gate.ts` exporting the four error constructors,
  `canMutate`, and `requireActor`, and have all five modules import it. A single definition is
  also greppable, which makes the next missing gate findable.

### F-846 [IMPROVEMENT] `getFileContents` is `async` with nothing to await

- Area: P
- Location: `lib/context-selector.ts:289-303`
- What happens: the function is declared `async` and returns `Promise<Record<string,string>>`
  but only copies fields out of the manifest already in memory (`:295-300`) — there is no I/O.
  It reads as though it fetches file contents from somewhere, which is what its name and its
  `Promise` return type advertise; it is a synchronous object copy.
- Trigger: reading the module; the misleading signature costs a reviewer an I/O trace that does
  not exist.
- Impact: cosmetic, and inside dead code (F-800). Recorded because the misleading signature is
  a residue of the sandbox era, when the contents genuinely came over the wire, and it is the
  kind of thing that gets preserved verbatim when someone revives a module.
- Confidence: Confirmed
- Suggested fix: delete with F-800.

---

## 8. What I could not read, and why

Nothing in the assigned set was left unread. Every one of the ~20 paths in §1 was read front to
back and has a verdict. Explicit boundaries on what that means:

1. **`packages/create-open-lovable/lib/installer.js` — read, but its security findings are not
   re-derived here.** F-720 already owns them; I re-read the cited lines (`:25-37`, `:75`) and
   confirm them rather than re-filing. The additional installer defects the scout proposed
   (path traversal, `execSync` cwd, fallback copy) are **not filed**: they are all reachable
   only by executing a package that cannot be executed from this checkout (F-841), and filing
   unverified severity against dead code would inflate the report. If the package is kept rather
   than deleted, it needs its own review pass.
2. **`colors.json` was read as data, not line by line.** All 45 keys, their `hex` and `p3`
   values, and their parity with every `--*` declaration under `styles/` and `app/globals.css`
   were checked programmatically; I did not eyeball 181 lines of hex pairs. The finding it
   produced (F-833) is exact.
3. **Three files adjacent to the assigned set were read only in the ranges a finding required**,
   and are marked as such rather than claimed as complete:
   `components/workspace/useCodeAudit.ts:1-48` (F-819),
   `components/app/(home)/sections/ai-readiness/MetricBars.tsx` (grepped for `heat-*` only,
   F-833), and `lib/audit/scan.ts:28-55` (F-705 confirmation). Their full verdicts belong to
   the phases that own them.
4. **No test suite, build, or lint run was executed** — this phase is read-only by instruction.
   Consequently every "Confirmed" here is confirmed _by source inspection plus replay of pure
   functions in isolation_, never by running the application. Where a conclusion depended on
   runtime behaviour I verified it against the actual dependency source instead of assuming:
   `postcss-js@4.0.1/parser.js:44-48` for numeric CSS serialisation (§4.3),
   `node_modules/tailwindcss/package.json` for the Tailwind major (§4.2). Findings whose blast
   radius depends on production concurrency — F-810, F-811, F-812, F-820 — are marked Confirmed
   for the code path and state their runtime dependency in the Trigger line.
5. **The inventory ledger is left as-is, deliberately.** `audit/_close-ledger.mjs:17-38`
   already anticipates this phase: it carries a `PHASE7_INCOMPLETE` set listing exactly the
   files assigned here and rewrites each matching row of `audit/00-inventory.md` to
   "partial in P7, re-read in full by P8 — 08-gap-closure.md". I did not run it. It writes
   `audit/00-inventory.md`, and the only file this phase is permitted to write is
   `audit/08-gap-closure.md`. So the ledger still reads `not fully read` for all 19 paths in
   that set until someone with write access to the inventory runs
   `node audit/_close-ledger.mjs`. One discrepancy to fix when they do: the set at `:18-38`
   names `packages/create-open-lovable/lib/prompts.js` but not the package's other five files,
   which §1 above also gives verdicts for.
