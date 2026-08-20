# Findings discovered while fixing

Anything found during implementation that the audit did not file. Same format as the phase files.
Ids are `N-001`, `N-002`, … so they cannot collide with the audit's `F-` range.

## Corrections to the audit's own artefacts (Wave 0)

These are defects in the audit output, not in the product. Recording them because `REPORT.md` is
now the document people will read, and it was wrong in three places.

### N-001 [MEDIUM] `REPORT.md` under-counted the findings by 13

- Location: `audit/REPORT.md` §2 severity table
- What happened: the table summed each phase agent's self-reported total. Phase 5b reported 41
  while `audit/05b-skills-memory.md` contains 54 finding headings.
- Verified: a mechanical parse of every `### F-nnn [SEV]` heading across all nine phase files
  yields **508 distinct findings, zero duplicate ids, zero malformed headings**
  (CRITICAL 8, HIGH 81, MEDIUM 237, LOW 96, GAP 43, IMPROVEMENT 43).
- Fix: `FIXES.md` is built from the parse, not the prose, and states the corrected count. The
  `REPORT.md` table should be corrected to 508 when that file is next touched.

### N-002 [LOW] `REPORT.md`'s HIGH table listed four findings above their filed severity

- Location: `audit/REPORT.md` §2 "HIGH (77)" table
- F-600, F-305, F-306 and F-447 are **MEDIUM** in their phase files; the coordinator's summary
  promoted them without saying so.
- Disposition: F-600 and F-837 are genuinely worth raising to HIGH and `FIXES.md` records the
  raise **with the reason** (a unit test that queries reaches the application database, which the
  ground rules forbid outright). F-305, F-306 and F-447 stay MEDIUM.

### N-003 [LOW] Two findings are the same defect filed twice under different ids

- `F-070` (Phase 1, area C) and `F-300` (Phase 4, area I) are both "provider API keys are stored
  in plaintext while sibling credentials are encrypted".
- `F-635` (Phase 6, area O) and `F-700` (Phase 7, area P) are both "`.npmrc` disables the pnpm
  build-script allowlist that sits next to it".
- Disposition: both pairs stay as separate rows in `FIXES.md` (the ledger is per finding id) with
  a `duplicate of` note, and one change closes each pair.

## Discovered while grounding the decisions (Wave 0)

### N-004 [HIGH] The encryption envelope has no version marker, so "legacy plaintext" and "wrong key" are indistinguishable

- Location: `lib/crypto.ts:16-23` (`encrypt` returns bare `base64(iv || authTag || ciphertext)`),
  consumed by `lib/api-keys.ts:65-72`
- Trigger: any stored secret that fails to decrypt — because it was never encrypted, **or**
  because `ENCRYPTION_KEY` changed, **or** because `getKey()` silently used `AUTH_SECRET`
  (F-715) on the write and `ENCRYPTION_KEY` on the read.
- Impact: this is the reason F-071 can hand ciphertext back as an API key — there is no way for
  the decoder to tell the three cases apart, so the only non-breaking choice available to it is
  to return the raw string. It also means the F-300 backfill cannot be made idempotent or
  verifiable without adding the marker first.
- Confidence: Confirmed — read both functions in full.
- Why it matters for sequencing: F-300, F-071 and F-715 cannot be fixed independently. The
  versioned envelope has to land first, in the same change, or the backfill is a future outage.
  Recorded in `DECISIONS.md` D2 and grouped in `G07-credential-storage`.

## Discovered while fixing (Wave 1–2)

### N-005 [MEDIUM] Two `'use server'` exports have no authorization gate at all

- Location: `lib/audit/actions.ts:74` `isCodeScanInFlight`, `lib/seo/actions.ts:72` `isSeoScanInFlight`
- Found by the F-613 authz-contract sweep: every other export in the ten action modules gates on
  session (401) and ownership/admin (403). These two take a `projectId` and answer without any
  check, so an unauthenticated caller has an activity oracle and a project-id enumeration probe.
- Status: pinned as `KNOWN_UNGATED` in `tests/unit/server-action-authz.test.ts`, so a new ungated
  export fails the sweep and gating these forces the pin's removal. Queued for Wave 3.

### N-006 [LOW] Two structurally parallel merge+sweep+bump writers now exist

- Location: `lib/jobs/settle-generation.ts` (success path) and `lib/jobs/recovery.ts` (keep path,
  rewritten for F-020)
- Both compose the same exported primitives (`getCurrentProjectFiles`, the NEED_IMAGE sweep,
  `bumpContentVersion`) because `settle-generation`'s own merge block is private. Not a defect —
  the duplication is the reason F-020 existed in the first place. Extracting one shared persist
  helper is the durable fix; deferred because it would edit the merge Wave 1 depends on.

### N-007 [MEDIUM] `getCurrentProjectFiles` still consults a sandbox-era global

- Location: `lib/github/current-files.ts:57-60` reads `globalThis.sandboxState.fileCache` before
  `lastCode`
- The sandbox subsystem was deleted (migration `20260819010000_drop_sandbox_columns`) and Wave 2
  removed the `conversationState` global, but this `sandboxState` reader survives. Nothing writes
  it today, so it is dead — but both the settle path and the F-020 keep path would merge over a
  stale cache if anything ever did. Belongs to the `G02-dead-code-sweep` group in Wave 3.

### N-008 [LOW] `.env` declares `APP_URL=:3000` while this checkout serves `:3001`

- Location: `.env` vs `AGENTS.md:26-28`
- Surfaced by the F-620 fix: "derive the checkout's port from env" is unreliable here, which is
  why the Playwright fix boots its own server rather than trusting a probe. Not fixed — `.env` is
  gitignored local state and correcting it is the owner's call.

### N-009 [HIGH] `toggleStar` had no ownership gate, and the Wave 2 authz sweep did not catch it

- Location: `lib/projects/stars.ts:14` (before this engagement's fix)
- Found while building the write side for F-402. `toggleStar` selected only `{ id: true }`, never
  compared an owner, and wrote a `ProjectStar` row for any project id a signed-in member could
  guess. It had zero callers, which is why the audit filed the surface as a dead end (F-402) and
  never examined the gate behind it.
- Why the sweep missed it: `tests/unit/server-action-authz.test.ts` (F-613, Wave 2) asserts the
  401 contract across all ten modules and the 403 contract on the functions it enumerates; it
  used `stars.getWorkspaceMeta` as a _positive control_ (a member is allowed) and did not
  enumerate `toggleStar` for the ownership case. A sweep that lists functions by hand inherits
  the author's blind spots.
- Fixed in the F-402 commit: `canMutate(user, ownerId)` copied from the sibling modules, 403
  before any write, covered by `tests/integration/project-stars.test.ts` (non-owner MEMBER
  refused, non-owner ADMIN allowed, no row written on refusal).
- Follow-up worth doing: make the authz sweep enumerate exports _mechanically_ (every function
  export in the module) rather than by hand-written list, so a gate-less export cannot hide
  behind an unlisted name. Recorded here rather than filed as a Wave 6 GAP because it is a
  strengthening of an existing test, not new capability.

### N-010 [MEDIUM] The `design` skill has F-504's defect in 47 documented invocations, and they are the paid ones

- Location: `.claude/skills/design/**` and `.cursor/skills/design/**` — 4 files, 47 invocations
- Found by Skills2 while fixing F-504 (`ui-ux-pro-max` invoking a script by an absolute
  `~/.cursor/...` path that does not exist in this checkout). The `design` skill repeats it
  verbatim. Not covered by anything already filed: F-508 (LOW) is only that the skill spends money
  on Gemini with no cost note, and F-506 (LOW) is committed `.pyc` files.
- Why it is worse than F-504: these are the Gemini image-generation commands, so the failure mode
  is an operator discovering the broken path mid-spend rather than on a free search.
- Disposition: assigned to Skills2 in-wave with the same `$SKILL_DIR` fix, byte-identity between
  the two trees, a zero-count guard (not a ratchet), and a real smoke-run. Recorded here so the
  extra scope is attributable rather than looking like drift.

### N-011 [MEDIUM] `no-unused-vars` was disabled repo-wide, so the verify gate was blind to dead code

- Location: `eslint.config.mjs` (the rule was `off`), surfaced when F-803 turned it to `error`
- Enabling it exposed **76 violations across ~25 files** plus **19 pre-existing errors from other
  rules** that `--max-warnings 0` had never reported, including `react/jsx-no-undef` in
  `app/(app)/admin/integrations/IntegrationsAdmin.tsx` and several `react-hooks` errors.
- This is the audit's own F-803 confirmed at scale, and it explains how several other findings in
  this audit survived: the gate that should have caught unused imports, orphaned state and dead
  handlers was switched off, so `pnpm run verify` passed over all of them.
- The 25 dead identifiers in `components/workspace/GenerationWorkspace.tsx` are deferred to
  Wave 5 (four agents were editing that file concurrently); the list is recorded in DeadCode2's
  report so they cannot hide again now that the rule is on.

### N-012 [LOW] A vendored skill script crashes on the default Windows console

- Location: `.claude/skills/design-system/scripts/search-slides.py` (and its `.cursor` twin)
- Resolves and runs correctly, then dies with `UnicodeEncodeError: 'charmap' codec can't encode
'\u2192'` when stdout is cp1252 — the Windows default, and this is a Windows checkout. Its
  sibling `ui-ux-pro-max/scripts/search.py` already wraps stdout in UTF-8 for exactly this reason,
  so the convention existed in-tree and this script missed it.
- Also found in the same pass: `design/scripts/cip/generate.py:430` _printed_ a hardcoded
  `~/.claude/skills/...` path as a user hint. A grep for invocations would never have found it,
  because the lying path was in output rather than in a command. Now derived from `Path(__file__)`.
- Fixed with the sibling's wrapper, mirrored byte-identically into both trees, smoke-run through
  both. Guard extended to ban any interpreter reaching a `.claude/skills` or `.cursor/skills` path
  in either tree, `~`-prefixed or bare, across .md/.py/.js/.cjs/.mjs/.sh/.ts.

### N-013 [HIGH] `checkLimit`'s default argument let every plan admit one over its ceiling

- Location: `lib/plans/limits.ts` — `checkLimit(..., upcoming = 0)`
- The default made the comparison `current + 0 <= limit`, so a plan with `maxProjects: 5` admitted
  a **sixth** project and `maxMembers: N` admitted **N+1**. Every caller that omitted the third
  argument was off by one, silently, in the customer's favour — which is why nobody noticed.
- Found while writing the F-307 concurrency proof: the first test run showed both concurrent
  reservations admitted _at_ the ceiling. The audit filed F-307 as check-then-act under
  concurrency and never noticed the ceiling itself was wrong even serially.
- Fixed by removing the default — `upcoming` is now required — and passing 1 at every converted
  site. `lib/templates/create.ts`'s deps signature and three calls in `tests/plans-limits.test.ts`
  updated; no other caller relied on the default.
- This is the second time this engagement that fixing a filed finding exposed a worse defect
  behind it (see N-009, `toggleStar`'s missing ownership gate).

### N-014 [process] My own handover diagnosis was wrong, and the agent caught it

- When `Credits` died at 66 minutes I inspected the tree and briefed its replacement that
  `lib/plans/actions.ts` was "mid-edit on F-311/F-312". It was not — both were complete and
  correct; only their tests were missing.
- The replacement was instructed to inventory before trusting the brief, did so, and reported the
  correction rather than redoing working code. Worth keeping as a pattern: a handover brief after
  a crash is a hypothesis, and the first task of the successor is to falsify it.

### N-015 [HIGH] Two mutating API routes had no ownership gate, found only by the mechanical sweep

- Location: `app/api/projects/[id]/quality-signals/route.ts`, `app/api/generate-ai-code-stream/route.ts` (~:345)
- Found by AuthzSweep after replacing Wave 2's hand-written authz enumeration with a mechanical one
  (F-313). Both are exactly what N-009 predicted: endpoints nobody thought to list, so nobody
  checked. The generate route is the credit-consuming one.
- Fixed in-slice; the sweep now fails on any new ungated export or route file, so this class cannot
  recur silently. Two hand-written enumerations (Wave 2's, and the audit's own 10-of-90 matrix)
  both missed these; a mechanical walk found them in one pass.

### N-016 [MEDIUM] Three more hand-rolled `role="menu"` popovers the audit did not list

- Location: `components/workspace/WorkspaceTopBar.tsx:446` and `:566`,
  `components/workspace/WorkspaceViewControls.tsx:105`
- Same defect as F-410 (no roving focus, no arrow keys, no focus move on open) in live workspace
  chrome rather than the account/admin surfaces the audit enumerated. `WorkspaceViewControls` uses
  `role="menuitemradio"` and is a clean port to a Radix `DropdownMenuRadioGroup`.
- Fixed in Wave 5 (W5-UX). All three now run on the shared Radix `DropdownMenu`: the tool menu and
  the compact page picker as `DropdownMenuRadioGroup`/`RadioItem`, the preview options and project
  actions as `DropdownMenuItem`. Both hand-rolled `mousedown`/Escape effects and their refs are
  gone, and the three menus share one `WORKSPACE_MENU_ITEM` class exported from
  `WorkspaceViewControls`.
  Verified on `:3001` for each of the three: opening moves focus into the panel, the items carry a
  roving `tabIndex` (`0` then `-1`…), ArrowDown/ArrowUp/Home/End move the highlight, keyboard
  selection switches the view (the trigger relabels to `Quality — more views`), and Escape closes
  and returns focus to the trigger. Tab stays inside the panel, which is correct for `role="menu"`
  — Escape, not Tab, is the exit — unlike the disclosure pattern `useDisclosurePopover` implements.
  The preview-options menu is disabled until a project has a preview build, so it was driven with
  the `GET /api/projects/:id/preview` response stubbed READY; the component was not modified for
  the test.
  `tests/unit/workspace-tabs.test.ts` was rewritten rather than dropped: the Radix panel is portaled
  and never appears in server markup, so the four tool views are now asserted on the element tree
  (each item's `value` and label, and the group's `onValueChange` reporting upward) instead of by
  substring — plus a source guard that neither workspace file declares a `role="menu"` again.

### N-017 [LOW] A moved test file left a stale registration that kept a guard red

- Location: `tests/setup/suites.ts:27` still registered `tests/logger-scrub.test.ts` after the file
  moved to `tests/unit/`, so `tests/unit/test-suites-reachable.test.ts` ("registers no suite that
  has been deleted") was RED in the working tree.
- Fixed by ObservA. Worth recording because the guard did its job — it caught a move that would
  otherwise have silently dropped a suite from the registered set.

### N-018 [LOW] Five scripts still document their own invocation with `npx tsx` / `pnpm exec tsx`

- Location: `scripts/{backup-db,pre-migrate,verify-storage,backfill-quality-signals,smoke-test}.ts`
- The same hazard F-644 and F-530 exist for (this repo bans `pnpm exec`; a real TTY would purge
  `node_modules` mid-command) but in script headers rather than docs, so outside both findings'
  scope. Reported by BackupOps rather than silently widened. Queued for Wave 5.
- Fixed in Wave 5: all five headers now say
  `node ./node_modules/tsx/dist/cli.mjs scripts/<name>.ts`, the form the git hooks and every
  `verify` step already use. `tests/unit/script-invocation-docs.test.ts` walks every file under
  `scripts/` and fails on `npx`, `pnpm exec` or `pnpm dlx` anywhere in it, so the next script
  added cannot reintroduce either runner. `pnpm run <alias>` is left alone: it names a
  `package.json` entry rather than resolving a binary, and `migrate-test-db.ts` and
  `verify-bypass.ts` legitimately point at their own alias.

### N-019 [MEDIUM] A sixth hand-rolled modal outside F-407's list leaks focus

- Location: `components/layout/CommandPalette.tsx`
- Leaks Tab into the sidebar behind it and never `aria-hide`s the background. F-407 enumerated five
  modals; this is a sixth with the same defect, and it is mounted globally from `app/providers.tsx`,
  so it is reachable on every authenticated page.
- Found by A11yModals while porting the five; left unfixed because it was outside the finding's
  scope and in another owner's file mid-wave. Queued for Wave 5 — the fix is the same
  `StudioModal`/Radix shell the other six now use.
- **FIXED (Wave 5, W5-Preview).** Ported to `StudioModal`, which gained a `placement: 'top'`
  variant for the palette's position. The five `paletteView` states, the `role="alert"` failure row
  and the `signedOut` state (F-425) are untouched. Verified live on `:3001`: Ctrl+K opens with focus
  on the search input, 22 Tab/Shift+Tab presses never left the dialog, the sidebar `<aside>` holding
  the trigger carries `aria-hidden="true"` while open and loses it on close, Escape returns focus to
  the exact element that opened it, and Ctrl+K still toggles.
- Found on the way: the panel had **no background at all**. `CommandPaletteProvider` is mounted from
  `app/providers.tsx`, outside `.studio-shell`, so every `var(--studio-*)` in its markup resolved to
  nothing and Chrome dropped the declarations. The ported panel carries `studio-portal`, which is
  exactly what that class exists for (`components/app/studio/studio.css:1-9`); the panel now computes
  `rgb(255, 255, 255)`.

### N-020 [process] An agent disproved its own hypothesis and reverted cleanly

- A11yModals suspected a focus-restore defect in `components/ui/StudioModal.tsx`, A/B tested both
  implementations against the live server on `:3001`, disproved it, and reverted the file to
  byte-identical so it carries no diff.
- Recorded because it is the behaviour this engagement wants: the alternative — leaving a
  speculative "fix" in place because it was already written — is how a codebase accumulates changes
  nobody can justify. Three agents did this class of thing (also PreviewDisplay on F-142 and
  DeadCode2 on F-800), and in each case the negative result was worth more than a diff.

### N-021 [CRITICAL] `POST /api/generate-ai-code-stream` had no ownership gate

- Location: `app/api/generate-ai-code-stream/route.ts` (~:345, before the fix)
- The generation endpoint was **session-gated only**. `readGenerationProjectId` took `projectId`
  straight from the request body and `getSessionUser` was the only check. Any signed-in MEMBER
  could name another member's project id and:
  1. spend workspace credits through `checkCredits`,
  2. take the owner's project lock via `holdProjectLock`,
  3. open a Job against their project, and
  4. settle generated code onto its `lastCode` — the exact write `persistProjectGeneration`
     (`lib/projects/actions.ts:593`) already refuses for a non-owner.
     So the persist layer defended the project while the route that drives it did not.
- Found by the mechanical authz sweep built for F-313, on its first run. Two hand-written
  enumerations had missed it: the audit's own 10-of-90 matrix, and Wave 2's hand-listed sweep.
- Fixed: `project.findFirst {id, ownerId}` → 404, then non-owner-and-non-ADMIN → 403, placed
  **before** the rate limiter, the credit check and the lock. Proven: a non-owner MEMBER used to
  reach the rate limiter (429); it now gets 403 with the submit counter at 0, so nothing is spent.
  Owner and non-owner ADMIN still reach 429 as a positive control.
- Why this is the engagement's most important find: it is the third and worst instance of one
  pattern — F-402/N-009 (`toggleStar`), N-015 (two mutating routes), and now the credit-consuming
  generation endpoint. Every one was invisible to a hand-maintained list and visible immediately to
  a filesystem-derived one. Authorization coverage is now 17/17 `'use server'` modules (was 10) and
  114/114 mutating endpoints (was 10), with both directions asserted so a new endpoint fails the
  gate rather than slipping through.

### N-022 [HIGH] `tsc --noEmit` never typechecks any test file, so the gate is blind to test-only type errors

- Location: `tsconfig.json` `exclude` contains `tests`
- The verify gate's typecheck step — the one this engagement has relied on 40+ times — does not see
  `tests/**` at all. A test that imports a non-existent module, or calls a signature that changed
  under it, passes `tsc` silently and only fails later at vitest collection. With ~350 test files
  and 3,297 tests, that is a large unchecked surface.
- Found twice independently in one session, from opposite directions: UxStateA could only typecheck
  its own new tests by building a throwaway tsconfig, and W6-Improvements found an unresolved test
  import via knip after un-ignoring `tests/**` (F-791) that `tsc` had not reported.
- Partial mitigation landed: F-791's knip change gives the gate its only static view of test-file
  imports. The real fix — including `tests` in the typecheck — was deliberately NOT attempted here:
  Next 16 generates route types and `AGENTS.md` documents a specific include/exclude workaround via
  `types/next-env.d.ts`, so changing `exclude` is an owner decision, not an IMPROVEMENT row.
- Recommended: a separate `tsconfig.test.json` extending the base with `tests` included, run as its
  own verify step. That gets the coverage without perturbing the app's route-type resolution.

### N-023 [LOW] `components/shared/tabs/Tabs.tsx` has no importer, so F-443's fix is on a dead component

- Location: `components/shared/tabs/Tabs.tsx`; F-443 asked for tab semantics on it
- No file in `app/`, `components/`, `lib/` or `hooks/` imports it (grepped for the path, the
  basename and every `from '…tabs'` form; the only hit is `components/ui/shadcn/tabs.tsx`, which is
  the unrelated Radix wrapper). It also paints in the Firecrawl token set (`bg-white-alpha-72`,
  `text-accent-black`, `bg-border-faint`), which is the family F-448 is about.
- F-443 was still landed as filed — the semantics are real, and deleting a component is a different
  disposition from fixing it. Flagging for **F-448**'s owner: this file belongs in the same
  unreferenced-marketing sweep, and if it goes, F-443's fix goes with it harmlessly.

### N-024 [LOW] The GitHub connect popover in `WorkspaceTopBar` has the same focus hole as N-016, as a `role="dialog"`

- Location: `components/workspace/WorkspaceTopBar.tsx` — the `connectOpen` panel (`role="dialog"`,
  a paragraph plus a "Go to Connectors" link)
- N-016 named the two `role="menu"` popovers in this file, and those are now Radix. The third
  popover in the same header still runs the hand-rolled `mousedown` + Escape effect it always had:
  opening it does not move focus into the panel, Escape closes it but drops focus on `<body>`
  instead of returning it to the trigger, and tabbing out leaves it open behind the page.
- It is a mixed-content panel, not a command list, so the fix is `useDisclosurePopover` (three
  lines) rather than a DropdownMenu — the same port Wave 4 did for the account popovers.
- Fixed in Wave 5 (W5-UX), same pass, after W5-Preview closed N-019 for `CommandPalette` and handed
  this one back as the owner of the file. Now on `useDisclosurePopover`: `rootRef` carries
  `onBlurCapture`, the trigger takes `triggerRef` and `aria-controls={connectPanelId}` (`useId`),
  and the panel becomes `role="group"` with `aria-label` and that id — the `role="dialog"` was wrong
  anyway, since nothing about it was modal. The third and last document-level
  `mousedown`/`keydown` listener in this file is gone with it.
  Verified on `:3001` (GitHub is CONNECTED in this workspace, so the panel only renders once
  `githubConnected` is flipped to `false` in the route's flight payload — the server response was
  stubbed, the component was not touched): opening moves focus into the panel onto "Go to
  Connectors"; Escape closes and `document.activeElement === trigger`; tabbing past the panel closes
  it (`aria-expanded="false"`, zero panels) instead of leaving it open behind the page. Tab-closes is
  the disclosure contract, and is deliberately the opposite of the `role="menu"` panels beside it,
  where Tab stays inside and Escape is the exit.
  Guarded by a new case in `tests/unit/workspace-tabs.test.ts`: `WorkspaceTopBar` must import the
  hook and must contain no `document.addEventListener('mousedown'` / `('keydown'` — so every popover
  in this header keeps delegating its keyboard contract.

### N-025 [LOW] `DropdownMenuRadioItem`/`CheckboxItem` indicators are positioned for the rem Tailwind scale

- Location: `components/ui/shadcn/dropdown-menu.tsx:99-137`
- Stock shadcn geometry (`pl-8 pr-2`, indicator `absolute left-2 h-3.5 w-3.5`, `Circle h-2 w-2`)
  assumes the default rem scale. This repo's Tailwind is px-based, so that is a 2 px dot 2 px from
  the item's left edge — invisible, and sitting inside the padding gutter.
- Found on becoming the primitives' first caller (N-016; they had zero call sites before). Worked
  around locally: the workspace menus hide the indicator span and signal selection with weight,
  colour and `aria-checked`, which is what the hand-rolled markup did.
- The wrapper itself was left alone — it is shared, and its `DropdownMenuItem`/`Content` defaults
  carry the same rem/Firecrawl assumptions (`bg-white`, `hover:bg-black-alpha-3`, `rounded-sm`), so
  correcting it is a design-system pass rather than a one-line fix.

### N-023 [MEDIUM] `/admin/servers` reports Coolify as "not configured" when the token merely cannot be decrypted

- Location: `getDeploySettings` reads `Boolean(creds.token)` (legacy deploy panel), while
  `lib/coolify/servers.ts` already carries the correct `tokenUnreadable` shape.
- Found by W5-Deploy after landing F-252. An undecryptable `AppSetting` Coolify token is now
  correctly _preserved_ on save rather than silently overwritten — but the admin panel still shows
  `configured: false`, so the operator is told Coolify was never set up when in fact a token is
  stored and only unreadable (rotated `ENCRYPTION_KEY`, most likely).
- This is the exact lie F-212 fixed for the Integration store path, surviving on the legacy
  AppSetting path. The recurring shape of this whole engagement: **absent and unreadable are not
  the same state, and collapsing them sends the operator after the wrong incident.**
- Not fixed: distinct from F-252's two halves, so W5-Deploy correctly declined to widen scope.
  `getStoredCoolifySettings` now exposes the flag, so wiring the panel is small. Queued.

### N-026 [process] A fixed finding came back on `main` while its fix was in flight on the branch

- Location: `components/workspace/SeoPanel.tsx` / `components/workspace/CodeAuditPanel.tsx` —
  `SeverityBadge`, as it arrived on `main`. Guard: `tests/unit/audit-fix-not-a-claim.test.ts:92`.
- F-820 removed a `fixed && status !== 'pass' → "Fixed"` badge because nothing verifies a fix:
  `fixSeoFinding` / `fixCodeFinding` only ever record `fixRequestedAt`, which the call site
  already renders honestly as a separate `FixRequestedPill`. `main`'s branding pass rewrote the
  same component from the pre-fix source and brought the claim back with it.
- Caught only because a mechanical test asserts findings never carry `fixed`. No human noticed it
  in review on either side, and the merge would have shipped it silently — "take `main` for design
  tokens" is the right default and this hunk looked exactly like one.
- **Why the guards exist.** Two branches editing the same file for months means a fix is only as
  durable as the assertion pinning it. Prose in a commit message, a finding marked closed in a
  ledger, and a reviewer's memory all failed here; a four-line test did not. Every fix that
  removes a false claim should leave behind an assertion that the claim is gone — otherwise the
  next rewrite of that component silently restores it.
- Reverted in the merge resolution: `SeverityBadge` keeps `main`'s `StatusPill` presentation and
  the branch's prop shape, with no `fixed` prop. Recorded rather than buried, because the value
  here is the pattern, not the one badge. See N-027 for the same pattern with a WCAG floor.

### N-027 [HIGH] `main` shipped a WCAG AA regression against a contrast test it already had

- Location: `components/app/studio/studio.css` — the `--studio-accent` ramp, as it arrived on
  `main`. Guard: `tests/unit/studio-contrast.test.ts`.
- `main`'s branding pass moved `--studio-accent` from `#c92a4e` to heat `#fa4500`. Measured
  against the AA floor of 4.5:1, on `--studio-cta-fg` `#ffffff` and `--studio-bg` `#f7f7f8`:
  - base/branch `#c92a4e` — **5.35 / 5.00 PASS**
  - `main` `#fa4500` — **3.55 / 3.32 FAIL**
- **No orange in `styles/design-system/colors.css` clears it.** The whole heat ramp, computed:
  `--heat-100` `#fa5d19` 3.16 / 2.95; `--heat-200` `#ff6600` 2.94 / 2.74; `--heat-50` `#c74a12`
  4.75 / 4.44 — the closest, and it still misses the second axis by 0.06.
- `studio-contrast.test.ts` exists **unchanged on `main` and at the merge base**. `main` never
  touched it. So `main` was **red on its own gate** before this merge: it regressed an
  accessibility floor against a test it was already carrying, and the pass evidently never ran
  the suite. The branch's only change to that test was a regex fix so it could still find the
  declaring rule after the tokens moved onto the `.studio-shell, .studio-portal` selector list —
  a fix that made the guard work, not one that loosened it.
- Two authorities collide here, and they are genuinely incompatible: this test, versus
  `.cursor/rules/brand-theme.mdc:12` and `.cursor/skills/ui-ux-pro-max/SKILL.md:50`, the latter
  saying in as many words "Never rose `#c92a4e` or a rainbow CTA". A test beats documentation, and
  the substantive reason is that the test encodes an accessibility floor affecting every user
  while the rule encodes a hue preference stated as a prohibition. Relaxing the test would have
  converted a visible regression into an invisible one.
- Resolved in the merge: the accent ramp (`--studio-accent` / `-hover` / `-soft` / `--studio-ring`,
  light and dark) reverts to rose; `main`'s orange `--studio-cta-gradient` is **kept**, since no
  test pins it and the rule's "no rainbow CTA" half is satisfiable even when its hex half is not.
  All four ramp tokens moved together because they are one hue decision — reverting only the base
  would leave a rose button with an orange hover and focus ring.
- **The real fix is mechanical, and it is a design decision, not a merge one.** An accent needs
  relative luminance **L ≤ 0.162** to clear 4.5:1 on both `#ffffff` and `#f7f7f8`. `#c74a12` sits
  just above that line. A slightly darker orange in the same hue family clears both axes *and*
  satisfies the brand rule; picking it is a one-commit revert of this entry.
- Distinct from F-769, which pins `design-system/MASTER.md` to citing the `--heat-` token and
  `#fa5d19` (`brand-authority.test.ts`, green) and says nothing about `--studio-accent`.
