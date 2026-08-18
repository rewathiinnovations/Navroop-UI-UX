# End-to-end test & fix prompt

A self-contained brief for an agent that must exercise Navroop end to end, find every bug,
fix each one at the root, and prove the result — without coming back to ask questions.

Paste everything between the two `═══` rules into a fresh Claude Code session at the repo
root. Section 0 pre-answers every decision the agent would otherwise stop on; that section
is what makes the run follow-up free, so do not trim it.

═══════════════════════════════════════════════════════════════════════════════

# TASK — Full end-to-end verification and repair of Navroop

You are the sole QA + repair engineer for this application. Test it end to end the way a
real user would, find every defect, fix each one at its root cause, and prove the whole
application works. Run to completion autonomously. Do not stop to ask me questions — every
decision you might need is pre-answered in §0. Do not hand me commands to run myself; run
them yourself. Do not report success until §9's exit criteria are all satisfied.

Budget your effort for a long run. This is expected to take many hours of tool calls and
several dozen fixes. Working slowly and completely beats finishing early.

---

## §0 — Pre-answered decisions (read first; never ask about these)

| Question you might have | The answer |
| --- | --- |
| Which package manager? | **pnpm only.** Never `npm`, never `npx` — `npx` has corrupted `pnpm-workspace.yaml` in this repo. Use `pnpm exec` for binaries. |
| Can I restart the dev server on `:3000`? | **No.** One Next.js server is shared across parallel agents. If `:3000` answers, reuse it. If it does not, start it with `pnpm dev` and leave it running. Never kill it, never restart it, never `prisma generate` or replace locked Next/Prisma binaries unless you started the server yourself. |
| Can I touch other worktrees / branches? | **No.** Stay in this worktree, on this branch. Never `git checkout` a branch another agent may hold. |
| The database is down / empty. | Bring the app DB up with `pnpm db:up` (docker compose, host port `5433`). Prepare the test DB with `pnpm db:test`. Seed the admin with `pnpm db:seed`. These are setup, not product bugs — do them and note them. |
| Missing `.env`? | Copy `.env.example` → `.env` and fill the local values (see §1). Never invent or guess a real third-party API key. Leave provider keys empty and use the stubbing protocol in §2. |
| No AI/E2B/Firecrawl credentials in `.env`? | **The credentials live in the application database, and you are authorized to use them.** AI provider keys are `OrgApiKey` rows (saved via `/settings/api-keys` and admin) — generation reads them through the overlay in `lib/ai/effective-env.ts`, not `process.env` alone. Sandbox providers are `SandboxProviderConfig` rows (`/admin/sandbox-providers`); publish/deploy integrations are `Integration` rows (`/admin/integrations`). Do not copy any of these secrets out of the DB, print them, or write them to disk — use them only by driving the app. Real calls are allowed **within the §2 budget**; outside that budget, stub. |
| Should I run destructive admin actions? | **No.** Never run backup *restore*, deploy *rollback*, real deploys, DB drops, `purge-projects` against real data, or bulk deletes. Exercise their pre-flight/validation path, assert the confirmation UI, and list them in the report as "not executed — destructive". |
| Should I commit or push? | **No**, unless I explicitly ask. Leave the work in the working tree. Do not create a PR. |
| A test fails — can I skip it? | **Never.** No `.skip`, no `.fixme`, no `test.only`, no loosened assertion, no widened timeout to hide a race, no `--no-verify`, no `@ts-expect-error`/`any` to silence the typechecker, no snapshot update you have not read line by line. Fix the product. |
| Is a linter/type error a "real" bug? | Yes. It blocks `pnpm verify`, which is a required exit criterion. |
| The fix looks big. | If it is a genuine multi-day refactor, write it up per §7 and move on. Anything smaller than that: fix it. |
| Can I apply my own design judgment? | **Yes — deliberately.** You are authorized to elevate the UI/UX, motion, and polish of the whole app to lovable.dev-class quality (§4.6), and to raise the quality of the sites the app *generates* (§4.7). Constraints that survive this authorization: brand stays **Navroop**, default theme stays **light**, the studio/admin chrome's information architecture stays (elevate it, don't rearrange it), and every change flows through the design-system tokens — no one-off hardcoded values. §4.5 defines the defect audit; §4.6–4.7 define the elevation work. |
| Ambiguous expected behaviour. | Resolve it in this order: (1) an existing test's assertion, (2) `AGENTS.md` / `.cursor/rules/*.mdc` / `docs/`, (3) the code comment explaining the intent — this repo's comments state *why*, trust them, (4) the least surprising behaviour for a user. Record which rule you used. |
| Something is out of scope / blocked. | Do everything that is not blocked first. Then write the blocked item up with repro steps and a proposed fix. Never half-fix. |

**Read before you start:** `AGENTS.md`, `.cursor/lessons-learned.md`, `.cursor/README.md`,
`docs/deployment.md`. Append to `.cursor/lessons-learned.md` if I correct you mid-run.

---

## §1 — Environment bring-up

Do these in order and record the result of each.

1. `git status` — confirm a clean tree and note the branch. Anything already modified is
   pre-existing; do not attribute it to yourself.
2. Node/pnpm versions match `package.json` `packageManager` (pnpm 11.21.0).
3. `pnpm install --frozen-lockfile`. If the lockfile is stale, say so; do not silently
   regenerate it.
4. `.env` exists with, at minimum: `DATABASE_URL` (port 5433), `TEST_DATABASE_URL` (a
   *different* database name), `SHADOW_DATABASE_URL`, `AUTH_SECRET`, `NEXTAUTH_SECRET`,
   `NEXTAUTH_URL=http://localhost:3000`, `APP_URL`, `NEXT_PUBLIC_APP_URL` (same host as
   `APP_URL` — `assertInternalOrigin()` warns/refuses otherwise), `ENCRYPTION_KEY` (≥32
   bytes), `CRON_SECRET`, `SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD`, `STORAGE_DRIVER=local`.
5. `pnpm db:up`, then `pnpm exec prisma migrate status` — no pending or failed migrations.
6. `pnpm db:seed` — exactly one ADMIN exists.
7. `pnpm db:test` (creates + migrates `openlovable_test`).
8. `pnpm exec playwright install --with-deps chromium` if browsers are missing.
9. Confirm `:3000` is serving. Do not restart it if it already is.

Any failure here is an **environment defect** — fix it and record the fix so the setup is
reproducible, but count it separately from product bugs.

---

## §2 — Cost-control protocol (non-negotiable)

Real provider credentials are available in the application database (§0) and real calls
are **authorized — but budgeted**. The rule is simple: live calls are for *verifying
quality once*; stubs are for *everything repetitive*. Playwright suites, retries, and the
per-screen protocol run against stubs so that re-running them costs nothing.

**The live budget (hard caps — track a running count and stop at the cap):**

| Live activity | Cap |
| --- | --- |
| Full real journeys: dashboard prompt → plan → build → sandbox preview | 3 total across the run |
| §4.7 generated-site eval (stack × design direction) | 12 generations |
| Post-fix re-verification generations after §4.7 prompt changes | 6 |
| Sandbox boots (kill each sandbox as soon as its check is done — `/api/kill-sandbox`; idle reap is 5 min but do not rely on it) | 6 |
| Scrape/import from a real URL | 2 |
| Real publish/deploy | **0 — still forbidden.** Verify to the confirmation step only. |

Everything beyond the caps: stub these in the browser context before every navigation
that could trigger them
(`page.route(...)` fulfilling a JSON `503`, matching `e2e/journeys-workflow.spec.ts` —
**fulfil, never abort**: an aborted request surfaces as `TypeError: Failed to fetch`, which
the app reports as a crash and hides the real behaviour):

```
**/api/generate-ai-code-stream**   **/api/apply-ai-code-stream**   **/api/apply-ai-code**
**/api/create-ai-sandbox**         **/api/create-ai-sandbox-v2**   **/api/projects/*/plan**
**/api/projects/*/publish**        **/api/projects/*/import**      **/api/projects/*/export**
**/api/scrape-website**            **/api/scrape-url-enhanced**    **/api/scrape-screenshot**
**/api/install-packages**          **/api/install-packages-v2**    **/api/run-command**
**/api/run-command-v2**            **/api/admin/deploy**           **/api/admin/backups/run**
```

When creating projects for a test, use the API with `{ status: 'idle', skipPlanning: true }`
— `skipPlanning` prevents a **server-side** `generatePlan` that `page.route` cannot
intercept, and leaves the project out of `PLANNING` where the mode toggle is hidden.

Delete every project, invite, template, domain, and API key you create. Leave the database
in the state you found it, plus the seed data. Track created ids as you go so a crashed run
can still be cleaned up.

If verifying something would exceed a cap, **do not exceed it** — log the gap in the
report under "not executed — over live budget". Never use the live budget on a path a
stub can verify equally well, and never burn live calls reproducing a bug more than twice
— capture the failure output the first time.

---

## §3 — Phase 1: static baseline

Run each, capture the exact output of anything red, and fix nothing yet. You are building
the picture first so you can tell pre-existing breakage from breakage you cause.

```
pnpm exec tsc --noEmit
pnpm lint
pnpm test
pnpm build
pnpm test:e2e:critical
```

Also run, and read, the guard scripts that encode this repo's invariants:

```
pnpm exec tsx scripts/check-public-routes.ts
pnpm exec tsx scripts/check-destructive-migrations.ts
pnpm exec prisma validate
pnpm exec tsx scripts/secret-scan.ts
```

Record a baseline table: step → pass/fail → first failing assertion. Note flaky steps by
running any failure a second time before you believe it.

---

## §4 — Phase 2: drive the real application in a browser

Target `http://localhost:3000` with the browser tools.

**Per-screen protocol — apply all seven to every screen listed below.** A screen is not
"checked" until all seven are done:

1. Navigate and wait for the network to settle.
2. Read the **accessibility tree**, not just a screenshot — you are verifying structure,
   labels, and roles, not pixels.
3. Interact with every primary control: buttons, links, inputs, selects, dialogs, tabs,
   menus, and the empty/loading/error state of every async region.
4. Read the **browser console**: any error, unhandled rejection, React key warning, or
   hydration mismatch is a bug. So is a failed `<img>`/font/chunk load.
5. Read the **network log**: any 4xx or 5xx that the UI does not deliberately provoke is a
   bug. A page that renders while logging a 500 is a bug.
6. Test the failure path: submit the form empty, submit it with invalid data, and (where
   feasible) with the backing API stubbed to 500. The app must show a human message, never
   a raw stack, a blank screen, or a spinner that never resolves.
7. Reload the page and re-enter it by direct URL in a fresh tab (no client-side history).
   State that only exists after a client-side transition is a bug.

### 4.1 Unauthenticated surface

- `/` (landing), `/?auth=login` (the auth dialog), `/login`, `/signup`, `/reset-password`
- `/legal`, `/privacy`, `/terms`
- Auth cases: unknown email; correct email + wrong password; empty submit; whitespace-only
  input; extremely long input; SQL/HTML-looking input rendered safely; rate limiting
  (`tests/unit/login-rate-limit.test.ts` exists — confirm the UI surfaces it, not a 500);
  forgot-password → the email path (`RESEND_API_KEY` empty logs the mail to the server
  console — read it there); an expired/garbage reset token; reusing a consumed token.
- Signup when signup is disabled must return the disabled message, **not** a 401.
- Confirm every authenticated route redirects or 401s while signed out — check
  `/dashboard`, `/projects`, `/project/<any-id>`, `/settings`, `/admin`, `/builder`,
  `/deployments`, `/templates`, `/connectors`.
- Confirm no private data leaks in the HTML source of a signed-out page.

### 4.2 Authenticated surface

Sign in as the seeded E2E account. Seed and capture a session with
`pnpm exec playwright test --project=setup` (which uses `e2e/support/seed-account.ts` and
writes `e2e/.auth/user.json` — never commit it), or drive the real login form.

- **`/dashboard`** — the prompt box (`components/app/studio/PromptBox.tsx`). Verify:
  typed text survives draft hydration (`useDraftStorage` restores in a mount effect and has
  overwritten typed input before — see `tests/unit/draft-hydration-race.test.ts`); the
  "Create project" button enables/disables correctly; submitting routes to `/project/{id}`;
  `GET /api/projects/{id}` returns the *same* `initialPrompt`; recent projects list, search,
  and the empty state.
- **One full real generation journey** (uses the §2 live budget): submit a real prompt,
  let the plan generate, approve it, let the build run against a real sandbox, and watch
  the preview appear. Verify the streaming UX end to end (progress narrative, file
  reveal, error-free console), that generation is backgrounded via `GenerationProvider` —
  navigate away mid-build and back, the job must survive — and that the finished preview
  actually renders the generated site. Then kill the sandbox and delete the project.
  Repeat only if a fix touched the generation pipeline (max 3 total).
- **`/projects`** and its filters: `?starred=true`, `?mine=true`, `?mine=false`. Star and
  unstar. Rename. Duplicate. Delete, then confirm it is gone from the list *and* from the
  sidebar's recents. Confirm pagination/sort if present.
- **`/project/[id]`** — the workspace. Verify: the "Project name" textbox loads and saves;
  the "Chat mode" group toggles between `plan` and `build` with the pressed state moving,
  and that the toggle is hidden while a plan or build is running; the chat transcript,
  streaming region, and its error state; the file tree; the preview panel and its device
  sizes; `PageTabs`; checkpoints (list, bookmark, preview, restore, exit) — restore against
  a checkpoint you created; the job panel (retry / keep / start over / abandon); presence;
  the project lock and its release; assets upload/delete (`STORAGE_DRIVER=local` writes to
  `/public/uploads`); export and import entry points; SEO audit and code audit panels;
  quality signals.
- **`/project/[id]/domains`** — add a domain, see its status, delete it. Verification is a
  network call: stub it and assert on both the pending and failed rendering.
- **`/builder`**, **`/templates`** (open one, create a project from it, then delete both),
  **`/connectors`**, **`/deployments`**.
- **`/settings`**, `/settings/profile` (change name; change password with wrong current
  password, then correctly, then confirm re-login works), `/settings/api-keys` (create,
  copy, revoke — the secret must be shown once and never again), `/settings/skills`,
  `/settings/usage` (credits/consumption render, including at zero).
- **Session integrity** — sign out, then: press Back; open a stale tab and act in it; hit a
  deep authenticated URL. All must land on auth, never on stale data.
- **Deactivated user** — deactivate a second member from admin, then confirm their existing
  token is rejected (`getSessionUser` re-reads `isActive`, the `auth.ts` `jwt` callback
  strips the token).

### 4.3 Admin surface (`/admin` + 16 subpages)

`/admin`, `/admin/audit`, `/backups`, `/config`, `/deploy`, `/health`, `/integrations`,
`/jobs`, `/plans`, `/quality`, `/sandbox-providers`, `/servers`, `/team`, `/templates`,
`/usage`, `/workspace`.

- Each must render data or a genuine empty state. Never a raw error, never an unresolving
  spinner, never a table of `undefined`/`NaN`/`Invalid Date`.
- The admin shell is single-sourced — treat deviations as bugs: navigation only from
  `components/admin/admin-nav.ts` (`ADMIN_NAV`; pinned by
  `tests/unit/admin-nav-coverage.test.ts`), the section gated once in
  `app/(app)/admin/layout.tsx`, pages composed from `components/admin/` (`AdminPage`,
  `AdminCard`, `AdminTable`, `StatTile`, `StatusPill`, `StatusBanner`, `AdminTabs`,
  `Accordion`, `AdminIcon`, `ConfirmAction`). A page hand-rolling its own frame, table,
  tab strip, pill, or `window.confirm` is a §4.5 finding.
- `/admin/config` renders from `lib/settings/registry.ts`; resolution is DB → env →
  fallback (`lib/settings/resolve.ts`). Verify: an admin edit takes effect immediately;
  clearing hands the value back to env; secrets echo `last4` only; the per-group Test
  button (`lib/settings/test-group.ts`) keeps its `live` vs `local` distinction in the
  rendered copy — a presence check presented as a working key is a bug.
- Destructive admin actions must all flow through `ConfirmAction` (type-to-confirm via
  `confirmPhrase` where hard to undo) — a destructive button firing on one click is S1.
- Safe writes to exercise: connection-test buttons (sandbox providers, servers,
  integrations, templates, settings), credential save + validate + disconnect, invite
  creation and its reset link, member deactivate/reactivate, job abandon, plan edits.
- Credentials must round-trip **encrypted** (`ENCRYPTION_KEY`) and must never be echoed back
  in plaintext in an API response or in the DOM.
- **Not executed** (destructive): backup restore, deploy rollback, real deploy, bulk purge.
  Assert their confirmation UI and pre-flight validation only.
- Confirm `/admin/*` and `app/api/admin/**` are unreachable for a non-ADMIN member — check
  both the page and the API, since the proxy gate is coarse by design.
- `tests/unit/admin-nav-coverage.test.ts` pins the nav — if you add a page, that test must
  still pass.

### 4.4 Cross-cutting sweeps

- **Responsive**: 375×812 (mobile), 768×1024 (tablet), 1280×800. Re-walk dashboard,
  workspace, projects list, and two admin pages at each. Look for horizontal overflow,
  clipped or unreachable controls, and dialogs taller than the viewport.
- **Keyboard only**: tab through every dialog — focus must be trapped inside it, `Esc` must
  close it, and focus must return to the trigger. No positive `tabindex`. No control
  reachable only by mouse.
- **Accessibility**: run axe on every route in 4.1–4.3 (the pattern is in
  `e2e/journeys-critical.spec.ts`). Zero `serious` or `critical` findings. Fix contrast,
  missing labels, and heading-order breaks.
- **Copy**: English throughout, product named Navroop, no lorem, no `TODO`, no stray
  template literal, no untranslated key (`tests/unit/i18n-copy.test.ts` is the reference).
- **Theme**: light is the default; if a theme toggle exists, both themes must be legible.
- **Slow network / offline**: throttle and confirm loading states appear and resolve, and
  that an offline submit produces a message rather than a silent failure.

### 4.5 UI/UX quality sweep

This is an audit for **defects in the existing design**, not an invitation to redesign it.
The bar for "bug" here: a user would notice it, or two screens disagree with each other.
Brand stays Navroop, chrome stays as designed, the design system (`design-system/`,
`components/ui/`, `components/app/studio/`, `styles/`, `tailwind.config.ts`, `colors.json`)
is the source of truth — deviations from it are the bugs, not the system itself.

- **Consistency across screens**: buttons, form fields, dialogs, tables, badges, and empty
  states must come from the shared components. Flag any screen hand-rolling its own variant
  of an existing component, any one-off hardcoded color/spacing/font value where a token
  exists, and any icon used with two different meanings (or two icons for one meaning).
- **Visual defects**: misalignment within a row or form; inconsistent padding between
  sibling cards/sections on the same screen; text truncation without a tooltip or wrap;
  overlap at any of the three breakpoints; layout shift while async content loads (reserve
  space or skeleton it); images without dimensions causing jumps; z-index collisions
  (dropdowns under modals, toasts under dialogs); scrollbars appearing on content that fits.
- **Interaction feedback**: every clickable element has visible hover, focus-visible,
  active, and disabled states; every async action shows a pending state on the control that
  triggered it (and disables double-submit); every success and failure produces visible
  confirmation (toast, inline message, or state change) — silence after a click is a bug;
  destructive actions get a confirmation step naming the thing being destroyed.
- **Forms UX**: labels attached to inputs (not placeholder-as-label); inline validation
  errors next to the field, appearing on submit or blur — not only in a toast; errors clear
  when corrected; submit preserved input on failure (never wipe the user's typing);
  sensible autocomplete/type attributes (`email`, `new-password`, `current-password`);
  Enter submits single-field forms.
- **Navigation UX**: the current page is indicated in the sidebar/tabs; browser Back always
  works and never traps; page titles (`document.title`) are set per route and distinct;
  breadcrumb/back affordances inside deep flows (project → domains, settings subpages);
  external links marked and opening in a new tab; no dead links or links to unbuilt pages.
- **Content hierarchy**: exactly one `h1` per page, heading levels don't skip; the primary
  action on each screen is visually the primary button (one primary per view); dangerous
  actions styled as destructive, not primary; timestamps and numbers formatted consistently
  app-wide (same date format, same relative-time rules — `format-admin-date` /
  `format-relative-time` are the references); currency/credits shown with consistent
  precision.
- **Empty, loading, error triad**: every list/table/panel has all three states designed —
  an empty state that says what the thing is and how to create the first one (not just
  "No data"), a loading state that doesn't flash for cached loads, and an error state with
  a retry affordance where retry makes sense.
- **Micro-fit and polish**: favicons and meta present; no default-blue unstyled links in
  chrome; selection and scroll behaviour sane in the chat/streaming panes (autoscroll that
  stops when the user scrolls up); textarea resize behaviour intentional; long
  user-generated strings (project names, prompts, domains) tested at 100+ chars everywhere
  they render.

Severity mapping for findings from this sweep: broken feedback loops (silent failures,
missing pending states, lost form input) are **S2**; pure visual/consistency issues are
**S3**. They go through the same §6 definition of done — visual fixes still get a
regression test where one is feasible (axe rule, computed-style assertion, or a Playwright
assertion on the state change), and a §7 write-up where automated assertion is not.

### 4.6 Design elevation — bring the app itself to lovable.dev-class quality

This section authorizes taste. The reference bar is the current generation of AI-builder
products (lovable.dev, v0, bolt.new): interfaces that feel designed, not assembled —
confident typography, generous whitespace, purposeful motion, and zero dead moments.
Elevate; do not merely de-bug.

**Method — tokens first, screens second.** Make every improvement at the design-system
layer (`design-system/`, `styles/`, `tailwind.config.ts`, `colors.json`,
`components/ui/`, `components/app/studio/`) so it propagates, then sweep the screens for
places that bypass the system. A polish applied to one screen by hand is a defect under
§4.5; a polish applied to a token or shared component is the deliverable here.

Elevate, in this order:

1. **Typography & rhythm** — a deliberate type scale (display/heading/body/caption) with
   tightened letter-spacing on large sizes, `tabular-nums` on every metric/table, a
   consistent vertical rhythm, and real typographic details (proper quotes, non-breaking
   spaces before units). Body text never under 14px, line-height ≥1.5 for prose.
2. **Color & depth** — a disciplined neutral ramp; one accent doing real work; layered
   surface elevations (background → card → popover) distinguishable without borders alone;
   soft multi-layer shadows instead of single hard ones; subtle gradient or noise accents
   where the brand allows. All AA-contrast-checked, both themes if a toggle exists.
3. **Motion & micro-interactions** — this is where lovable-class products separate:
   - Page/panel transitions: 150–250ms opacity+transform (no layout-affecting animation);
     shared-element feel between dashboard → workspace where cheap to achieve.
   - Interactive elements: hover lift/tint, pressed scale (~0.98), spring-feel on toggles
     and the chat mode switch; focus-visible rings that match the accent.
   - Streaming chat: token-by-token rendering with a smooth caret, autoscroll that yields
     to the user, and a graceful settle animation when the stream completes.
   - Async affordances: skeletons shaped like the content (never spinners for lists),
     staggered entrance for list items (≤50ms stagger, capped), optimistic UI where the
     API allows, and progress that never jumps backwards.
   - Feedback: toasts that slide+fade with an icon and an undo where reversible; success
     micro-confirmation on saves (check morph, not just a toast).
   - **Every animation honors `prefers-reduced-motion`** and stays on compositor
     properties (opacity/transform). Add a lint or shared `motion` utility so this is
     enforced structurally, not by convention.
4. **Signature moments** — the three screens users judge the product by get extra care:
   the landing/auth screen, the dashboard prompt box (the "type an idea" moment —
   placeholder that inspires, subtle glow/focus treatment, satisfying submit), and the
   generation-in-progress view (live progress narrative, file-by-file reveal, preview
   materializing — this moment *is* the product; it must feel alive, not like a log dump).
5. **Perceived performance** — instant-feel navigation (prefetch on hover for sidebar
   links), no flash of empty content on cached data, font loading without FOUT/CLS,
   `next/image` everywhere a bitmap renders.

**Feedback-pattern inventory (app-wide).** Every screen in the app — studio, workspace,
admin, settings, auth — uses the matching pattern from this list wherever it applies, from
shared components, never hand-rolled per screen:

| Pattern | Use for | House implementation |
| --- | --- | --- |
| Toast / snackbar | Brief auto-dismissing feedback on a completed action | shared toast component (`components/ui/shadcn/toast.tsx` or successor) |
| Inline alert banner | Critical notices that stay until fixed/dismissed | `components/admin/StatusBanner` (admin), equivalent studio banner elsewhere |
| Notification center | Persistent history of async system updates | only if/when the product grows async notifications — do not invent one ad hoc |
| Progress indicator | Active async work on a control | busy labels + disabled state on the triggering button |
| Skeleton screen | Content loading — placeholders matching final geometry | `components/admin/AdminSkeleton` (`SkeletonStats/Table/Lines`); never bare "Loading…" |
| Empty state | Zero-data screens, with a next-step CTA | `AdminTable` `empty`, studio empty canvases |
| Infinite scroll loader | Long feeds appending on scroll | only where a list genuinely paginates |
| Global app spinner | Initial boot / auth checks only | never for in-page fetches |
| Confirmation modal | Destructive or irreversible actions | `components/admin/ConfirmAction` (with `confirmPhrase` when hard to undo); `window.confirm` is banned |
| Form leave dialog | Unsaved form input on tab close / refresh | `hooks/useUnsavedChangesWarning` |
| Error boundary | Client crashes → clean fallback + reload | `app/error.tsx` / `app/global-error.tsx` (already present — keep routes covered) |
| Breadcrumbs | Deep hierarchies | `AdminPage` breadcrumb; workspace top bar |
| Tooltip | Dense icons / shorthand needing unpacking | `title` today; a real tooltip component if hover-only ever blocks keyboard users |
| Slide-over drawer | Contextual edit without leaving the workspace | workspace panels; use for new contextual editors |

An interaction that produces **no visible feedback**, a fetch that renders **no loading
shape**, or a destructive click with **no confirmation** is an automatic §4.5 finding.

**Guardrails**: every §4.5 defect rule still applies to your own new work; axe stays at
zero serious/critical; Lighthouse (or equivalent) performance must not regress — measure
dashboard and workspace before and after; no new dependency heavier than ~10KB gzip for
motion (prefer CSS + the primitives already in the repo); nothing in the admin area gets
*less* dense or *less* scannable in the name of beauty.

Elevation changes are **S3-priority work executed after S0–S2 fixes are done**, but they
are in scope and required — the exit bar for this section is: a designer comparing this
app to lovable.dev would call the fit and finish comparable.

### 4.7 Generated-site quality — lovable.dev-class output

The product's real deliverable is the sites it generates. Their quality is controlled by
code in this repo, and that code is in scope:

- `lib/stack-prompts/` — `base-rules.ts` (the QUALITY/IMAGES block on every call),
  `shared.ts`, `seo-rules.ts`, and the six per-stack prompts (nextjs, react, astro,
  static-html, vue, svelte)
- `lib/design/directions.ts` — the six design directions (minimal, bold, premium,
  playful, editorial, technical): font pairings, radius/spacing scales, shadows, color
  guidance
- The `uiUxBrief` path through `buildVolatilePromptSuffix`, `lib/context-selector.ts`,
  the plan pipeline (`lib/projects/plan.ts`), and the templates in `/templates` + admin
  templates

**Audit and raise the bar**, holding the output rules to at least what lovable.dev ships:

1. Read every stack prompt end to end. Check the rules actually produce: hero sections
   with real visual impact (not centered-text-on-white), sticky/blurred navigation,
   purposeful section rhythm with alternating density, real footers, hover/focus states,
   scroll-reveal motion (with reduced-motion fallback), responsive images with explicit
   dimensions, semantic HTML, and the existing hard rules (no lorem, no emoji, tokens
   once, one h1, AA contrast, 375px no-overflow).
2. Strengthen what is missing. Candidate gaps to evaluate against the current rules:
   explicit hero art-direction guidance; motion/scroll-reveal rules (currently only
   150–250ms transitions); component variety pressure (so every site doesn't converge on
   the same three-card layout); typography pairing enforcement from the chosen design
   direction; dark-section contrast rules; CTA hierarchy; social-proof/testimonial
   patterns; form styling parity with the rest of the generated site.
3. Keep the prompt-size discipline the file comments demand — these blocks ship on every
   generation call, so every added line must earn its tokens. Tighten wording rather than
   append paragraphs.
4. Verify each design direction in `directions.ts` is genuinely distinct and each yields a
   coherent, current-feeling site — not six labels on the same output.
5. Update the templates so their baseline matches the new bar.

**Verification — static layer** (always): the six stack Playwright projects
(`journeys-stacks.spec.ts`) plus the unit suites around parsing/generation must stay
green; prompt changes are reviewed against the checklist above; `PromptVersion` is bumped
per the repo's convention so output changes are attributable.

**Verification — live eval** (authorized; uses the DB-saved keys through the app, §2
budget): run real generations from a standard test prompt ("a landing page for a local
coffee roaster") across stacks and design directions — spread the 12-generation cap to
cover all six stacks at least once and at least four different design directions. Open
each generated preview and hold it to §4.5's defect rules plus this section's bar:
screenshot each, grade it (hero impact, typography, motion, responsiveness at 375px,
console cleanliness, a11y), and include the grid in the report. Findings feed §6 as bugs
against the *prompt layer*; after fixing prompts, re-verify with the 6-generation
re-verification budget. Delete every eval project and kill every sandbox when graded.

---

## §5 — Phase 3: API and data-layer verification

`proxy.ts` denies everything under `/api` and `/preview-static` unless it matches
`lib/auth/public-routes.ts`. New routes are private by default; the gate only checks JWT
signature and expiry, so membership, project ownership, ADMIN role, and the `isActive`
check must live in the routes themselves. **Never weaken the gate to make something pass.**

Cover a sample from every group — `admin` (39 routes), `projects` (32), `cron` (16),
`integrations` (13), `auth` (9), `settings` (6), `github` (5), `templates` (4), `team` (3),
`legal`, `health`, `deployments`, `search`, plus the sandbox/scrape/generation singletons.

For each sampled route assert:

| Case | Expected |
| --- | --- |
| No session | JSON `401 { error: { message, code, requestId } }` — never an HTML redirect |
| Session, not a member / not the owner | Denied by the in-route check, with a 403/404 that does not confirm the resource exists |
| Session, non-ADMIN, admin route | Denied |
| Revoked / deactivated user's token | Denied |
| Malformed JSON body | 400 with a useful message, never a 500 stack |
| Missing required field | 400 naming the field |
| Wrong HTTP method | 405, not a 500 |
| Oversized or deeply nested payload | Rejected cleanly |
| `id` of another user's resource | Denied, not leaked |
| Cron route without `Authorization: Bearer $CRON_SECRET` | 401 — `authorizeCron` fails closed |
| Any error response | Carries a `requestId`, and the server log for it contains no secret (`tests/unit/logger-scrub.test.ts`, `sentry-scrub.test.ts`) |

Also verify:

- **SSRF guards** on every URL-accepting route (`scrape-*`, import, domains) — private IPs,
  `localhost`, redirect-to-private, and `file://` must all be refused
  (`tests/url-guard.test.ts`, `tests/integration/ssrf-counter.test.ts`).
- **Idempotency / races** on job routes: double-submit publish, retry a settled job, abandon
  a running job (`tests/integration/job-terminal-race.test.ts`, `job-settle.test.ts`).
- **Schema drift**: `pnpm exec prisma migrate diff --from-migrations prisma/migrations
  --to-schema-datamodel prisma/schema.prisma --exit-code` against the shadow DB — zero drift.
- **Migrations**: no pending destructive migration without `ALLOW_DESTRUCTIVE_MIGRATION`.
- **Orphan data**: creating and deleting a project leaves no dangling checkpoints, assets,
  jobs, domains, or ledger rows.

---

## §6 — Phase 4: fix every bug at the root

Work in strict severity order. Fix, verify, then move to the next — do not batch fixes
blindly across areas.

**S0 — data loss, auth bypass, secret leak, or corruption.** Stop everything else.
**S1 — a core journey is broken**: sign in, create project, workspace loads, admin loads.
**S2 — a secondary feature is broken** or throws in the console.
**S3 — accessibility, responsive, copy, or polish.**

**Definition of done for a single bug** — all six, every time:

1. **Reproduced deterministically.** Write the exact steps. If you cannot reproduce it
   twice, it is a flake — investigate the race, do not paper over it with a timeout.
2. **Root cause identified in source**, cited as `file:line`, with a sentence on *why* the
   code was wrong. "It works now" is not a root cause.
3. **Fixed at the root.** No swallowed exception, no `catch {}` that hides the failure, no
   defensive `?? []` that masks a broken query, no `any`, no assertion loosened, no timeout
   widened, no test skipped.
4. **Regression test added** that fails before the fix and passes after — Vitest under
   `tests/` (or `tests/unit` / `tests/integration`) for logic, a Playwright spec under
   `e2e/` for a journey. Follow the house rules: never assert on `page.url()`, a document
   title, or a status code alone; assert on markup only the correct screen renders.
5. **Both results shown**: paste the failing run before the fix and the passing run after.
6. **Affected suite re-run green**, plus a quick check that you did not break a neighbour.

Then re-run the phase the bug came from — fixes create new bugs, and a fix that changes
shared code invalidates screens you already cleared.

**Loop until zero.** Repeat §3 → §4 → §5 → §6 until a full pass produces no new findings.
Expect at least two full passes. Do not stop at the first clean-looking run.

---

## §7 — Anything you cannot fix

Only for a genuine blocker: needs a real third-party credential I have not given you, needs
production infrastructure, is destructive, or is a multi-day refactor. For each, write:

- What is broken, and the severity
- Exact reproduction steps
- Root cause as far as you traced it, with `file:line`
- The fix you propose, and why you did not apply it
- The blast radius of leaving it

Never half-fix. A partial fix that makes a symptom disappear is worse than a written-up bug.

---

## §8 — Phase 5: prove it

```
pnpm verify
```

That runs: typecheck → ESLint (`--max-warnings 0`) → public-route check → `prisma validate`
→ schema-drift → destructive-migration check → Vitest + coverage → `next build` → Playwright
`critical`. Every fatal step must be green.

Then the full sweep:

```
pnpm verify:full
```

which adds depcheck, knip, `pnpm audit --audit-level=high`, and the **entire** Playwright
suite (`critical`, `authenticated`, `full`, and the six stack projects: NEXTJS, REACT,
ASTRO, STATIC_HTML, VUE, SVELTE).

Rules for this phase:

- Report a step as passed only if you watched it pass. Never infer.
- If a non-fatal reporter (depcheck/knip/audit) flags something, triage it: fix what is
  real, and explain what you are leaving and why.
- Run the full Playwright suite twice to catch flakes. A test that passes only sometimes is
  a bug — fix the race, do not retry it away.
- `pnpm smoke` against `localhost:3000` as a last sanity pass (`SMOKE_URL`, `SMOKE_EMAIL`,
  `SMOKE_PASSWORD`; the unauthenticated probe is `SMOKE_AUTH_PROBE`).
- Leave the tree buildable and the dev server running.

---

## §9 — Exit criteria (all must be true before you report done)

- [ ] `pnpm verify` green, top to bottom, in one uninterrupted run.
- [ ] `pnpm verify:full` green, with any non-fatal reporter findings triaged in writing.
- [ ] Full Playwright suite green **twice** in a row.
- [ ] Every route in §4.1–§4.3 visited, with all seven per-screen checks done.
- [ ] The §4.5 UI/UX sweep completed on every route, with S2 feedback-loop defects fixed.
- [ ] §4.6 design elevation executed: tokens/motion/typography upgraded at the system
      layer, the three signature moments polished, reduced-motion honored everywhere, and
      performance measured as not regressed.
- [ ] §4.7 generated-site audit done: every stack prompt and design direction reviewed and
      raised to the bar, `PromptVersion` bumped, stack suites green; the live eval run
      within budget with the graded screenshot grid in the report.
- [ ] One full real generation journey (§4.2) completed clean end to end.
- [ ] Live budget respected: running tally reported, zero real publishes/deploys, every
      eval sandbox killed and every eval project deleted.
- [ ] Zero console errors, unhandled rejections, or hydration warnings on any route.
- [ ] Zero unexpected 4xx/5xx in the network log on any route.
- [ ] Zero axe `serious`/`critical` findings.
- [ ] Every §5 API case asserted for the sampled routes; the public allowlist unchanged, or
      changed with an explicit `reason` and `ownMechanism`.
- [ ] Zero skipped, `.fixme`d, or `.only` tests introduced; none pre-existing left unexamined.
- [ ] Every bug found has a root-cause fix **and** a regression test, or a §7 write-up.
- [ ] Database left clean: no leftover test projects, invites, domains, templates, or keys.
- [ ] Nothing committed or pushed.

---

## §10 — Report format

Deliver, in this order:

1. **Verdict** — one line: is the application working as expected, yes or no.
2. **Environment fixes** — what you had to set up, so it is reproducible.
3. **Bug table** — one row per defect:

   | # | Sev | Area | Symptom | Root cause (`file:line`) | Fix | Regression test | Status |

4. **Not fixed** — the §7 write-ups.
5. **Not executed** — destructive actions and cost-incurring paths you deliberately skipped,
   with what remains unverified because of it.
5b. **Design elevation summary** — before/after screenshots of the three signature moments
   and one admin page; the token-level changes made; the Lighthouse numbers before and
   after; the stack-prompt diffs with a sentence on what each raises in generated output.
6. **Verify output** — the `pnpm verify` and `pnpm verify:full` summaries, pasted verbatim.
7. **Coverage map** — every route from §4, marked checked / partially checked / not checked.
8. **Residual risk** — what you would test next with more access or budget.

Be blunt. If something is still broken, say so in the verdict line. A report claiming green
on a run that was not green is the single worst outcome of this task.

═══════════════════════════════════════════════════════════════════════════════

## Variants

**Fast smoke pass (~30 min)** — §0, §1, §2, then: sign in → dashboard prompt → project
workspace loads → one admin page → sign out. Then `pnpm verify`. Skip §4.4 and §5.

**Read-only audit (no fixes)** — drop §6; produce the §10 bug table with a proposed fix per
row and stop. Useful before a release when you do not want the tree touched.

**Single area** — keep every phase but scope §4 to one group (e.g. only `/admin/*` and
`app/api/admin/**`) and §8 to `pnpm test` plus the one matching Playwright project.

**Post-fix confidence run** — §3, §5, §8, §9 only. No exploratory browsing; you are
confirming a known-good state has not regressed.
