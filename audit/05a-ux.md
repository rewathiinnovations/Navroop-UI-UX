# Phase 5a — Section K: UX, errors, accessibility

Scope: `audit/_scope-p5-ux.txt` (364 files). Every file in the list was opened; the
ledger at the end records a verdict per file. Finding ids **F-400 … F-499**.

Nothing in scope was modified. Files outside the scope list (`components/workspace/**`,
`app/project/**`, `lib/**`, `tests/**`, `proxy.ts`) were read only for context and are
cited as _related files_.

---

## Summary

The notify discipline is, on the whole, real: 40+ call sites go through `lib/notify.ts`,
`fetchJson`/`toMessage` are used consistently, and the toast-vs-inline split is documented
per call site (`AuditAdmin.tsx:42-46`, `dashboard/page.tsx:99-101`, `TeamTable.tsx:45-48`).
There is exactly **one** raw `confirm()` left and **zero** raw `alert()`. The real damage
is elsewhere:

1. A stylesheet rule deletes the focus ring from every `input[type="text"]` in the app.
2. Six client dashboards wrap their loader in `try/finally` with **no `catch`**, so a
   failed fetch renders as a healthy, empty installation.
3. Two shipped features are dead ends: **Starred projects** (no way to star) and the
   workspace sidebar's **scrape options** (`isValidUrl` is never set true).
4. `/builder` is a shipped dead demo page that fabricates a hardcoded HTML site and toasts
   "Website generated successfully!" — gated and currently unreachable, so it lies only to
   whoever revives it.
5. No route segment in the app has `loading.tsx`, `not-found.tsx`, or its own `error.tsx`.
6. Every hand-rolled modal and `role="menu"` popover lacks focus containment; `tabIndex`
   appears exactly once in 364 files and `aria-live` appears exactly once.

---

## Findings

### F-400 [HIGH] Global CSS deletes the focus ring from every `input[type="text"]`

- Area: K
- Location: `styles/main.css:277-283` (loaded by `app/globals.css:1`); victims include `app/(app)/admin/config/ConfigAdmin.tsx:105-120`, `app/(app)/admin/team/InviteMember.tsx:175-182`
- What happens: The last rule in the global stylesheet is
  `input[type="text"]:focus, input[type="text"]:focus-visible { outline: none !important; box-shadow: none !important; border-color: inherit !important; }`.
  The comment says "Remove all focus styles from hero input", but the selector is
  unscoped. Tailwind renders `focus-visible:ring-2` as a `box-shadow`, so
  `box-shadow: none !important` wins over every studio field's ring, and
  `border-color: inherit !important` kills the border fallback too.
- Trigger: Tab to any `type="text"` input. Concretely: `/admin/config` renders
  `type={secret && !revealed ? 'password' : setting.kind === 'number' ? 'number' : 'text'}`
  (`ConfigAdmin.tsx:107-109`), so every non-secret, non-numeric setting field has no
  visible focus. Same for the "Name (optional)" field in the admin invite dialog.
- Impact: WCAG 2.4.7 (Focus Visible) failure on admin configuration and the invite flow.
  A keyboard operator editing encrypted credentials cannot see which field is focused.
- Confidence: Confirmed
- Suggested fix: Scope the rule to the hero input it was written for (a class or an id),
  or delete it and give the hero its own `focus-visible` treatment. Drop the `!important`
  on `box-shadow` entirely — it is the mechanism every studio field uses for its ring.

### F-401 [LOW] `/builder` is a dead demo page that would report a fabricated site as a success

- Area: K
- Location: `app/builder/page.tsx:35-206`, especially `:39-41`, `:188-199`; gate at `proxy.ts:147-150`; related `lib/projects/start-from-prompt.ts:14-23`
- What happens: The route builds a hardcoded `mockGeneratedCode` string — the comment reads
  "For demo purposes, we'll generate a simple HTML template. In production, this would call
  the actual scraping and generation APIs" (`:39-40`) — renders it in an iframe from a blob
  URL, and calls `notify.success('Website generated successfully!')` (`:199`). There is no
  `fetch` and no `/api/` reference anywhere in the file. The "Download Code" button hands
  the user that same template as `website.html` (`:208-219`). It still paints in the retired
  Firecrawl token set (`bg-background-base`, `text-heat-100`).
- Trigger: **Currently none.** Three separate things have to be wrong for a user to see it,
  and all three are shut:
  1. _Auth._ Corrected from my first filing — the page **is** gated, and I was wrong to call
     it unauthenticated. `proxy.ts` never names `/builder`; the gate is by omission.
     `PUBLIC_PAGES` is `new Set(['/', '/login', '/signup'])` (`proxy.ts:9`), and
     `if (!session && !PUBLIC_PAGES.has(pathname))` redirects to `loginModalHref(next)`
     (`:147-150`) for every other page caught by the catch-all matcher (`:161`). Hence the
     observed `307 → /?auth=login&next=%2Fbuilder`. Worth noting for Section I rather than
     here: this page gate tests `hasSessionCookie(request)` — cookie presence only — where
     `guardApi` decodes and verifies the JWT.
  2. _Navigation._ Nothing links to it. Grepping `builder` across `app/`, `components/` and
     `lib/` returns only unrelated hits: the metadata string in `app/layout.tsx:36`, two
     prose comments (`GenerationWorkspace.tsx:387`, `useGenerationJob.ts:19`), Dockerfile
     stage names in `lib/deploy/repo-files.ts:79`, and a local variable in
     `lib/stack-prompts/index.ts:42`.
  3. _Its own precondition._ The page bails immediately when `sessionStorage.targetUrl` is
     absent: `if (!url) { router.push('/dashboard'); return; }` (`:21-24`). Nothing writes
     that key any more — it was deliberately removed, and the removal is documented in
     `lib/projects/start-from-prompt.ts:14-23` and `GenerationWorkspace.tsx:277-282`,
     `:2177-2179` ("global sessionStorage keys … no project owned"). So a signed-in user who
     types `/builder` is bounced to `/dashboard` and never reaches the fake success.
     Producing the false toast today requires seeding `sessionStorage.targetUrl` by hand in
     devtools.
- Impact: No live user-facing lie, so this is dead code rather than a defect in the rendered
  surface — hence LOW, down from the HIGH I first filed. What remains is the hazard: a
  Firecrawl-era page that returns a hardcoded template and reports it as a generated website
  is one restored `sessionStorage.setItem('targetUrl', …)` away from shipping that claim.
  Incidentally, the blob URL behind the iframe is never revoked (`:192`).
- Confidence: Confirmed (gate, absence of links, and absence of any `targetUrl` writer all
  verified in source; the `307` was observed by Main against the running dev server).
- Suggested fix: Delete `app/builder/page.tsx`. It is part of the same unreferenced
  Firecrawl-era surface as F-448, and the real flow is PromptHero → `createProject` →
  `/project/[id]`. If it is kept for any reason, the success toast must not be raised by a
  code path that never called an API.

### F-402 [HIGH] "Starred projects" is a dead end — nothing in the UI can star a project

- Area: K
- Location: `components/dashboard/ProjectCard.tsx:246-283` (the card menu), `components/layout/Sidebar.tsx:266-272`, `app/(app)/projects/page.tsx:323-335`; related: `lib/projects/stars.ts:14` (`toggleStar`, zero callers)
- What happens: The sidebar has a **Starred** nav item, `/projects?starred=true` filters
  server-side (`lib/projects/actions.ts:237`), the list payload carries `starred`
  (`lib/projects/list-client.ts:13`), and the empty state instructs
  _"Star a project from its card menu and it will show up here."_ The card menu contains
  exactly Open / Rename / Duplicate / Delete. There is no `Star` import in `ProjectCard.tsx`
  and `toggleStar` has no caller anywhere in the repository.
- Trigger: Click **Starred** in the sidebar → "No starred projects" → follow the
  instruction → the card menu has no star action.
- Impact: A shipped navigation entry that can never show anything, plus copy that tells the
  user to do something the product cannot do.
- Confidence: Confirmed
- Suggested fix: Either add the star toggle to `ProjectCard` (a `POST` wrapper around
  `toggleStar`, optimistic on `project.starred`), or remove the sidebar entry, the
  `starred` query handling and the empty-state sentence. Do not leave the copy pointing at
  a control that does not exist.

### F-403 [HIGH] Four admin dashboards render a failed fetch as a healthy, empty installation

- Area: K
- Location: `app/(app)/admin/health/HealthDashboard.tsx:129-147`, `app/(app)/admin/jobs/JobsAdmin.tsx:49-67`, `app/(app)/admin/usage/UsageDashboard.tsx:100-144`, `app/(app)/admin/quality/QualityDashboard.tsx:88-106`
- What happens: All four loaders are `try { … } finally { setLoading(false) }` with **no
  `catch`**. A network drop, a 502 from the proxy, or a non-JSON body makes
  `await response.json()` throw. `error` stays `''`, `data` stays `null`, `loading` goes
  false — and the page paints its empty state. On `/admin/health` that is
  _"No integration rows found."_, _"No providers configured."_, _"No system checks recorded
  yet."_, _"No recurring errors in the last 7 days."_ (`HealthDashboard.tsx:508-598`), with
  the stat grid collapsing to zero tiles because `cards` is `[]` when `data` is null
  (`:154-167`). On `/admin/jobs` the page renders `<AdminPage>` with literally nothing
  inside it — no skeleton, no table, no banner. On `/admin/usage`: _"No usage in this
  range."_. The rejection also surfaces as an unhandled promise rejection from `void load()`.
- Trigger: Stop the API (or return a 502 HTML body) and load any of the four pages.
- Impact: This is the `[]`-is-not-"nothing happened" rule from `.cursor/lessons-learned.md`
  applied to the operator console. An admin diagnosing an outage is shown a green,
  empty, apparently-healthy system.
- Confidence: Confirmed
- Suggested fix: Add `catch (cause) { if (!cancelled) setError(toMessage(cause, '…')) }` to
  each loader and render the `StatusBanner` before any empty state. Distinguish
  "not loaded" from "loaded and empty" in the render branch, exactly as
  `DataDirStatus.checked` does on the server side.

### F-404 [HIGH] `/admin` prints "Nothing needs attention" on top of swallowed database errors

- Area: K
- Location: `app/(app)/admin/page.tsx:67-80`, banner at `:124-128`
- What happens: The page loads five sources with `.catch(() => [])` / `.catch(() => null)`
  (`listIntegrations`, `prisma.user.count`, `listActiveJobs`, the workspace row) and then
  `collectAttention(...).catch(() => [])`. If Prisma is unreachable, `attention` is `[]` and
  the page renders a **success**-toned banner reading _"Nothing needs attention. Providers
  are configured and no integration is reporting an error."_ — a claim the code did not
  verify. The stat tiles simultaneously read `—`, `0`, `0/4`.
- Trigger: Any failure in `describeSettings` / `listIntegrations` while the page renders.
- Impact: Directly violates the documented rule "a message must not promise what the code
  cannot prove". The admin home page is the one screen whose job is answering "is anything
  wrong?".
- Confidence: Confirmed
- Suggested fix: Have the loaders return a discriminated result rather than a bare fallback,
  and render a third state — "Could not check" in a warning tone — when any source failed.
  Only print the green banner when every source succeeded and returned no attention items.

### F-405 [HIGH] The workspace sidebar's scrape panel is unreachable — `isValidUrl` is never set true

- Area: K
- Location: `components/app/generation/SidebarInput.tsx:17`, `:51`, `:67`; related: `components/workspace/GenerationWorkspace.tsx:2175`
- What happens: `const [isValidUrl, setIsValidUrl] = useState<boolean>(false)` is written
  in exactly one place — `setIsValidUrl(false)` on line 51 — and the entire options block
  (style picker, model select, instructions field, **Scrape Site** button) is guarded by
  `{isValidUrl && …}`. The URL input the state refers to was removed; the commented-out
  `validateUrl` helper is still sitting at `:20-24`. The component therefore renders one
  thing: a "Back to projects" button. `handleSubmit` (`:42`) and the whole `onSubmit` prop
  contract are unreachable.
- Trigger: Open a project workspace; the left rail shows only "Back to projects".
- Impact: A feature the workspace still wires up (`GenerationWorkspace.tsx:2175-2191`
  passes an `onSubmit` that sets five pieces of state) can never fire.
- Confidence: Confirmed
- Suggested fix: Either restore the URL field and the validation that sets `isValidUrl`, or
  delete `SidebarInput` and its call site. Do not leave a prop contract wired to unreachable
  UI.

### F-406 [MEDIUM] Project delete uses a raw `confirm()`, the one mechanism admin explicitly removed

- Area: K
- Location: `components/dashboard/ProjectCard.tsx:129`; related: `components/admin/ConfirmAction.tsx:6-15`, `app/(app)/admin/servers/ServersAdmin.tsx:53-54`
- What happens: `if (!confirm('Delete this project? …')) return;`. `ConfirmAction`'s own
  header comment says admin "previously had three mechanisms — a raw `window.confirm`, a
  bespoke type-to-confirm modal, and nothing at all" and that this is the one dialog; the
  member-facing delete never got the memo.
- Trigger: Card menu → Delete on `/dashboard` or `/projects`.
- Impact: Native `confirm` blocks the main thread, cannot be styled or themed, is
  suppressible per-origin in some browsers (after which delete fires on a single click),
  and reads nothing like the rest of the product.
- Confidence: Confirmed
- Suggested fix: Render `ConfirmAction` (or a shared studio equivalent) from the card and
  name the project in the body, matching the copy already used in the success toast.

### F-407 [MEDIUM] Five hand-rolled modals: no focus trap, no focus restore, no `inert` background

- Area: K
- Location: `components/admin/ConfirmAction.tsx:88-157`, `app/(app)/admin/team/InviteMember.tsx:111-224`, `app/(app)/admin/integrations/IntegrationsAdmin.tsx:1097-1137` and `:1138-1184`, `components/connectors/ConnectorsGitHubCard.tsx:160-202`, `components/templates/SaveAsTemplateDialog.tsx:70-162`, `components/templates/TemplateSheet.tsx:99-179`
- What happens: Each renders `role="dialog" aria-modal="true"` in place (not a portal),
  with a full-screen `<button aria-label="Cancel">` as the backdrop. None of them move
  focus into the dialog on open, contain Tab inside it, or restore focus to the trigger on
  close. `tabIndex` appears once in all 364 scope files (`components/admin/AdminTabs.tsx:61`),
  which is the structural confirmation that no focus management exists anywhere else.
  `SaveAsTemplateDialog` and `TemplateSheet` additionally have **no Escape handler** at all.
  The two `IntegrationsAdmin` dialogs also have no `aria-labelledby`, and they re-introduce
  the bespoke type-to-confirm pattern `ConfirmAction` was created to replace.
- Trigger: Open any of them and press Tab repeatedly — focus walks the page behind the
  overlay; press Escape in the template sheet — nothing happens.
- Impact: Screen-reader and keyboard users can operate controls they cannot see, and land
  back at the top of the document after closing. `AuthModal` shows the shape of the fix:
  it uses the Radix `Dialog` (`components/ui/shadcn/dialog.tsx`) and gets all of this free.
- Confidence: Confirmed
- Suggested fix: Rebuild all six on the existing Radix `Dialog` primitive, keeping the
  current visuals via `className`. Fold the two `IntegrationsAdmin` dialogs and the GitHub
  disconnect into `ConfirmAction` with `confirmPhrase`, which already implements the
  type-to-confirm behaviour they duplicate.

### F-408 [MEDIUM] `Accordion` keeps collapsed content focusable and mints duplicate DOM ids

- Area: K
- Location: `components/admin/Accordion.tsx:30`, `:65-75`; concrete trigger `app/(app)/admin/templates/TemplatesAdmin.tsx:339-354`
- What happens: Two defects in one component.
  (a) The panel collapses with `grid-rows-[0fr]` + `overflow-hidden` and nothing else — no
  `hidden`, no `inert`, no `visibility`. Its children stay in the tab order while invisible.
  (b) The panel id is derived from the title:
  `` const id = `accordion-${title.replace(/\s+/g, '-').toLowerCase()}` ``. `TemplatesAdmin`
  renders one `<Accordion title="Edit prompt">` **per template row**, so an admin page with
  N templates emits N elements with `id="accordion-edit-prompt"` and N buttons whose
  `aria-controls` point at the first one.
- Trigger: `/admin/templates` with two or more templates. Tab from the "New template"
  Accordion: focus enters every collapsed prompt textarea on the page in turn, with nothing
  visible on screen.
- Impact: A keyboard user tabs through invisible textareas; assistive tech resolves every
  `aria-controls` to the wrong panel.
- Confidence: Confirmed
- Suggested fix: Take the id from `useId()` (or an explicit prop) instead of the title, and
  set `hidden` / `inert` on the collapsed wrapper — the grid-rows transition can stay,
  driven off the same `open` flag with a transition-end handler.

### F-409 [MEDIUM] The usage "by member" row expands on click only — no keyboard path

- Area: K
- Location: `app/(app)/admin/usage/UsageDashboard.tsx:315`; component at `components/admin/AdminTable.tsx:65-85`
- What happens: `<Tr className="cursor-pointer" onClick={() => void toggleMember(member)}>`.
  `Tr` renders a bare `<tr onClick>` with no `role`, no `tabIndex`, no key handler and no
  `aria-expanded`. The only affordance is a `ChevronDown` marked `aria-hidden`.
- Trigger: Tab through `/admin/usage`. The member rows are skipped entirely; there is no
  way to open the per-project cost breakdown without a mouse.
- Impact: The per-member drill-down — the reason the page exists — is mouse-only.
- Confidence: Confirmed
- Suggested fix: Put a real `<button>` in the first cell (or the chevron cell) carrying
  `aria-expanded` and `aria-controls` for the detail row, and move the handler onto it.
  Leave `Tr` free of click semantics so the pattern is not copied.

### F-410 [MEDIUM] Custom `role="menu"` popovers have no roving focus, arrow keys, or focus move

- Area: K
- Location: `components/app/studio/UserMenu.tsx:101-183`, `components/layout/AccountMenu.tsx:117-251`, `components/layout/WorkspaceDropdown.tsx:67-110`, `app/(app)/projects/page.tsx:176-186`
- What happens: Each declares `role="menu"` with `role="menuitem"` children but implements
  none of the WAI-ARIA menu keyboard contract: opening does not move focus into the menu,
  ArrowUp/ArrowDown do nothing, Home/End do nothing, and there is no roving `tabIndex`.
  `AccountMenu` and `UserMenu` also nest non-`menuitem` controls (the theme segmented
  buttons, `AccountMenu.tsx:210-229`) directly inside the `role="menu"` container, which is
  an invalid child for that role. The `/projects` **Create** popover is worse: `role="menu"`
  with no `aria-haspopup`/`aria-expanded` on its trigger (`page.tsx:170-174`) and a
  document-level click listener as the only dismissal (`page.tsx:58-68`) — no Escape.
- Trigger: Open the sidebar account menu with the keyboard and press ArrowDown.
- Impact: A user who is told "this is a menu" gets none of a menu's behaviour; the
  `/projects` Create popover cannot be dismissed from the keyboard at all.
- Confidence: Confirmed
- Suggested fix: Move these onto the Radix `DropdownMenu` already vendored at
  `components/ui/shadcn/dropdown-menu.tsx` — `ProjectCard.tsx:243-284` shows it working with
  studio styling. Failing that, drop the `role="menu"`/`role="menuitem"` attributes so the
  markup stops promising behaviour it does not implement.

### F-411 [MEDIUM] A rejected memory-extraction toggle disables the checkbox forever, silently

- Area: K
- Location: `app/(app)/admin/usage/UsageDashboard.tsx:415-422`
- What happens:
  ```
  setSavingExtraction(true);
  void updateMemoryExtractionSetting(next).then((result) => {
    setSavingExtraction(false);
    if (result.ok) setMemoryExtractionEnabled(result.data.enabled);
  });
  ```
  There is no `.catch`. If the server action rejects (network drop, 500), the `.then`
  never runs, so `savingExtraction` stays `true` and `disabled={savingExtraction}` locks
  the checkbox for the life of the page. The rejection becomes an unhandled promise
  rejection. Even on a clean `result.ok === false` the checkbox just snaps back with no
  message.
- Trigger: Toggle "Automatically extract memory after generation" while the API is down.
- Impact: The control is permanently dead until a full reload, and the admin is never told
  the setting did not save.
- Confidence: Confirmed
- Suggested fix: Make it an `async` handler with `try/catch/finally`, `notify.error` on
  failure and `notify.success` on success — the same shape every other mutation on this
  page already uses.

### F-412 [MEDIUM] A template sheet opened from `?open=` cannot be closed

- Area: K
- Location: `components/templates/TemplateGallery.tsx:52-56` and `:122`; related `components/templates/TemplateSheet.tsx:125-131`
- What happens: The sheet's visibility is
  `selected = open || templates.find(row => row.id === openId || row.slug === openId) || null`
  where `openId = searchParams.get('open')`. `onClose` is `() => setOpen(null)`, which only
  clears the click-driven half. When the URL carries `?open=`, `selected` re-resolves from
  the URL on the next render and the sheet reopens immediately.
- Trigger: Open `/templates?open=<slug>` (a shareable link the code explicitly supports) and
  press **Close**, or click the backdrop.
- Impact: The user is trapped in a full-height overlay covering the gallery; the only escape
  is editing the URL or navigating away. There is no Escape handler either (F-407).
- Confidence: Confirmed
- Suggested fix: Make close authoritative — strip `open` from the query with
  `router.replace` in addition to `setOpen(null)`, or hold a single `closed` flag that
  suppresses the URL-derived value once the user has dismissed it.

### F-413 [MEDIUM] The account menu offers a "System" theme that the provider has disabled

- Area: K
- Location: `components/layout/AccountMenu.tsx:223-228`; related `app/providers.tsx:13`
- What happens: `AppProviders` mounts `<ThemeProvider attribute="class" defaultTheme="light"
enableSystem={false}>`. `AccountMenu` renders a three-way Light / Dark / **System**
  segmented control and calls `setTheme('system')`. With `enableSystem` false, next-themes
  does not resolve the system preference, so the app stays on the default while the control
  paints "System" as the pressed state (`pressed={currentTheme === 'system'}`, `:226`).
  `UserMenu.tsx:139-168` offers only Light/Dark, so the two account menus disagree about
  what the product supports.
- Trigger: Sidebar account menu → Appearance → System, on a machine set to dark.
- Impact: A setting that appears to apply and does nothing; two menus with different option
  sets for the same preference.
- Confidence: Confirmed
- Suggested fix: Pick one. Either set `enableSystem` and let `System` work (and add it to
  `UserMenu`), or delete the System choice from `AccountMenu`.

### F-414 [MEDIUM] Dead "Documentation" link in the sidebar account menu

- Area: K
- Location: `components/layout/AccountMenu.tsx:233-239`
- What happens: `<MenuLink href="#" icon={<BookOpen …>}>Documentation</MenuLink>`. Clicking
  it closes the menu and navigates to `#` — a no-op that also scrolls the document to the
  top and appends a bare hash to the URL.
- Trigger: Sidebar → account menu → Documentation.
- Impact: A shipped placeholder in the primary account menu. There is no docs route in
  `app/`, so the item cannot be honoured as written.
- Confidence: Confirmed
- Suggested fix: Remove the item until a docs destination exists, or point it at the real
  external URL with `target="_blank" rel="noreferrer"`.

### F-415 [MEDIUM] Pressing Enter in the spend-limit field saves the credit cap instead

- Area: K
- Location: `app/(app)/admin/workspace/WorkspaceAdmin.tsx:97-125`
- What happens: One `<form onSubmit={saveCap}>` wraps two unrelated numeric settings. The
  member cap has a `type="submit"` button; the spend limit has a `type="button"` with its
  own `saveSpendLimit` handler. Implicit submission means Enter inside the spend-limit
  input runs `saveCap`, which PATCHes `memberMonthlyCreditCap` only — and toasts
  _"Member cap saved."_ The edited spend limit is silently discarded.
- Trigger: Type a spend limit, press Enter.
- Impact: A spend ceiling the operator believes they set is not set, confirmed by a success
  toast about a different field.
- Confidence: Confirmed
- Suggested fix: Split into two forms (or two `<fieldset>`s each with their own submit), so
  Enter in a field saves that field. `busy` should also be per-field, not shared.

### F-416 [MEDIUM] Blur-to-save inputs keep a value the server rejected

- Area: K
- Location: `app/(app)/admin/plans/PlansAdmin.tsx:154-192` (with `patch` at `:39-68`), `app/(app)/admin/servers/ServersAdmin.tsx:150-161` (with `saveMax` at `:83-102`)
- What happens: The plan-limit and deployment-limit fields are uncontrolled
  (`defaultValue={plan[field]}`) and PATCH on blur. On failure the handler toasts and
  returns — `setPlans` is only called in the success branch — so the DOM input keeps
  showing the rejected number. There is no revert. `ProjectCard.rename` gets this right
  (`ProjectCard.tsx:96` resets `renameValue` in its catch); these two do not.
- Trigger: Set "Credits" to a value the API refuses (or blur while offline), dismiss the
  toast, and read the row.
- Impact: The table shows plan limits that are not the plan limits. A second operator
  reading the same screen sees fabricated numbers.
- Confidence: Confirmed
- Suggested fix: On failure, write the known-good value back to the input (make the field
  controlled off `plans` state, or set `event.target.value` in the catch). Same in
  `ServersAdmin.saveMax`, which additionally ignores a failed `refresh()`
  (`ServersAdmin.tsx:29-33` returns silently when the reload is not ok).

### F-417 [MEDIUM] Success copy that asserts outcomes the code did not observe

- Area: K
- Location: `app/(app)/admin/integrations/IntegrationsAdmin.tsx:322-324`; `components/app/auth/AuthModal.tsx:176-193`
- What happens: Two messages state facts the response does not carry.
  (a) `restartApp` toasts _"Restart requested — the application is coming back up."_ on any
  2xx. The route only accepted the request; whether Coolify restarted the container is
  unknown at that moment. The correct half-sentence is right next door — the disconnect
  path (`:589-596`) carefully distinguishes `stillSendingUntilRestart` from a clean success.
  (b) `onForgotSubmit` awaits `fetch('/api/auth/forgot-password')` inside a `try` whose
  `catch` is deliberately empty, then unconditionally toasts _"If that address has an
  account, a reset link is on its way."_ A 429 (the route is rate-limited 3/email/hr,
  10/IP/hr per AGENTS.md) or a 500 produces the same sentence. Enumeration-resistance
  requires that _success and not-found_ be indistinguishable; it does not require that
  _"we sent it"_ and _"we refused to send it"_ be indistinguishable.
- Trigger: (a) Click Restart application. (b) Request four resets for the same address in an
  hour.
- Impact: `.cursor/lessons-learned.md` 2026-08-18 ("a message must not promise what the code
  cannot prove") is the house rule these two break. In (b) the user waits for an email that
  was never queued.
- Confidence: Confirmed
- Suggested fix: (a) "Restart requested. The application will be unavailable for a moment —
  reload this page in about a minute." (b) Keep the generic wording for 2xx, but surface a
  distinct "Too many reset requests — try again in an hour" for 429 and a generic failure
  for 5xx. Neither reveals whether the address exists.

### F-418 [MEDIUM] The privacy policy describes a preview architecture the code does not have

- Area: K
- Location: `app/(legal)/privacy/page.tsx:64-67`; related `lib/preview/` per AGENTS.md "Static preview"
- What happens: Under Retention: _"Previews are compiled in your own browser, so viewing a
  site starts no server-side machine and leaves nothing to retain."_ The documented
  behaviour is the opposite direction: the static snapshot is **built inside the generation
  sandbox** (a provider VM), uploaded to object storage as a `PreviewBuild` row, and served
  from `/preview-static/{projectId}` behind a signed URL. Viewing does not _keep_ a VM alive
  — which is the true and much narrower claim — but the build is server-side and the
  artefact is retained. Live mode starts a VM outright.
- Trigger: Read `/privacy`.
- Impact: A published privacy statement that misdescribes where user code is processed and
  denies retention of an artefact that is retained. The page is marked draft, which limits
  but does not remove the exposure.
- Confidence: Confirmed
- Suggested fix: Replace with what the code does: previews are compiled once in a temporary
  build sandbox, stored as a snapshot in the configured object store, and served statically;
  viewing a preview does not start a machine. Add the snapshot to the retention list.

### F-419 [MEDIUM] A 403 hard-redirects to `/dashboard` with no explanation

- Area: K
- Location: `app/(app)/admin/audit/AuditAdmin.tsx:52-55`, `app/(app)/admin/backups/BackupsAdmin.tsx:58-61`, `app/(app)/admin/jobs/JobsAdmin.tsx:54-57`, `app/(app)/admin/health/HealthDashboard.tsx:134-137`, `app/(app)/admin/quality/QualityDashboard.tsx:93-96`, `app/(app)/admin/usage/UsageDashboard.tsx:109-112`
- What happens: Every admin loader does
  `if (response.status === 403) { window.location.replace('/dashboard'); return; }` — a full
  document navigation with no message, no toast, and no `next` parameter.
- Trigger: An admin whose role is revoked (or whose session is downgraded) in another tab
  loads any admin page.
- Impact: The page blinks and the user is on the dashboard with no idea why. It is also a
  hard reload rather than a router navigation, discarding client state. The layout-level
  `requireAdmin` (`app/(app)/admin/layout.tsx:16-17`) already handles the normal case, so
  this branch only fires on mid-session changes — exactly when an explanation matters most.
- Confidence: Confirmed
- Suggested fix: `notify.error('Your admin access was removed.')` then `router.replace`, or
  render an inline "You no longer have access to this page" panel with a link. One shared
  helper for all six call sites.

### F-420 [MEDIUM] `AuthProvider.setUser` is a misleading no-op that double-signs-out

- Area: K
- Location: `components/app/auth/AuthProvider.tsx:50-54`; callers `components/app/studio/UserMenu.tsx:51-57`, `components/layout/AccountMenu.tsx:68-74`
- What happens:
  ```
  const setUser = useCallback((next: AuthUser | null) => {
    if (next === null) { void signOut({ redirect: false }); }
  }, []);
  ```
  The name and the `(user: AuthUser | null) => void` type promise you can set the user;
  passing anything non-null does nothing at all. Both callers already `await signOut(...)`
  immediately before calling `setUser(null)`, so sign-out is issued twice per logout — the
  second one is a floating promise with no `.catch`.
- Trigger: Sign out from either account menu.
- Impact: A second, unawaited network call on every logout, and a context API whose contract
  is a lie for any future caller that tries to push a user object into it.
- Confidence: Confirmed
- Suggested fix: Rename to `signOutUser(): Promise<void>` (no argument), have it own the
  `signOut` call, and make the two menus `await` it. Remove the duplicate `signOut` from the
  callers.

### F-421 [MEDIUM] `SetupChecklist` writes to `localStorage` during render

- Area: K
- Location: `components/dashboard/SetupChecklist.tsx:32-37`
- What happens:
  ```
  if (user?.role !== 'ADMIN' || hidden || !rows) return null;
  const missing = rows.filter(...);
  if (missing.length === 0) {
    if (typeof window !== 'undefined') window.localStorage.removeItem(HIDDEN_KEY);
    return null;
  }
  ```
  The `removeItem` runs in the component body, not in an effect or an event handler. React
  invokes render functions speculatively and twice under StrictMode; a render must be pure.
- Trigger: Load `/dashboard` as an ADMIN with all integrations connected.
- Impact: A side effect on a code path React is free to re-run, discard, or interleave. It
  is also the `react-hooks/purity` rule the repo already tracks
  (`.cursor/lessons-learned.md`, 2026-08-17 "React Compiler hook rules vs verify").
- Confidence: Confirmed
- Suggested fix: Move the clear into a `useEffect` keyed on `missing.length === 0`, keeping
  the early `return null` pure.

### F-422 [MEDIUM] Destructive actions with no confirmation step

- Area: K
- Location: `components/settings/SkillsPanel.tsx:100-110` and `:181-188`; `app/(app)/settings/api-keys/page.tsx:108-123` and `:186-195`
- What happens: **Delete** on a workspace skill and **Remove** on a personal provider API
  key both fire on a single click. `deleteSkill` destroys hand-written instruction content
  (up to 4000 characters, `SkillsPanel.tsx:247`) with no undo; `deleteApiKey` drops a
  credential the member must go re-mint. Neither handler is wrapped in `try/catch` either
  (`toggle` and `remove` in `SkillsPanel` call the server action bare), so a rejection is an
  unhandled promise with no UI.
- Trigger: Misclick either button.
- Impact: Irreversible data loss on one click, in a product that ships a shared
  `ConfirmAction` component precisely for this.
- Confidence: Confirmed
- Suggested fix: Wrap both in `ConfirmAction` naming the skill / provider, and give
  `SkillsPanel.toggle` / `.remove` the same `try/catch/finally` + `notify` shape as
  `saveDraft` next to them.

### F-423 [MEDIUM] `initCanvas` leaks a window resize listener on every mount

- Area: K
- Location: `utils/init-canvas.ts:24-29`; six call sites, e.g. `components/app/(home)/sections/endpoints/EndpointsCrawl/EndpointsCrawl.tsx:32`, `.../EndpointsExtract/EndpointsExtract.tsx:34`, `.../EndpointsScrape/EndpointsScrape.tsx:34`, `.../EndpointsSearch/EndpointsSearch.tsx:21`, `.../Extract/Extract.tsx:16`, `.../Mcp/Mcp.tsx:32`
- What happens: The helper registers `window.addEventListener('resize', handleResize)` and
  `window.visualViewport?.addEventListener('resize', handleResize)` and then
  `return ctx` — it never returns a teardown, and no caller could unregister even if it
  wanted to. `handleResize` is a lodash `debounce`, which is also never cancelled.
- Trigger: Mount/unmount any endpoints section (they are canvas animations on the home
  surface, and StrictMode mounts each twice in development).
- Impact: Every mount adds two permanent listeners holding a reference to a detached canvas
  and its 2D context. On a page cycling these sections the listener list grows without
  bound and each resize re-upscales dead canvases.
- Confidence: Confirmed
- Suggested fix: Return `{ ctx, dispose }` (removing both listeners and calling
  `handleResize.cancel()`), and have each caller return `dispose` from its effect.
  `components/shared/animated-dot-icon.tsx:30-56` has a private copy of the same helper with
  the same defect.

### F-424 [MEDIUM] `useDebouncedEffect` spreads a caller-supplied array into the dependency list

- Area: K
- Location: `hooks/useDebouncedEffect.ts:59-64`; caller `components/shared/pixi/Pixi.tsx:45`
- What happens: `useEffect(..., [callback, ignoreInitialCall, timeout, ...deps])`. React
  requires the dependency array to have a constant size between renders; nothing here
  enforces that, and eslint cannot check a spread. Worse, `callback` is in the list: callers
  pass an inline arrow, so a new identity arrives every render and the effect re-runs —
  clearing and re-arming the timer each time. A component that re-renders faster than
  `timeout` never fires the debounced callback at all.
- Trigger: Any parent re-render during the debounce window.
- Impact: The debounce silently degrades to "never runs" under render pressure; a `deps`
  array whose length changes throws React's "size of dependency list changed" warning and
  produces undefined behaviour.
- Confidence: Confirmed
- Suggested fix: Hold `callback` in a ref updated each render (as the sibling
  `useDebouncedCallback` already does at `hooks/useDebouncedCallback.ts:12-15`) and keep it
  out of the dep list; document that `deps` must be a fixed-length array, or take a
  `depsKey: string` instead.

### F-425 [MEDIUM] Command palette: a failed search reads as "Nothing found"

- Area: K
- Location: `components/layout/CommandPalette.tsx:104-130`, `:186-196`, `:203-207`
- What happens: `if (!response.ok) return;` inside the `finally { setLoading(false) }`
  block, and the catch does `setResults([])` for anything that is not an `AbortError`.
  Either way the panel renders _"Nothing found"_ (`:206`). There is no error state and no
  `notify` call. The palette is also mounted app-wide via `AppProviders`, including on the
  signed-out landing page, where `/api/search` answers 401 — Cmd+K there always reports
  "Nothing found" for every query.
- Trigger: Cmd/Ctrl+K, type a project name you know exists, with the API failing.
- Impact: The user concludes their project is gone. The palette is also `role="dialog"
aria-modal="true"` (`:191`) with no focus containment and no focus restore on close, and
  the arrow-key result list has no `role="listbox"`/`option` or `aria-activedescendant`, so
  the active row is never announced.
- Confidence: Confirmed
- Suggested fix: Render a distinct "Search is unavailable right now" row for a non-ok or
  thrown response. Add focus containment (or move onto the Radix `Dialog`), and give the
  input `role="combobox"` with `aria-controls`/`aria-activedescendant` over an
  `role="listbox"` of `role="option"` rows.

### F-426 [MEDIUM] No `aria-live` region for any async status change

- Area: K
- Location: `aria-live` appears exactly once in the 364 scope files, at `components/ui/shadcn/button.tsx:42` (loading buttons). Unannounced examples: `app/(app)/admin/audit/AuditAdmin.tsx:123-125` (button label flips to "Loading…"), `components/settings/SkillsPanel.tsx:134-136` ("Loading skills…" replaced by a list), `app/(app)/dashboard/page.tsx:198-208` (skeleton grid replaced by cards), `app/(app)/projects/page.tsx:299-346` (skeleton → buckets or empty state)
- What happens: Loading placeholders and their replacements are swapped into the DOM with
  no live region. `AdminSkeleton` is the one component that gets it partly right
  (`role="status" aria-label="Loading"`, `components/admin/AdminSkeleton.tsx:31-32`), but
  the removal of that node is not itself announced, and the pages above use bare `<div>`
  skeletons.
- Trigger: Load `/projects` with a screen reader. Nothing is announced between navigation
  and the list appearing.
- Impact: A screen-reader user has no way to know when a list finished loading, whether a
  filter changed the result count, or that a search returned nothing.
- Confidence: Confirmed
- Suggested fix: Add one polite live region per list surface that announces the settled
  state ("12 projects", "Nothing found", "Could not load projects"), and give the skeleton
  wrappers `role="status"`. Errors already carry `role="alert"` consistently — the gap is
  only on the success/empty transitions.

### F-427 [MEDIUM] The Owner filter contradicts itself for "Shared with me"

- Area: K
- Location: `app/(app)/projects/page.tsx:31-35` (`parseMine`), `:226-243` (the select); related `components/layout/Sidebar.tsx:273-279`
- What happens: `parseMine` understands three states (`true` / `false` / `undefined`) and
  the sidebar links to `/projects?mine=false` labelled **Shared with me**. The Owner select
  only models two: `value={mine === true ? 'mine' : 'all'}` and
  `onChange` maps anything not `'mine'` to `undefined`. Arriving from "Shared with me", the
  filter _is_ applied (`load` passes `mine: false`) but the control reads **All** — and the
  moment the user touches it, the filter is dropped.
- Trigger: Sidebar → Shared with me → look at the Owner dropdown.
- Impact: The visible control disagrees with the applied filter; there is no way to
  re-select "Shared with me" from the page itself.
- Confidence: Confirmed
- Suggested fix: Add a third `<option value="shared">Shared with me</option>` and map it to
  `false`, so the select is a faithful view of `mine`.

### F-428 [MEDIUM] `/settings/usage` has no loading state and no `ok` check

- Area: K
- Location: `app/(app)/settings/usage/page.tsx:28-42`, render guard at `:71`
- What happens: State is `data | null` plus `error`; there is no `loading` flag. Until the
  fetch settles the page renders the heading and the tab strip over blank space. The fetch
  is `.then(response => response.json())` with **no `response.ok` check**, so a 401/500 HTML
  body throws into `.catch(() => setError('Could not load usage'))` — the specific server
  message in `payload.error` is only read on a 200 (`:35`).
- Trigger: Open `/settings/usage` on a slow connection, or while signed out in another tab.
- Impact: An empty page that gives no signal it is working, and a generic message that
  discards the server's explanation.
- Confidence: Confirmed
- Suggested fix: Add a skeleton (`AdminSkeleton`'s `SkeletonLines` shape works here) and
  use `fetchJson` from `lib/notify`, which already reads the `{ error }` envelope and
  throws a readable `Error`.

### F-429 [MEDIUM] A failed template list renders as an empty gallery

- Area: K
- Location: `app/(app)/templates/page.tsx:12-13`
- What happens: `const templates = result && result.ok ? result.data.templates : [];` — a
  failed `listTemplates` becomes `[]` with no flag passed to the client, and
  `TemplateGallery` shows _"No templates match these filters."_ (`TemplateGallery.tsx:111-114`).
  The gallery's own client refetch (`:39-49`) does set an error, so the page flickers from
  a false empty state to a real error only if the second call also fails.
- Trigger: Load `/templates` while the DB is unavailable.
- Impact: Ten seeded built-in templates appear to have vanished.
- Confidence: Confirmed
- Suggested fix: Pass `{ templates, loadFailed }` and have the gallery render an error
  panel when the server load failed, rather than folding the failure into the empty case.

### F-430 [MEDIUM] "Request data export or deletion" is the export button, and both buttons disable together

- Area: K
- Location: `app/(app)/settings/profile/page.tsx:285-328`; related `app/(legal)/terms/page.tsx:64-69`
- What happens: The two buttons are generated from `(['export', 'deletion'] as const)`. The
  `deletion` button reads "Request account deletion"; the `export` button reads
  **"Request data export or deletion"** (`:326`) while sending `kind: 'export'`. So the
  button that mentions deletion does not request it, sitting next to the one that does.
  Both share a single `dataRequesting` flag, so pressing either disables both and shows
  "Sending…" on both — there is no way to tell which request is in flight.
- Trigger: Settings → Profile → Your data.
- Impact: A user intending to delete their account may press the wrong button and be told
  the request was sent. `/terms` compounds it by instructing readers to
  "Use **Request data export or deletion** on Settings → Profile" for deletion.
- Confidence: Confirmed
- Suggested fix: Label the export button "Request a copy of my data". Track busy state per
  `kind`. Fix the Terms sentence to name the deletion button.

### F-431 [MEDIUM] Backup polling has no error handling and can reject unhandled every 2 s

- Area: K
- Location: `app/(app)/admin/backups/BackupsAdmin.tsx:56-76`
- What happens: `refresh()` has no `try/catch`; `await response.json()` throws on a non-JSON
  body. It is called from `window.setInterval(() => { void refresh(); }, 2000)` while a
  backup is running, so a transient failure produces an unhandled rejection every two
  seconds while the page keeps showing "Backup in progress. This page refreshes
  automatically." (`:133-137`) forever.
- Trigger: Start a backup, then interrupt the API.
- Impact: The banner promises an automatic refresh that has stopped working, with no error
  and a rejection storm in the console.
- Confidence: Confirmed
- Suggested fix: Wrap `refresh` in `try/catch`, set `error` on failure, and stop the
  interval after N consecutive failures with a "Could not refresh — reload the page" banner.

### F-432 [MEDIUM] "Save as template" stays open and resubmittable after it succeeds

- Area: K
- Location: `components/templates/SaveAsTemplateDialog.tsx:58-62`, `:152-158`
- What happens: On success the handler sets `done` (an inline `role="status"` line) and
  toasts, but does not close the dialog or disable the submit button — `disabled={busy}`
  only. The form fields keep their values.
- Trigger: Save a template, then press "Save as template" again.
- Impact: A second identical workspace template is created. The user has no signal that the
  first one already exists apart from a line of text above the still-live button.
- Confidence: Confirmed
- Suggested fix: On success either call `onClose()` (the toast already carries the
  confirmation past the dialog, per the comment at `:61`) or switch the footer to a single
  "Done" button, as `InviteMember` does after a successful invite
  (`InviteMember.tsx:151-155`).

### F-433 [MEDIUM] Framer-motion infinite spinners ignore `prefers-reduced-motion`

- Area: K
- Location: `components/CodeApplicationProgress.tsx:31-35` (rendered live at `components/workspace/GenerationWorkspace.tsx:2193`); also `components/app/(home)/sections/ai-readiness/InlineResults.tsx:107-108`, `:121-122`, `:137-138`, `:178-179`
- What happens: `animate={{ rotate: 360 }} transition={{ duration: 1, repeat: Infinity }}`.
  The global reduced-motion escape hatch in `styles/design-system/base/reset.css:72-85`
  neutralises CSS `animation-duration`/`transition-duration`, but framer-motion drives
  inline transforms/WAAPI, which that rule does not touch. Everything else in the studio is
  careful here: `PromptBox.tsx:96`, `StudioButton.tsx:14`, `AdminSkeleton.tsx:20` and
  `project-card.module.css:25-29` all opt out explicitly.
- Trigger: Enable "Reduce motion" in the OS and apply generated code — the spinner in the
  chat column keeps rotating for the length of the apply.
- Impact: A continuously rotating element for a user who asked the system not to animate,
  on the one surface they will be staring at for minutes.
- Confidence: Confirmed
- Suggested fix: Gate the transition on framer-motion's `useReducedMotion()` (render a
  static icon, or `repeat: 0`), or replace it with the `Loader2 … animate-spin
motion-reduce:animate-none` pattern used everywhere else in the workspace.

### F-434 [MEDIUM] The warning `StatusPill` fails AA contrast

- Area: K
- Location: `components/admin/StatusPill.tsx:17-20`
- What happens: The warning tone is `text-amber-600` (#d97706) at `text-[11px]` on
  `bg-amber-500/10` over a white card — an effective background near #fef6ec. That is about
  **2.9:1**, against the 4.5:1 WCAG AA minimum for text this size. The dark variant
  (`dark:text-amber-400` on `--studio-surface`) is fine; it is the light theme — the
  product default per AGENTS.md — that fails. The component's own docstring says the
  outline-only predecessor was replaced because it was "nearly invisible against a white
  card"; the warning tone did not get the same treatment.
- Trigger: Any warning pill in admin (integration `PENDING`, plan/server states).
- Impact: The one pill colour that means "needs attention" is the hardest to read.
- Confidence: Confirmed
- Suggested fix: Move the warning text to `amber-700`/`amber-800` in light mode (≈5.5:1 and
  ≈7:1 on the same tint) and keep `amber-400` for dark. Same check applies to any 11px text
  on a 10 % tint.

### F-435 [MEDIUM] The signed-out landing page cannot scroll on a short viewport

- Area: K
- Location: `components/app/home/HomeLanding.tsx:93` and `:115`
- What happens: The root is `flex h-dvh flex-col overflow-hidden`; `<main>` is
  `flex min-h-0 flex-1 flex-col items-center justify-center` with **no** `overflow-y-auto`.
  The hero, its four-row textarea, the stack/direction selects, the category chips and the
  footer are all inside that locked box.
- Trigger: Open `/` on a phone in landscape, or focus the prompt textarea on a small phone
  so the on-screen keyboard halves `dvh`.
- Impact: The submit button and the chips are clipped with no way to reach them — the exact
  `h-dvh overflow-hidden` + missing inner scroll failure already logged in
  `.cursor/lessons-learned.md` (2026-08-17, "Flex `h-dvh overflow-hidden` needs `min-h-0` +
  inner scroll").
- Confidence: Likely — the geometry is confirmed in code; I could not drive a real mobile
  viewport in a read-only audit.
- Suggested fix: Add `overflow-y-auto` (the `studio-scroll` class) to `<main>`, or drop
  `overflow-hidden` from the root and let the document scroll.

### F-436 [MEDIUM] `app/error.tsx` never reports to Sentry

- Area: K
- Location: `app/error.tsx:18-27`; contrast `app/global-error.tsx:19-21`
- What happens: The route-level error boundary logs a JSON line to `console.error` and
  nothing else. `global-error.tsx`, which only fires when the root layout itself throws,
  does call `Sentry.captureException`. So the common case — a page or nested segment
  throwing during render — produces a user-visible "Page failed to load" with an Error ID
  that exists **only** in that browser's console.
- Trigger: Any render-time throw below the root layout.
- Impact: The `ErrorId` panel tells the user "Send this ID to support"
  (`components/errors/ErrorId.tsx:41`), but support has nothing to look it up in. Sentry is
  wired (`Integration` kind `SENTRY`) and receives nothing from this boundary.
- Confidence: Confirmed
- Suggested fix: Add `Sentry.captureException(error, { tags: { requestId } })` alongside the
  console line, matching `global-error.tsx`. `PanelErrorBoundary.componentDidCatch`
  (`components/errors/PanelErrorBoundary.tsx:16-25`) has the same gap and wraps the
  streaming workspace panels.

### F-437 [MEDIUM] `useDebouncedCallback` fires after unmount

- Area: K
- Location: `hooks/useDebouncedCallback.ts:11-33`
- What happens: The hook stores a timeout id in a ref and clears it only on the _next_
  invocation. There is no `useEffect(() => () => clearTimeout(timeoutRef.current), [])`.
  A pending call therefore survives unmount and invokes `callbackRef.current`, which in
  practice is a `setState` on a component that no longer exists.
- Trigger: Trigger the debounced callback, then navigate away inside the timeout window.
- Impact: setState-after-unmount and a retained closure over the unmounted tree. The hook
  currently has no callers (see F-448), so this is latent rather than live.
- Confidence: Confirmed
- Suggested fix: Add the unmount cleanup effect, or delete the hook along with the rest of
  the dead surface.

### F-438 [LOW] `StatTile` uses a raw `<a>` for internal admin links

- Area: K
- Location: `components/admin/StatTile.tsx:25-28`; call sites `app/(app)/admin/page.tsx:99`, `:105`, `:111`, `:119`
- What happens: `const Tag = href ? 'a' : 'div'`, so every stat tile on the admin home page
  performs a full document navigation instead of a client-side route change.
- Impact: A visible reload, discarded client state, and a slower hop between admin pages
  than every other link in the section (which all use `next/link`).
- Confidence: Confirmed
- Suggested fix: Render `next/link` when `href` is present.

### F-439 [LOW] `formatAdminDateTime` returns an empty string for a missing/invalid date

- Area: K
- Location: `app/(app)/admin/format-admin-date.ts:28-32`, `:35-39`; visible at `app/(app)/admin/audit/AuditAdmin.tsx:152`
- What happens: Both formatters return `''` when `toDate` yields null. Table cells then
  render blank rather than the `—` the rest of admin uses for "no value"
  (`AuditAdmin.tsx:156`, `JobsAdmin.tsx:124`).
- Impact: A blank cell reads as a layout bug rather than as absent data.
- Confidence: Confirmed
- Suggested fix: Return `'—'`, or add an explicit `fallback = '—'` parameter.

### F-440 [LOW] Two components paint outside the design-token system

- Area: K
- Location: `components/app/studio/ThemeToggle.tsx:26-30`, `components/legal/LegalDraftBanner.tsx:4`
- What happens: `ThemeToggle` hardcodes `text-zinc-600`, `border-zinc-200`,
  `dark:focus-visible:ring-[#ff6b8a]` instead of `--studio-fg` / `--studio-line` /
  `--studio-ring`, which are defined right next to it in `studio.css`.
  `LegalDraftBanner` uses `border-amber-300 bg-amber-50 text-amber-950` with no dark
  variant, so the banner stays a light-mode card on `/terms` and `/privacy` in dark mode.
- Impact: Two surfaces drift when the palette changes; the legal banner is visually foreign
  in dark mode.
- Confidence: Confirmed
- Suggested fix: Swap both onto the studio tokens (`StudioButton.tsx:16` shows the ring
  pattern), and give the banner a `dark:` pair or a `--studio-warning` token.

### F-441 [LOW] `Spinner` size scale is inconsistent

- Area: K
- Location: `components/ui/spinner.tsx:18-22`
- What happens: `{ sm: 'h-4 w-4', md: 'h-20 w-20', lg: 'h-8 w-8' }` — in this project's
  px-based Tailwind scale that is 4 px, 20 px, 8 px, so `lg` is smaller than `md` and `sm`
  is effectively invisible.
- Impact: The only caller (`components/app/(home)/sections/hero-scraping/Code/Loading/Loading.tsx:6`)
  happens to use the default, so nothing is broken today; any new caller picking `lg` gets a
  smaller spinner than `md`.
- Confidence: Confirmed
- Suggested fix: `{ sm: 'h-16 w-16', md: 'h-20 w-20', lg: 'h-24 w-24' }`.

### F-442 [LOW] A production Coolify hostname is hardcoded as client-side default state

- Area: K
- Location: `app/(app)/admin/integrations/IntegrationsAdmin.tsx:91`
- What happens: `useState('https://coolify.navroop.app')` pre-fills the Coolify URL field in
  a client component, so the string ships in the browser bundle for every operator of every
  deployment.
- Impact: Not a secret, but it hardcodes one installation's infrastructure into shared code
  and pre-fills the wrong value for anyone else. Every other connector field starts empty.
- Confidence: Confirmed
- Suggested fix: Start empty with the URL as a `placeholder`, or seed it from the existing
  `COOLIFY` integration row passed in `initial`.

### F-443 [LOW] The shared marketing `Tabs` has no tab semantics

- Area: K
- Location: `components/shared/tabs/Tabs.tsx:78-90`
- What happens: A row of plain `<button>`s with `key={index}` — no `role="tablist"`,
  `role="tab"`, `aria-selected`, `aria-controls`, or arrow-key navigation. Compare
  `components/admin/AdminTabs.tsx:44-89`, which implements all of it.
- Impact: Assistive tech sees an undifferentiated button row; keyboard users get no
  arrow-key movement.
- Confidence: Confirmed
- Suggested fix: Reuse `AdminTabs`' semantics (or Radix Tabs), and key on `tab.value`.

### F-444 [LOW] The prompt-tips dismissal never checks whether it saved

- Area: K
- Location: `components/dashboard/PromptTipsPanel.tsx:27-34`
- What happens: The Dismiss handler sets local state and fires
  `void fetch('/api/onboarding', { method: 'POST', … })` with no `.then`, no `.catch` and no
  `response.ok` check.
- Impact: If the POST fails, the panel silently returns on the next dashboard load, and the
  rejected promise is unhandled.
- Confidence: Confirmed
- Suggested fix: `await` it in an async handler, keep the optimistic hide, and revert +
  `notify.error` on failure — or at minimum attach a `.catch`.

---

## Gaps

### F-445 [GAP] No `loading.tsx`, `not-found.tsx`, or per-segment `error.tsx` anywhere in `app/`

- Area: K
- Location: the only special files in the whole tree are `app/error.tsx` and
  `app/global-error.tsx`; 35 `page.tsx` files across `app/(app)/**`, `app/project/**`,
  `app/(legal)/**` have none. Client-side substitutes exist only at
  `app/(app)/projects/page.tsx:374-388` (a `Suspense` fallback) and
  `app/(app)/templates/page.tsx:23` (a "Loading templates…" string).
- What is missing:
  - **`loading.tsx`** — every async server page (`/admin/*`, `/templates`, `/project/[id]`)
    blocks on its data with no streamed shell. `app/(app)/layout.tsx:22-27` has a `Suspense`
    fallback for the sidebar only; the content column has nothing.
  - **`not-found.tsx`** — a bad project id or a deleted project renders the framework's
    default 404 outside the studio shell, with no sidebar and no way back.
  - **segment `error.tsx`** — a throw inside `/admin` or a project workspace unmounts the
    entire app chrome and replaces it with the root boundary. A boundary at
    `app/(app)/error.tsx` and `app/project/[id]/error.tsx` would keep the shell and let the
    user retry just the pane.
- Impact: Blank waits on every server-rendered page, an unbranded 404, and full-app
  teardown on any nested error.
- Suggested fix: Add `app/(app)/loading.tsx` (a `StudioShell` + `AdminSkeleton` shell),
  `app/(app)/not-found.tsx` and `app/not-found.tsx` (studio-framed, linking to `/dashboard`),
  and `app/(app)/error.tsx` + `app/project/[id]/error.tsx` reusing `ErrorId` and reporting
  to Sentry (F-436).

### F-446 [GAP] No offline handling on any surface

- Area: K
- Location: `navigator.onLine`, `'offline'`/`'online'` listeners and any service worker are
  absent from all 364 scope files (and from `app/layout.tsx`). Every polling loop —
  `app/(app)/dashboard/page.tsx:62-68` (4 s), `app/(app)/projects/page.tsx:129-135` (4 s),
  `app/(app)/admin/backups/BackupsAdmin.tsx:70-76` (2 s) — keeps firing while offline.
- What is missing: A shared "You are offline — changes will not be saved" banner, pausing
  the pollers on `offline`, and resuming with one refetch on `online`. Today an offline user
  sees `notify.error('Failed to fetch')` (or, on the loaders in F-403, nothing at all)
  repeated indefinitely.
- Impact: Offline is indistinguishable from a broken server; the toast queue fills with
  network errors the user cannot act on.
- Suggested fix: One `useOnline()` hook feeding a persistent banner in `StudioShell`, and an
  `if (!navigator.onLine) return;` guard at the top of each polling tick.

### F-447 [GAP] The client/server boundary guard does not cover what its name claims

- Area: K
- Location: `tests/unit/client-import-boundary.test.ts:21-24`, `:42-57`, `:59-69`, `:179-201`, `:237-250`
- What is missing, verified against the test source:
  1. **Roots.** `ROOTS` is `app` and `components` only (`:21-24`). Three `'use client'`
     modules live outside them and are never scanned as entries: `lib/notify.ts:1`,
     `hooks/useDraftStorage.ts:1`, `hooks/useUnsavedChangesWarning.ts:1`. They are reached
     transitively today, so nothing is broken — but a `'use client'` hook imported only by a
     Server Component would be a real client boundary the guard never opens.
  2. **Bare Node specifiers.** `BARE_NODE_ONLY` (`:42-57`) omits `crypto`, `os`, `zlib`,
     `stream`, `worker_threads`, `v8`, `perf_hooks`, `vm`, `module`, `tty` and
     `dns/promises`. The `node:`-prefixed forms are all caught by `isForbiddenNodeSpec`
     (`:179-186`), but `import { createHash } from 'crypto'` is not.
  3. **Third-party packages.** `resolveLocal` (`:187-201`) returns `null` for any bare
     specifier, and the only package-level checks are `@prisma/client` and
     `generated/prisma` (`:248-251`). A client file importing `archiver`, `resend`,
     `nodemailer`, `bcryptjs` or the E2B/Daytona SDKs — all of which pull `node:fs` /
     `node:crypto` — produces zero hits, even though the test's own name is "keeps every
     use-client graph off Node builtins".
  4. **`load-admin`.** AGENTS.md:96 and `.cursor/lessons-learned.md:25` both single out
     `import type`-ing a payload from an admin `load-admin`, and `TYPE_ONLY_FORBIDDEN` is
     just a copy of `SERVER_ONLY_FILES` (`:69`) which does not list it. No `load-admin` file
     exists in the tree today, so this is a documentation/guard drift rather than a live
     hole — but if one is re-added, the documented mistake is unguarded.
- Impact: The guard catches the two specific regressions it was written for and reads as
  broader coverage than it has. Its passing is treated as proof in `pnpm run verify`.
- Suggested fix: Add `hooks`, `lib`, `utils` and `config` to `ROOTS`; complete
  `BARE_NODE_ONLY`; and for bare package specifiers, resolve through `require.resolve` and
  check the resolved package's `browser`/`exports` fields (or keep a small denylist of the
  server-only packages this app depends on).

---

## Improvements

### F-448 [IMPROVEMENT] A large unreferenced-module surface inside the rendered scope

- Area: K
- Location: A basename-based reachability scan over every `.ts`/`.tsx` in the repo found
  **85** of the scope's modules with no importer. Individually re-verified (no import
  statement anywhere in `app/`, `components/`, `lib/`, `hooks/`):
  `app/landing.tsx` (a second, Firecrawl-branded landing page with a "Use this Template"
  link to `github.com/mendableai/open-lovable`, `:53-70` — directly against the
  brand-as-Navroop rule), `components/app/auth/AuthNav.tsx`,
  `components/app/generation/SidebarQuickInput.tsx`, `components/SandboxPreview.tsx`,
  `components/HMRErrorDetector.tsx`, `components/HeroInput.tsx`,
  `components/shared/pylon.tsx`, `components/shared/preview/live-preview-frame.tsx`
  (+ `web-browser.tsx`, `multiple-web-browsers.tsx`, `json-error-highlighter.tsx`),
  `components/shared/ui/{mobile-sheet,empty-state,loading-state,app-dialog,stat-card,dot-grid-loader,ascii-dot-loader,index}.tsx`,
  `components/shared/loading/{Shimmer,usage-loading}.tsx`,
  `components/shared/notifications/slack-notification.tsx`,
  `components/shared/combobox/combobox.tsx`, `components/shared/logo-cloud/**`,
  `components/app/(home)/sections/ai-readiness/{ControlPanel,InlineResults}.tsx`,
  `hooks/useDebouncedCallback.ts`, `hooks/useSwitchingCode.ts`, and ~25 icon modules under
  `components/shared/icons/`.
- Why it matters here (this is Section K, not dead-code hygiene): these files are the source
  of most of the remaining `console.log` noise (`live-preview-frame.tsx:175`, `:253`,
  `:289`; `pylon.tsx:33`, `:60`), the Firecrawl token set (`text-heat-100`,
  `bg-background-base`, `black-alpha-*`) that keeps leaking back into new components, and a
  hardcoded `wss://api.firecrawl.dev/agent-livecast` connection
  (`live-preview-frame.tsx:168`). They also make every "is this component used?" question in
  a review cost a grep.
- Confidence: Confirmed for the modules named above; the 85-file count is from a
  basename heuristic and may over-report where two files share a name
  (e.g. `components/ui/select.tsx` vs `components/ui/shadcn/select.tsx`).
- Suggested fix: Delete `app/landing.tsx` and the Firecrawl-era preview/marketing tree in
  one commit, then re-run `knip` (already part of `pnpm run verify`) and treat its report as
  a gate rather than a report for `components/**`.

### F-449 [IMPROVEMENT] `useImperativeHandle` in `PromptHero` has no dependency array

- Area: K
- Location: `components/dashboard/PromptHero.tsx:60-68`
- What happens: The handle object is rebuilt on every render. It is functionally correct
  (the closures always see current `stack`/`designDirection`), but it defeats memoisation in
  any consumer that keys off the ref identity, and it hides the fact that `fill` depends on
  four values.
- Suggested fix: Pass `[flush, setValue, stack, designDirection, importMode]` as the third
  argument so the dependency set is explicit and lint-checkable.

### F-450 [IMPROVEMENT] The dashboard poller restarts its interval on every tick

- Area: K
- Location: `app/(app)/dashboard/page.tsx:62-68`; same shape at `app/(app)/projects/page.tsx:129-135`
- What happens: The effect depends on `projects`, and each poll calls `setProjects` with a
  fresh array, so the effect tears down and re-creates the `setInterval` every 4 s. It works,
  but the timer is never allowed to run as a timer and the dependency is really "is anything
  generating", not "the whole list".
- Suggested fix: Depend on a derived boolean —
  `const anyGenerating = useMemo(() => projects.some(isProjectGenerating), [projects])` —
  and key the effect on that.

---

## Files reviewed

Verdict per file. `clean` means: read in full, no Section K finding worth filing.

- `app/(app)/admin/audit/AuditAdmin.tsx` — F-419, F-426, F-439
- `app/(app)/admin/audit/page.tsx` — clean
- `app/(app)/admin/backups/BackupsAdmin.tsx` — F-419, F-431
- `app/(app)/admin/backups/page.tsx` — clean
- `app/(app)/admin/config/ConfigAdmin.tsx` — clean
- `app/(app)/admin/config/page.tsx` — clean
- `app/(app)/admin/deploy/page.tsx` — clean
- `app/(app)/admin/format-admin-date.ts` — F-439
- `app/(app)/admin/health/HealthDashboard.tsx` — F-403, F-419
- `app/(app)/admin/health/page.tsx` — clean
- `app/(app)/admin/integrations/IntegrationsAdmin.tsx` — F-407, F-410, F-417, F-442
- `app/(app)/admin/integrations/page.tsx` — clean
- `app/(app)/admin/integrations/sentry-meta.ts` — clean
- `app/(app)/admin/jobs/JobsAdmin.tsx` — F-403, F-419
- `app/(app)/admin/jobs/page.tsx` — clean
- `app/(app)/admin/layout.tsx` — clean
- `app/(app)/admin/page.tsx` — F-404
- `app/(app)/admin/plans/page.tsx` — clean
- `app/(app)/admin/plans/PlansAdmin.tsx` — F-416
- `app/(app)/admin/quality/page.tsx` — clean
- `app/(app)/admin/quality/QualityDashboard.tsx` — F-403, F-419
- `app/(app)/admin/servers/page.tsx` — clean
- `app/(app)/admin/servers/ServersAdmin.tsx` — F-416
- `app/(app)/admin/team/InviteMember.tsx` — F-407
- `app/(app)/admin/team/page.tsx` — clean
- `app/(app)/admin/team/TeamTable.tsx` — clean
- `app/(app)/admin/templates/page.tsx` — clean
- `app/(app)/admin/templates/TemplatesAdmin.tsx` — F-408
- `app/(app)/admin/usage/page.tsx` — clean
- `app/(app)/admin/usage/UsageDashboard.tsx` — F-403, F-409, F-411, F-419
- `app/(app)/admin/workspace/page.tsx` — clean
- `app/(app)/admin/workspace/WorkspaceAdmin.tsx` — F-415
- `app/(app)/dashboard/page.tsx` — F-426, F-445, F-450
- `app/(app)/layout.tsx` — clean
- `app/(app)/projects/page.tsx` — F-410, F-426, F-427, F-450
- `app/(app)/settings/api-keys/page.tsx` — F-422
- `app/(app)/settings/page.tsx` — clean
- `app/(app)/settings/profile/page.tsx` — F-430
- `app/(app)/settings/skills/page.tsx` — clean
- `app/(app)/settings/usage/page.tsx` — F-428
- `app/(app)/templates/page.tsx` — F-429
- `app/(legal)/layout.tsx` — clean
- `app/(legal)/legal/page.tsx` — clean
- `app/(legal)/privacy/page.tsx` — F-418
- `app/(legal)/terms/page.tsx` — clean
- `app/builder/page.tsx` — F-401
- `app/error.tsx` — F-436
- `app/global-error.tsx` — clean
- `app/globals.css` — clean
- `app/landing.tsx` — F-448
- `app/layout.tsx` — clean
- `app/login/page.tsx` — clean
- `app/page.tsx` — clean
- `app/providers.tsx` — F-413
- `app/reset-password/page.tsx` — clean
- `app/reset-password/ResetPasswordForm.tsx` — clean
- `app/signup/page.tsx` — clean
- `components/admin/Accordion.tsx` — F-408
- `components/admin/admin-nav.ts` — clean
- `components/admin/AdminCard.tsx` — clean
- `components/admin/AdminIcon.tsx` — clean
- `components/admin/AdminNav.tsx` — clean
- `components/admin/AdminPage.tsx` — clean
- `components/admin/AdminSkeleton.tsx` — clean
- `components/admin/AdminTable.tsx` — clean
- `components/admin/AdminTabs.tsx` — clean
- `components/admin/ConfirmAction.tsx` — F-407
- `components/admin/StatTile.tsx` — F-438
- `components/admin/StatusBanner.tsx` — clean
- `components/admin/StatusPill.tsx` — F-434
- `components/app/.cursor/rules/home-page-components.md` — clean
- `components/app/(home)/sections/ai-readiness/ControlPanel.tsx` — F-448
- `components/app/(home)/sections/ai-readiness/InlineResults.tsx` — F-448, F-433
- `components/app/(home)/sections/ai-readiness/MetricBars.tsx` — clean
- `components/app/(home)/sections/ai-readiness/RadarChart.tsx` — clean
- `components/app/(home)/sections/ai-readiness/ScoreChart.tsx` — clean
- `components/app/(home)/sections/endpoints/EndpointsCrawl/EndpointsCrawl.tsx` — clean
- `components/app/(home)/sections/endpoints/EndpointsExtract/EndpointsExtract.tsx` — clean
- `components/app/(home)/sections/endpoints/EndpointsMap/EndpointsMap.tsx` — clean
- `components/app/(home)/sections/endpoints/EndpointsScrape/EndpointsScrape.tsx` — clean
- `components/app/(home)/sections/endpoints/EndpointsSearch/EndpointsSearch.tsx` — clean
- `components/app/(home)/sections/endpoints/Extract/Extract.tsx` — clean
- `components/app/(home)/sections/endpoints/Mcp/Mcp.tsx` — clean
- `components/app/(home)/sections/hero-flame/data.json` — clean
- `components/app/(home)/sections/hero-flame/HeroFlame.tsx` — clean
- `components/app/(home)/sections/hero-input/_svg/ArrowRight.tsx` — clean
- `components/app/(home)/sections/hero-input/_svg/Globe.tsx` — clean
- `components/app/(home)/sections/hero-input/Button/Button.tsx` — clean
- `components/app/(home)/sections/hero-input/HeroInput.tsx` — clean
- `components/app/(home)/sections/hero-input/Tabs/Mobile/Mobile.tsx` — clean
- `components/app/(home)/sections/hero-input/Tabs/Tabs.tsx` — clean
- `components/app/(home)/sections/hero-scraping/_svg/BrowserMobile.tsx` — clean
- `components/app/(home)/sections/hero-scraping/_svg/BrowserTab.tsx` — clean
- `components/app/(home)/sections/hero-scraping/Code/Code.tsx` — clean
- `components/app/(home)/sections/hero-scraping/Code/Loading/_svg/Check.tsx` — clean
- `components/app/(home)/sections/hero-scraping/Code/Loading/Loading.tsx` — clean
- `components/app/(home)/sections/hero-scraping/HeroScraping.css` — clean
- `components/app/(home)/sections/hero-scraping/HeroScraping.tsx` — clean
- `components/app/(home)/sections/hero-scraping/Tag/Tag.tsx` — clean
- `components/app/(home)/sections/hero/Background/_svg/CenterStar.tsx` — clean
- `components/app/(home)/sections/hero/Background/Background.tsx` — clean
- `components/app/(home)/sections/hero/Background/BackgroundOuterPiece.tsx` — clean
- `components/app/(home)/sections/hero/Badge/Badge.tsx` — clean
- `components/app/(home)/sections/hero/Hero.tsx` — clean
- `components/app/(home)/sections/hero/Pixi/Pixi.tsx` — clean
- `components/app/(home)/sections/hero/Pixi/tickers/ascii.ts` — clean
- `components/app/(home)/sections/hero/Pixi/tickers/features/cell.ts` — clean
- `components/app/(home)/sections/hero/Pixi/tickers/features/cellReveal.ts` — clean
- `components/app/(home)/sections/hero/Pixi/tickers/features/components/AnimatedRect.ts` — clean
- `components/app/(home)/sections/hero/Pixi/tickers/features/components/BlinkingContainer.ts` — clean
- `components/app/(home)/sections/hero/Pixi/tickers/features/components/Dot.ts` — clean
- `components/app/(home)/sections/hero/Pixi/tickers/features/crawl.ts` — clean
- `components/app/(home)/sections/hero/Pixi/tickers/features/index.ts` — clean
- `components/app/(home)/sections/hero/Pixi/tickers/features/mapping.ts` — clean
- `components/app/(home)/sections/hero/Pixi/tickers/features/scrape.ts` — clean
- `components/app/(home)/sections/hero/Pixi/tickers/features/search.ts` — clean
- `components/app/(home)/sections/hero/Title/Title.tsx` — clean
- `components/app/auth/AuthModal.tsx` — F-417
- `components/app/auth/AuthNav.tsx` — F-448
- `components/app/auth/AuthProvider.tsx` — F-420
- `components/app/generation/GenerationProvider.tsx` — clean
- `components/app/generation/SidebarInput.tsx` — F-405
- `components/app/generation/SidebarQuickInput.tsx` — F-448
- `components/app/home/HomeLanding.tsx` — F-435
- `components/app/studio/AppHeader.tsx` — clean
- `components/app/studio/PageTabs.tsx` — clean
- `components/app/studio/ProjectBar.tsx` — clean
- `components/app/studio/PromptBox.tsx` — clean
- `components/app/studio/studio.css` — clean
- `components/app/studio/StudioButton.tsx` — clean
- `components/app/studio/StudioField.tsx` — clean
- `components/app/studio/StudioLogo.tsx` — clean
- `components/app/studio/StudioSelect.tsx` — clean
- `components/app/studio/StudioShell.tsx` — clean
- `components/app/studio/StudioTextarea.tsx` — clean
- `components/app/studio/ThemeToggle.tsx` — F-440
- `components/app/studio/UserMenu.tsx` — F-410
- `components/CodeApplicationProgress.tsx` — F-433
- `components/connectors/ConnectorsGitHubCard.tsx` — F-407
- `components/dashboard/ExamplePromptCards.tsx` — clean
- `components/dashboard/project-card.module.css` — clean
- `components/dashboard/ProjectCard.tsx` — F-402, F-406
- `components/dashboard/PromptHero.tsx` — F-449
- `components/dashboard/PromptTipsPanel.tsx` — F-444
- `components/dashboard/SetupChecklist.tsx` — F-421
- `components/errors/ErrorId.tsx` — clean
- `components/errors/PanelErrorBoundary.tsx` — clean
- `components/FirecrawlIcon.tsx` — clean
- `components/FirecrawlLogo.tsx` — clean
- `components/HeroInput.tsx` — F-448
- `components/HMRErrorDetector.tsx` — F-448
- `components/layout/AccountMenu.tsx` — F-410, F-413, F-414
- `components/layout/CommandPalette.tsx` — F-425
- `components/layout/CreditMeter.tsx` — clean
- `components/layout/Sidebar.tsx` — F-402
- `components/layout/WorkspaceDropdown.tsx` — F-410
- `components/legal/LegalDraftBanner.tsx` — F-440
- `components/SandboxPreview.tsx` — F-448
- `components/settings/SkillsPanel.tsx` — F-422, F-426
- `components/settings/StorageUsage.tsx` — clean
- `components/shared/animated-dot-icon.tsx` — clean
- `components/shared/animated-height.tsx` — clean
- `components/shared/ascii-background.tsx` — clean
- `components/shared/ascii-flame-background.tsx` — clean
- `components/shared/button/Button.css` — clean
- `components/shared/button/Button.tsx` — clean
- `components/shared/buttons/capsule-button.tsx` — clean
- `components/shared/buttons/fire-action-link.tsx` — clean
- `components/shared/buttons/index.ts` — clean
- `components/shared/buttons/slate-button.tsx` — clean
- `components/shared/color-styles/color-styles.tsx` — clean
- `components/shared/combobox/combobox.tsx` — F-448
- `components/shared/effects/.cursor/rules/flame-effects.md` — clean
- `components/shared/effects/flame/ascii-explosion.tsx` — clean
- `components/shared/effects/flame/auth-pulse/auth-pulse.tsx` — clean
- `components/shared/effects/flame/auth-pulse/pulse-data.json` — clean
- `components/shared/effects/flame/core-flame.json` — clean
- `components/shared/effects/flame/core-flame.tsx` — clean
- `components/shared/effects/flame/explosion-data.json` — clean
- `components/shared/effects/flame/flame-background.tsx` — clean
- `components/shared/effects/flame/Flame.tsx` — clean
- `components/shared/effects/flame/hero-flame-data.json` — clean
- `components/shared/effects/flame/hero-flame.tsx` — clean
- `components/shared/effects/flame/index.ts` — clean
- `components/shared/effects/flame/slate-grid/grid-data.json` — clean
- `components/shared/effects/flame/slate-grid/slate-grid.tsx` — clean
- `components/shared/effects/flame/subtle-explosion.tsx` — clean
- `components/shared/effects/flame/subtle-wave/subtle-wave.tsx` — clean
- `components/shared/effects/flame/subtle-wave/wave-data.json` — clean
- `components/shared/effects/index.ts` — clean
- `components/shared/effects/subtle-ascii-animation.tsx` — clean
- `components/shared/firecrawl-icon/firecrawl-icon-static.tsx` — clean
- `components/shared/firecrawl-icon/firecrawl-icon.tsx` — clean
- `components/shared/header/_svg/Logo.tsx` — clean
- `components/shared/header/BrandKit/_svg/Download.tsx` — clean
- `components/shared/header/BrandKit/_svg/Guidelines.tsx` — clean
- `components/shared/header/BrandKit/_svg/Icon.tsx` — clean
- `components/shared/header/BrandKit/BrandKit.tsx` — clean
- `components/shared/header/Dropdown/Content/Content.tsx` — clean
- `components/shared/header/Dropdown/Content/NavItemRow.tsx` — clean
- `components/shared/header/Dropdown/Github/Flame/data.json` — clean
- `components/shared/header/Dropdown/Github/Flame/Flame.tsx` — clean
- `components/shared/header/Dropdown/Github/Github.tsx` — clean
- `components/shared/header/Dropdown/Mobile/Item/Item.tsx` — clean
- `components/shared/header/Dropdown/Mobile/Mobile.tsx` — clean
- `components/shared/header/Dropdown/Stories/_svg/ArrowUp.tsx` — clean
- `components/shared/header/Dropdown/Stories/_svg/Replit.tsx` — clean
- `components/shared/header/Dropdown/Stories/Flame/Flame.tsx` — clean
- `components/shared/header/Dropdown/Stories/Stories.tsx` — clean
- `components/shared/header/Dropdown/Wrapper/Wrapper.tsx` — clean
- `components/shared/header/Github/_svg/GithubIcon.tsx` — clean
- `components/shared/header/Github/GithubClient.tsx` — clean
- `components/shared/header/HeaderContext.tsx` — clean
- `components/shared/header/Nav/_svg/Affiliate.tsx` — clean
- `components/shared/header/Nav/_svg/Api.tsx` — clean
- `components/shared/header/Nav/_svg/ArrowRight.tsx` — clean
- `components/shared/header/Nav/_svg/Careers.tsx` — clean
- `components/shared/header/Nav/_svg/Changelog.tsx` — clean
- `components/shared/header/Nav/_svg/Chats.tsx` — clean
- `components/shared/header/Nav/_svg/Lead.tsx` — clean
- `components/shared/header/Nav/_svg/MCP.tsx` — clean
- `components/shared/header/Nav/_svg/Platforms.tsx` — clean
- `components/shared/header/Nav/_svg/Research.tsx` — clean
- `components/shared/header/Nav/_svg/Student.tsx` — clean
- `components/shared/header/Nav/_svg/Templates.tsx` — clean
- `components/shared/header/Nav/Item/_svg/ChevronDown.tsx` — clean
- `components/shared/header/Nav/Item/Item.tsx` — clean
- `components/shared/header/Nav/Nav.tsx` — clean
- `components/shared/header/Nav/RenderEndpointIcon.tsx` — clean
- `components/shared/header/Toggle/Toggle.tsx` — clean
- `components/shared/header/Wrapper/Wrapper.tsx` — clean
- `components/shared/hero-flame.tsx` — clean
- `components/shared/icons/animated-chevron.tsx` — clean
- `components/shared/icons/animated-icons.tsx` — clean
- `components/shared/icons/arrow-animated.tsx` — clean
- `components/shared/icons/check.tsx` — clean
- `components/shared/icons/chevron-slide.tsx` — clean
- `components/shared/icons/copied.tsx` — clean
- `components/shared/icons/copy.tsx` — clean
- `components/shared/icons/curve.tsx` — clean
- `components/shared/icons/fingerprint-icon.tsx` — clean
- `components/shared/icons/GitHub.tsx` — clean
- `components/shared/icons/Logo.tsx` — clean
- `components/shared/icons/openai.tsx` — clean
- `components/shared/icons/source-icon.tsx` — clean
- `components/shared/icons/symbol-colored.tsx` — clean
- `components/shared/icons/symbol-white.tsx` — clean
- `components/shared/icons/tremor-placeholder.tsx` — clean
- `components/shared/icons/wordmark-colored.tsx` — clean
- `components/shared/icons/wordmark-white.tsx` — clean
- `components/shared/image/getImageSrc.ts` — clean
- `components/shared/image/Image.tsx` — clean
- `components/shared/layout/animated-height.tsx` — clean
- `components/shared/layout/animated-width.tsx` — clean
- `components/shared/layout/curvy-rect-divider.tsx` — clean
- `components/shared/layout/curvy-rect.tsx` — clean
- `components/shared/loading/Shimmer.tsx` — F-448
- `components/shared/loading/usage-loading.tsx` — F-448
- `components/shared/lockBody.tsx` — clean
- `components/shared/logo-cloud/index.ts` — F-448
- `components/shared/logo-cloud/logo-cloud.tsx` — F-448
- `components/shared/logo-cloud/logo-cloud2/Logocloud.css` — clean
- `components/shared/logo-cloud/logo-cloud2/Logocloud.tsx` — F-448
- `components/shared/notifications/slack-notification.tsx` — F-448
- `components/shared/pixi/Pixi.tsx` — clean
- `components/shared/pixi/PixiAssetManager.ts` — clean
- `components/shared/pixi/utils.ts` — clean
- `components/shared/Playground/Context/types.ts` — clean
- `components/shared/portal-to-body/PortalToBody.tsx` — clean
- `components/shared/preview/json-error-highlighter.tsx` — F-448
- `components/shared/preview/live-preview-frame.tsx` — F-448
- `components/shared/preview/multiple-web-browsers.tsx` — F-448
- `components/shared/preview/web-browser.tsx` — F-448
- `components/shared/pylon.tsx` — F-448
- `components/shared/search-params-provider/search-params-provider.tsx` — clean
- `components/shared/section-head/SectionHead.css` — clean
- `components/shared/section-head/SectionHead.tsx` — clean
- `components/shared/section-title/SectionTitle.tsx` — clean
- `components/shared/tabs/Tabs.tsx` — F-443
- `components/shared/ui/app-dialog.tsx` — F-448
- `components/shared/ui/ascii-dot-loader.tsx` — F-448
- `components/shared/ui/dot-grid-loader.tsx` — F-448
- `components/shared/ui/empty-state.tsx` — F-448
- `components/shared/ui/index.ts` — F-448
- `components/shared/ui/loading-state.tsx` — F-448
- `components/shared/ui/mobile-sheet.tsx` — F-448
- `components/shared/ui/stat-card.tsx` — F-448
- `components/shared/utils/portal-to-body.tsx` — clean
- `components/templates/CategoryChips.tsx` — clean
- `components/templates/SaveAsTemplateDialog.tsx` — F-407, F-432
- `components/templates/TemplateCard.tsx` — clean
- `components/templates/TemplateGallery.tsx` — F-412
- `components/templates/TemplateSheet.tsx` — F-407, F-412
- `components/ui/button.tsx` — clean
- `components/ui/checkbox.tsx` — clean
- `components/ui/code.tsx` — clean
- `components/ui/input.tsx` — clean
- `components/ui/label.tsx` — clean
- `components/ui/motion/scramble-text.tsx` — clean
- `components/ui/select.tsx` — clean
- `components/ui/shadcn/accordion.tsx` — clean
- `components/ui/shadcn/alert-dialog.tsx` — clean
- `components/ui/shadcn/badge.tsx` — clean
- `components/ui/shadcn/button.css` — clean
- `components/ui/shadcn/button.tsx` — clean
- `components/ui/shadcn/card.tsx` — clean
- `components/ui/shadcn/checkbox.tsx` — clean
- `components/ui/shadcn/collapsible.tsx` — clean
- `components/ui/shadcn/combobox.tsx` — clean
- `components/ui/shadcn/context-menu.tsx` — clean
- `components/ui/shadcn/data-table.tsx` — clean
- `components/ui/shadcn/dialog.tsx` — clean
- `components/ui/shadcn/dropdown-menu.tsx` — clean
- `components/ui/shadcn/form.tsx` — clean
- `components/ui/shadcn/input.tsx` — clean
- `components/ui/shadcn/label.tsx` — clean
- `components/ui/shadcn/navigation-menu.tsx` — clean
- `components/ui/shadcn/popover.tsx` — clean
- `components/ui/shadcn/progress.tsx` — clean
- `components/ui/shadcn/scroll-area.tsx` — clean
- `components/ui/shadcn/select.tsx` — clean
- `components/ui/shadcn/separator.tsx` — clean
- `components/ui/shadcn/sheet.tsx` — clean
- `components/ui/shadcn/slider.tsx` — clean
- `components/ui/shadcn/switch.tsx` — clean
- `components/ui/shadcn/tabs.tsx` — clean
- `components/ui/shadcn/textarea.tsx` — clean
- `components/ui/shadcn/toggle.tsx` — clean
- `components/ui/shadcn/tooltip-radix.tsx` — clean
- `components/ui/shadcn/tooltip.tsx` — clean
- `components/ui/spinner.tsx` — F-441
- `components/ui/textarea.tsx` — clean
- `components/ui/Toaster.tsx` — clean
- `hooks/useDebouncedCallback.ts` — F-437, F-448
- `hooks/useDebouncedEffect.ts` — F-424
- `hooks/useDraftStorage.ts` — clean
- `hooks/useSwitchingCode.ts` — F-448
- `hooks/useUnsavedChangesWarning.ts` — clean
- `styles/additional-styles/custom-fonts.css` — clean
- `styles/additional-styles/theme.css` — clean
- `styles/additional-styles/utility-patterns.css` — clean
- `styles/chrome-bug.css` — clean
- `styles/colors.json` — clean
- `styles/components/.cursor/rules/component-styles.md` — clean
- `styles/components/button.css` — clean
- `styles/components/code.css` — clean
- `styles/components/index.css` — clean
- `styles/components/toast.css` — clean
- `styles/design-system/.cursor/rules/design-system.md` — clean
- `styles/design-system/animations.css` — clean
- `styles/design-system/base/body.css` — clean
- `styles/design-system/base/layout.css` — clean
- `styles/design-system/base/reset.css` — clean
- `styles/design-system/colors.css` — clean
- `styles/design-system/fonts.css` — clean
- `styles/design-system/typography.css` — clean
- `styles/design-system/utilities.css` — clean
- `styles/fire.css` — clean
- `styles/inside-border-fix.css` — clean
- `styles/main.css` — F-400
- `utils/cn.ts` — clean
- `utils/init-canvas.ts` — F-423
- `utils/set-timeout-on-visible.ts` — clean
- `utils/sleep.ts` — clean
