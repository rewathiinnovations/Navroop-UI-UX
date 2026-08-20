# Phase 5b — Section L (skills) and Section M (project memory / docs)

Scope: `audit/_scope-p5-docs.txt` (28 files) + `audit/_scope-p5-skills.txt` (409 files) = 437 files.
Finding ids **F-500 – F-599**. Read-only audit; no application code, config, schema, test or doc
was modified. The only file written is this one.

**Everything in this report was read.** Nothing is blocked or unread, with one deliberate
exception: `.cursor/.env.deploy` (10 lines) was **not opened** — it is a secrets file, it is
correctly gitignored (`git check-ignore` → `.gitignore:63`), and `.claude/settings.json:7`
denies reading it. Its _status_ is audited (F-552); its contents are not.

---

## Headline

The repository deleted its entire sandbox subsystem on 2026-08-19 (migration
`prisma/migrations/20260819010000_drop_sandbox_columns/migration.sql`, whose own comment reads
_"previews are compiled in the browser and published builds are bundled in-process, so there is
no VM to track, meter, or route"_). `lib/sandbox/` does not exist. `SandboxProviderConfig` is not
in `prisma/schema.prisma`. `PreviewMode` has exactly one member, `STATIC`.

`docs/coolify.md` was updated. **`AGENTS.md`, `README.md`, `.cursor/README.md`,
`.cursor/rules/multi-agent-ownership.mdc`, `.cursor/rules/stack.mdc`, `docs/release.md` and
`docs/e2e-test-and-fix-prompt.md` were not.** They still describe VM boots, provider routing,
sandbox minutes, two cron endpoints that return 404, an admin page that does not exist, and an
API route (`/api/apply-ai-code-stream`) that was deleted. `keep-cursor-current.mdc` — the rule
whose entire job is preventing this — does not list `README.md`, `CLAUDE.md`, `docs/`,
`stack.mdc` or `admin-ownership.mdc` in its sync set (F-551). That omission is the mechanism.

Section L is the opposite story: the two skill trees are **byte-for-byte in sync** (204/204
paired files identical). The problem there is not drift, it is that 14 of the copied skills
automate _Cursor's_ internals and one of them (`shell`) loses its safety flag in Claude Code.

---

# Section L — skills

## L.1 Drift table (all 409 files)

Method: SHA-256 of every file under `.claude/skills/` and `.cursor/skills/`, paired by mapping
`.cursor/skills/{cursor,superpowers}/<skill>/…` and `.cursor/skills/<skill>/…` onto
`.claude/skills/<skill>/…`.

| Metric                            | Count                          |
| --------------------------------- | ------------------------------ |
| Files under `.claude/skills/`     | 204                            |
| Files under `.cursor/skills/`     | 205                            |
| **Paired**                        | **204**                        |
| **Byte-identical**                | **204 (100 %)**                |
| **Content differences**           | **0**                          |
| Present only in `.claude/skills/` | 0                              |
| Present only in `.cursor/skills/` | **1** — `cursor/loop/SKILL.md` |
| Total in scope                    | 409                            |

Per-skill identical groups (37 skills, all identical):

| Skill                            | Files | Cursor location                                 | Verdict                                       |
| -------------------------------- | ----- | ----------------------------------------------- | --------------------------------------------- |
| `automate`                       | 1     | `.cursor/skills/cursor/automate/`               | identical                                     |
| `autopilot`                      | 1     | `.cursor/skills/cursor/autopilot/`              | identical                                     |
| `brainstorming`                  | 8     | `.cursor/skills/superpowers/brainstorming/`     | identical                                     |
| `canvas`                         | 16    | `.cursor/skills/cursor/canvas/`                 | identical                                     |
| `create-hook`                    | 1     | `.cursor/skills/cursor/create-hook/`            | identical                                     |
| `create-rule`                    | 1     | `.cursor/skills/cursor/create-rule/`            | identical                                     |
| `create-skill`                   | 1     | `.cursor/skills/cursor/create-skill/`           | identical                                     |
| `create-subagent`                | 1     | `.cursor/skills/cursor/create-subagent/`        | identical                                     |
| `design`                         | 35    | `.cursor/skills/design/`                        | identical                                     |
| `design-system`                  | 27    | `.cursor/skills/design-system/`                 | identical                                     |
| `dispatching-parallel-agents`    | 1     | `.cursor/skills/superpowers/…`                  | identical                                     |
| `executing-plans`                | 1     | `.cursor/skills/superpowers/…`                  | identical                                     |
| `finishing-a-development-branch` | 1     | `.cursor/skills/superpowers/…`                  | identical                                     |
| `migrate-to-skills`              | 1     | `.cursor/skills/cursor/migrate-to-skills/`      | identical                                     |
| `onboard`                        | 1     | `.cursor/skills/cursor/onboard/`                | identical                                     |
| `receiving-code-review`          | 1     | `.cursor/skills/superpowers/…`                  | identical                                     |
| `rename-chat`                    | 1     | `.cursor/skills/cursor/rename-chat/`            | identical                                     |
| `requesting-code-review`         | 2     | `.cursor/skills/superpowers/…`                  | identical                                     |
| `review`                         | 1     | `.cursor/skills/cursor/review/`                 | identical                                     |
| `review-bugbot`                  | 1     | `.cursor/skills/cursor/review-bugbot/`          | identical                                     |
| `review-security`                | 1     | `.cursor/skills/cursor/review-security/`        | identical                                     |
| `sdk`                            | 1     | `.cursor/skills/cursor/sdk/`                    | identical                                     |
| `shell`                          | 1     | `.cursor/skills/cursor/shell/`                  | identical                                     |
| `split-to-prs`                   | 1     | `.cursor/skills/cursor/split-to-prs/`           | identical                                     |
| `statusline`                     | 1     | `.cursor/skills/cursor/statusline/`             | identical                                     |
| `subagent-driven-development`    | 6     | `.cursor/skills/superpowers/…`                  | identical                                     |
| `systematic-debugging`           | 11    | `.cursor/skills/superpowers/…`                  | identical                                     |
| `test-driven-development`        | 2     | `.cursor/skills/superpowers/…`                  | identical                                     |
| `ui-styling`                     | 16    | `.cursor/skills/ui-styling/`                    | identical                                     |
| `ui-ux-pro-max`                  | 44    | `.cursor/skills/ui-ux-pro-max/`                 | identical                                     |
| `update-cli-config`              | 1     | `.cursor/skills/cursor/update-cli-config/`      | identical                                     |
| `update-cursor-settings`         | 1     | `.cursor/skills/cursor/update-cursor-settings/` | identical                                     |
| `using-git-worktrees`            | 1     | `.cursor/skills/superpowers/…`                  | identical                                     |
| `using-superpowers`              | 4     | `.cursor/skills/superpowers/…`                  | identical                                     |
| `verification-before-completion` | 1     | `.cursor/skills/superpowers/…`                  | identical                                     |
| `writing-plans`                  | 2     | `.cursor/skills/superpowers/…`                  | identical                                     |
| `writing-skills`                 | 7     | `.cursor/skills/superpowers/…`                  | identical                                     |
| **`loop`**                       | **1** | `.cursor/skills/cursor/loop/SKILL.md`           | **not copied — intentional, CLAUDE.md:54-55** |

The `loop` exclusion is documented and deliberate, so it is not a defect. It is, however, the
premise for F-500.

## L.2 Findings

### F-500 [MEDIUM] Two project skills shadow Claude Code built-in slash commands, breaking the rule CLAUDE.md states for `loop`

- Area: L
- Location: `.claude/skills/review/SKILL.md:1-16`, `.claude/skills/statusline/SKILL.md:1-23` (rule stated at `CLAUDE.md:54-55`)
- What happens: `CLAUDE.md:54-55` says _"The `loop` skill was not copied: Claude Code ships its own `/loop`, and a project skill of that name would shadow it."_ The same reasoning was not applied to `review` or `statusline`, which were copied and now sit at `.claude/skills/review/` and `.claude/skills/statusline/`. Claude Code ships `/review` and `/statusline` as built-ins. `.claude/skills/review/SKILL.md:10-11` then routes the user to `/review-bugbot` / `/review-security`, i.e. to Cursor's `bugbot` subagent (`.claude/skills/review-bugbot/SKILL.md:13` `subagent_type: "bugbot"`), which does not exist here. `.claude/skills/statusline/SKILL.md:14` configures `~/.cursor/cli-config.json`, which Claude Code does not read.
- Trigger: user types `/review` or `/statusline` in this repo.
- Impact: an operator gets the Cursor behaviour (or a dead subagent type) instead of the built-in command they asked for, or an ambiguous pick between two commands with the same name.
- Confidence: Confirmed (files and CLAUDE.md text); the built-in command list itself is external to the repo, but CLAUDE.md asserts the shadowing rule, so the inconsistency is internal and confirmed.
- Suggested fix: apply the `loop` decision consistently — delete `.claude/skills/review/` and `.claude/skills/statusline/` (they remain in `.cursor/skills/` for Cursor users), and extend the CLAUDE.md sentence to name every excluded skill and why. If they must stay, rename them so they cannot collide.

### F-501 [HIGH] Sixteen copied `cursor/*` skills instruct the agent to drive Cursor-only tools and paths

- Area: L
- Location: see table; rule acknowledged but not enforced at `CLAUDE.md:50-55`
- What happens: `CLAUDE.md:50-53` warns that these skills "describe Cursor, not Claude Code — do not follow their instructions here without checking they still make sense." That warning lives in a memory file; the skills themselves carry no such marker, and their `description:` frontmatter still advertises them for auto-selection. Each one names a tool or path that does not exist in this environment:

| Skill                    | Cursor-only mechanic                                                                                                             | Evidence                                                                                 |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `rename-chat`            | `cursor-app-control.rename_chat` MCP tool                                                                                        | `.claude/skills/rename-chat/SKILL.md:16`                                                 |
| `review`                 | `AskQuestion` tool                                                                                                               | `.claude/skills/review/SKILL.md:8`                                                       |
| `review-bugbot`          | `subagent_type: "bugbot"`, `run_in_background`                                                                                   | `.claude/skills/review-bugbot/SKILL.md:11-13`                                            |
| `review-security`        | `subagent_type: "security-review"`                                                                                               | `.claude/skills/review-security/SKILL.md:9-13`                                           |
| `automate`               | `cursor-app-control.open_automation`, `~/.cursor/mcps/*/SERVER_METADATA.json`, cursor.com dashboard, "Agents Window"             | `.claude/skills/automate/SKILL.md:64,66,77,103,119-124,206,219-220`                      |
| `canvas`                 | canvases must be written to `/Users/<user>/.cursor/projects/<workspace>/canvases/`; SDK at `~/.cursor/skills-cursor/canvas/sdk/` | `.claude/skills/canvas/SKILL.md:50,66,101,112`; `.claude/skills/canvas/sdk/index.d.ts:6` |
| `create-rule`            | writes `.cursor/rules/*.mdc`; `AskQuestion`                                                                                      | `.claude/skills/create-rule/SKILL.md:11,35,41,161`                                       |
| `create-skill`           | personal skills at `~/.cursor/skills/`; `AskQuestion`; `disable-model-invocation` guidance                                       | `.claude/skills/create-skill/SKILL.md:16,32-40,64-67,77,89`                              |
| `create-subagent`        | subagents at `.cursor/agents/` / `~/.cursor/agents/`                                                                             | `.claude/skills/create-subagent/SKILL.md:28-29,33-35,178-179,185-190,223`                |
| `create-hook`            | hooks at `.cursor/hooks.json`, `~/.cursor/hooks/`                                                                                | `.claude/skills/create-hook/SKILL.md:28-34,82,137,224-225`                               |
| `migrate-to-skills`      | migrates `.cursor/rules` + `.cursor/commands` into `.cursor/skills`                                                              | `.claude/skills/migrate-to-skills/SKILL.md:4-8,20-26,95,103,114-115`                     |
| `onboard`                | `AskQuestion`, `cursor_dialog`, `SwitchMode` with `target_mode_id: "plan"`                                                       | `.claude/skills/onboard/SKILL.md:31-33,41-45`                                            |
| `statusline`             | `~/.cursor/cli-config.json`, `~/.cursor/worktrees/`                                                                              | `.claude/skills/statusline/SKILL.md:14,20,58,78`                                         |
| `update-cli-config`      | `~/.cursor/cli-config.json`, `.cursor/cli.json` overrides                                                                        | `.claude/skills/update-cli-config/SKILL.md:14,18,20,24`                                  |
| `update-cursor-settings` | Cursor/VSCode `settings.json`, "Cursor Settings > Agent > Attribution"                                                           | `.claude/skills/update-cursor-settings/SKILL.md:11,98`                                   |
| `sdk`                    | `@cursor/sdk` / `cursor-sdk`, `CURSOR_API_KEY`, cursor.com dashboards                                                            | `.claude/skills/sdk/SKILL.md:22-23,290,327,377-379`                                      |

The three most actively wrong are `create-rule`, `create-subagent` and `create-hook`: followed literally they write **new** `.cursor/rules/*.mdc`, `.cursor/agents/*.md` and `.cursor/hooks.json` entries that Claude Code will never load, and `migrate-to-skills:97,105` instructs the agent to **delete the original rule/command file** after converting it.

The warning list at `CLAUDE.md:50-53` is itself inaccurate in both directions: it names `autopilot`, which is portable (`.claude/skills/autopilot/SKILL.md` uses only `gh pr view` / `gh pr checks` and generic git), and it omits `review`, `review-bugbot` and `review-security`, all three of which depend on Cursor-provided subagent types or the `AskQuestion` tool.

- Trigger: any request that matches one of those `description:` lines — e.g. "add a coding standard" selects `create-rule`.
- Impact: silent no-ops (config written where nothing reads it), or destructive edits to `.cursor/rules/` — the tree `keep-cursor-current.mdc:12-14` and `.cursor/README.md:24-38` treat as the source of truth.
- Confidence: Confirmed
- Suggested fix: do not vendor Cursor-mechanics skills into the Claude Code tree at all — keep them in `.cursor/skills/cursor/` only, where they are correct. If any must remain in `.claude/skills/`, put a one-line "Cursor only — do not follow in Claude Code" as the _first_ body line of each `SKILL.md` and strip the auto-selecting `description:`, so the guard travels with the file instead of living in `CLAUDE.md`.

### F-502 [MEDIUM] `disable-model-invocation` is a Cursor-only frontmatter key; six slash-only skills become model-invocable

- Area: L
- Location: `.claude/skills/{create-subagent,migrate-to-skills,onboard,rename-chat,review,shell}/SKILL.md` frontmatter; the semantics are stated at `.claude/skills/create-skill/SKILL.md:89` and `.claude/skills/migrate-to-skills/SKILL.md:82`
- What happens: `.claude/skills/migrate-to-skills/SKILL.md:82` states the contract — _"The `disable-model-invocation: true` field prevents the model from automatically invoking this skill. Slash commands are designed to be explicitly triggered by the user via the `/` menu, not automatically suggested by the model."_ Claude Code's skill frontmatter is `name` / `description` / `allowed-tools`; unknown keys are ignored. Six skills carry that key and rely on it. `rename-chat` and `canvas`/`automate` additionally carry `environments:` / `metadata:`, which are likewise Cursor-only.
- Trigger: a prompt whose wording matches one of those `description:` fields, with no `/` invocation.
- Impact: skills intended to be explicitly summoned can be auto-selected. `onboard` would run an onboarding interview mid-task; `migrate-to-skills` would start rewriting `.cursor/rules/`; `review` would ask which review to run.
- Confidence: Likely (the key's absence from Claude Code's schema is external knowledge; the _intent_ and the repo's reliance on it are confirmed in-file)
- Suggested fix: for each of the six, either delete the skill from `.claude/skills/` or rewrite `description:` so it can only be read as an explicit-invocation instruction ("Use only when the user types /<name>"), since description matching is the sole gate available.

### F-503 [HIGH] `shell` auto-executes arbitrary commands and its only guard is the ignored `disable-model-invocation` flag

- Area: L
- Location: `.claude/skills/shell/SKILL.md:1-24` (frontmatter `disable-model-invocation: true` at line 7; behaviour at lines 15-18)
- What happens: the skill body says _"Treat all user text after the `/shell` invocation as the literal shell command to run. Execute that command immediately with the terminal tool. Do not rewrite, explain, or 'improve' the command before running it. Do not inspect the repository first."_ Its `description:` (lines 3-6) is prose that a model can match against ordinary requests. The only thing stopping ambient selection is `disable-model-invocation`, which per F-502 has no effect here.
- Trigger: a request phrased like "just run this in the terminal: …" with no `/shell`.
- Impact: a skill whose entire content is "run whatever text follows, unmodified, without looking at the repo first" can be selected without the user invoking it. In a repo whose rules forbid non-owner agents from touching `:3000`/`:3001`, `prisma generate`, and locked binaries (`single-dev-server.mdc:53-61`), that is a direct route past every one of those prohibitions.
- Confidence: Confirmed (skill contents); Likely on the flag being ignored (see F-502)
- Suggested fix: delete `.claude/skills/shell/`. There is no Claude Code behaviour it adds — the agent already has a shell — and the skill exists purely to suppress the safety review that normally precedes running a command.

### F-504 [MEDIUM] `ui-ux-pro-max` invokes a script by absolute path outside the repo; the 44 vendored files are never used

- Area: L
- Location: `.claude/skills/ui-ux-pro-max/SKILL.md:61,72,80,89,114,129,137,162,193,194,212,221,224,230,243,246` (identical at `.cursor/skills/ui-ux-pro-max/SKILL.md`)
- What happens: every worked command in the skill is `python3 ~/.cursor/skills/ui-ux-pro-max/scripts/search.py …`. The copy that ships with the repository is at `.claude/skills/ui-ux-pro-max/scripts/search.py` (and `.cursor/skills/ui-ux-pro-max/scripts/search.py`). The home-directory path is a user-profile install that `skills-availability.mdc:12` explicitly describes as _not_ the in-repo set. On this workstation the shell is Windows (`python3` is also not the usual launcher name).
- Trigger: any UI/UX brief request that reaches step 2a of the skill.
- Impact: the whole point of vendoring — `.cursor/README.md:89` _"copies of the Superpowers plugin so agents do not depend only on the user plugin cache"_ — is defeated for the largest skill in the tree (44 files). The command fails, or silently runs a _different, unversioned_ copy from the profile.
- Confidence: Confirmed
- Suggested fix: make the paths relative to the skill directory in both trees, and state the interpreter as the resolved one for the platform. A single sed-equivalent pass over the 16 call sites fixes it; keep the two trees byte-identical afterwards.

### F-505 [MEDIUM] `canvas` writes to a hard-coded macOS Cursor-managed directory

- Area: L
- Location: `.claude/skills/canvas/SKILL.md:50,101,112`; SDK reference `.claude/skills/canvas/sdk/index.d.ts:6`
- What happens: line 50 — _"Canvases live at `/Users/<user>/.cursor/projects/<workspace>/canvases/<name>.canvas.tsx`. The IDE only detects canvases written directly inside that exact directory."_ Line 112 repeats it as the debugging step. `sdk/index.d.ts:6` points at `~/.cursor/skills-cursor/canvas/SKILL.md`, a directory `create-skill/SKILL.md:67` describes as reserved for Cursor's internals. The workstation is Windows (`win32 10.0.26200`), so `/Users/<user>/…` is not even the right shape.
- Trigger: any request the canvas `description:` matches — the description is broad ("quantitative analyses, billing investigations, security audits, architecture reviews, data-heavy content…").
- Impact: the agent creates a file at a nonexistent absolute path, or under a literal `/Users/<user>/` directory in the repo root, then tells the user to open a canvas that no host will render. 16 files (the whole `sdk/` type surface) exist to support this.
- Confidence: Confirmed
- Suggested fix: drop `canvas` from `.claude/skills/` — it is an IDE-host feature, not a portable skill. Keep it under `.cursor/skills/cursor/canvas/` where the paths are correct.

### F-506 [LOW] Four compiled Python bytecode files are committed in the skill trees

- Area: L
- Location: `.claude/skills/ui-ux-pro-max/scripts/__pycache__/core.cpython-312.pyc`, `.../design_system.cpython-312.pyc`, and the two mirrors under `.cursor/skills/ui-ux-pro-max/scripts/__pycache__/` (all four confirmed tracked via `git ls-files`)
- What happens: `.gitignore:60-67` and `:86-91` carve out caches and secrets for both trees but say nothing about `__pycache__`. Four `.pyc` blobs for CPython 3.12 are therefore version-controlled.
- Trigger: any `pnpm install` / clone; they simply sit in the tree.
- Impact: opaque binaries in review; a stale `.pyc` can shadow an edited `.py` when timestamps line up; and they are the only binary artefacts in an otherwise text-only config tree.
- Confidence: Confirmed
- Suggested fix: add `__pycache__/` and `*.pyc` to the `.cursor` and `.claude` blocks in `.gitignore` and remove the four tracked files.

### F-507 [MEDIUM] The 204-file duplication has a stated sync obligation and no mechanism

- Area: L
- Location: obligation at `CLAUDE.md:47-48`; the ignored-but-never-generated manifest at `.gitignore:67` / `.cursor/rules/secrets.mdc:11`
- What happens: `CLAUDE.md:47-48` — _"**A skill edited in one place must be copied to the other**, or the two drift apart silently."_ Nothing checks it. `verify` has thirteen steps (`lib/verify/orchestrator.ts:75-166`); none compares the trees. `eslint.config.mjs:45-48` ignores both, so lint cannot notice either. `.gitignore:67` reserves `.cursor/**/.sync-manifest.json` and `secrets.mdc:11` names it as a thing that exists, but no file or script in the repo produces or reads one.
- Trigger: any edit to a `SKILL.md`.
- Impact: today the trees are perfectly in sync, which is exactly the moment the guard is cheap. The first single-tree edit is silent and the doc's own prediction comes true.
- Confidence: Confirmed
- Suggested fix: add a non-fatal `verify` step that hashes both trees and reports differing paths, using the same `{cursor,superpowers}/` mapping used here. Ten lines, and it converts a stated obligation into an observed one. Alternatively make one tree a build artefact of the other.

### F-508 [LOW] The `design` skill spends money on Gemini image generation with no cost note in any repo doc

- Area: L
- Location: `.claude/skills/design/SKILL.md:304`; `.claude/skills/design/scripts/logo/generate.py:59,145-151`
- What happens: `SKILL.md:304` instructs `export GEMINI_API_KEY="your-key"`, and `generate.py:151` calls `genai.Client(api_key=GEMINI_API_KEY)` against `gemini-2.5-flash-image` (line 62). The `description:` in the skill frontmatter advertises "logo generation (55 styles, Gemini AI)", "icon design (15 styles, SVG, Gemini 3.1 Pro)" and "social photos", i.e. it is auto-selectable. `GEMINI_API_KEY` is also the key the _product_ uses for code generation (`app/api/generate-ai-code-stream/route.ts:326`).
- Trigger: a request matching "design a logo" / "generate an icon".
- Impact: an agent can spend the deployment's generation budget on a design artefact with no plan check, no `checkCredits` call, and no mention in `AGENTS.md`'s cost accounting (`AGENTS.md:63`).
- Confidence: Confirmed
- Suggested fix: note in `skills-availability.mdc` which vendored skills call paid APIs and with which key, so the cost is visible in the same place the skill inventory is.

---

# Section M — project memory and docs

Every finding below cites a doc line and the code line that contradicts it.

## M.1 The sandbox removal

### F-520 [CRITICAL] `AGENTS.md` documents a subsystem that was deleted, across 17 lines including two whole bullets

- Area: M
- Location: `AGENTS.md:3,37,40,43,50,53,55,56,57,59,63,65,68,69,74,78,96` — vs `prisma/migrations/20260819010000_drop_sandbox_columns/migration.sql:1-38`
- What happens: the migration drops `SandboxProviderConfig`, the `SandboxStatus` enum, and every sandbox column on `Project`, `Workspace` and `Plan`. There is no `lib/sandbox/` directory. Concretely, every one of these is false:

| AGENTS.md                                | Claim                                                                                                                                                                                                                      | Code fact                                                                                                                                                                                                                                                                                          |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| :56 (whole bullet **Sandbox providers**) | `Prisma SandboxProviderConfig` + `lib/sandbox/router.ts` `selectProvider`, drivers e2b/modal/daytona                                                                                                                       | model absent from `prisma/schema.prisma` (38 models, none named `SandboxProviderConfig`); `lib/sandbox/` absent; `selectProvider` appears only in `prisma/migrations/…/migration.sql`                                                                                                              |
| :57 (whole bullet **Sandbox lifecycle**) | `lib/sandbox/manager.ts` `ensureSandbox(projectId)`; Prisma `SandboxStatus (NONE\|BOOTING\|READY\|DEAD\|FAILED)`; `POST/GET /api/projects/[id]/sandbox`; `POST /api/cron/reap-sandboxes`; `SANDBOX_IDLE_MINUTES` default 5 | file absent; enum dropped at `migration.sql:27`; route absent from the 140 `route.ts` handlers; `SANDBOX_IDLE_MINUTES` is read by no file in `lib/`, `app/`, `config/` or `scripts/`; `ensureSandbox` survives only as a negative assertion in `tests/unit/generate-provider-preflight.test.ts:36` |
| :53                                      | `withTemporaryNextExport` forces `output: 'export'` and restores the original bytes; guard `tests/unit/next-export-esm-config.test.ts`; failed export sets `LIVE_SANDBOX`                                                  | symbol not present in any non-generated source file; the test file does not exist; `PreviewMode` at `prisma/schema.prisma:41-43` has exactly one member, `STATIC`                                                                                                                                  |
| :55                                      | `loadRestoreFiles` must not fall back to `project.lastCode`                                                                                                                                                                | `loadRestoreFiles` does not exist; the `SnapshotReadError` callers are `lib/checkpoints/actions.ts`, `lib/export/collect.ts`, `lib/publish/files.ts`                                                                                                                                               |
| :69                                      | admin page `/admin/sandbox-providers`; `loadSandboxProvidersAdmin`; `providersFromPayload`                                                                                                                                 | page absent (15 admin pages exist, listed at `app/(app)/admin/*/page.tsx`); neither symbol exists anywhere                                                                                                                                                                                         |
| :78                                      | crons `POST /api/cron/reap-sandboxes` (10 min) and `POST /api/cron/check-sandbox-providers` (5 min)                                                                                                                        | neither route exists; the 14 that do are listed in `docs/coolify.md:36-51`                                                                                                                                                                                                                         |
| :96                                      | keep client files away from `lib/sandbox/test-run` and `lib/sandbox/provider-check-copy.ts`                                                                                                                                | both files absent; the guard's denylist still names the dead paths at `tests/unit/client-import-boundary.test.ts:63-64`                                                                                                                                                                            |
| :63                                      | plan/workspace sandbox minutes                                                                                                                                                                                             | `monthlySandboxMinutes` and `sandboxMinutesUsed` dropped at `migration.sql:22-24`                                                                                                                                                                                                                  |
| :24                                      | `assertInternalOrigin()` paragraph mentions sandbox routing                                                                                                                                                                | `lib/api/internal-origin.ts` exists and is correct; only the surrounding sandbox framing is stale                                                                                                                                                                                                  |

The contradiction is _inside the documentation set_: `docs/coolify.md:22` already says _"`E2B_API_KEY` is still read … but nothing consumes it: generated code no longer runs in a sandbox VM."_

- Trigger: any agent following `CLAUDE.md:9-13` — _"read it with the Read tool before changing product behaviour, schema, API routes, or layout. Do not guess at any of what it documents."_
- Impact: the file the project designates as its authoritative map is wrong about its own central subsystem. An agent will look for `lib/sandbox/manager.ts`, not find it, and either recreate it or conclude the checkout is broken. Two of the three other audit-phase source documents (`.cursor/README.md`, `multi-agent-ownership.mdc`) inherit the same error, and `audit/00-map.md:78` already reproduced `SandboxProviderConfig` into a "built from the code" table.
- Confidence: Confirmed
- Suggested fix: delete the **Sandbox providers** and **Sandbox lifecycle** bullets outright and replace them with one bullet describing what actually runs previews and publishes (see F-525). Strike the sandbox clauses from lines 3, 37, 40, 43, 50, 53, 55, 59, 63, 65, 68, 74, 78 and 96 in the same pass, and fix the client-boundary example at :96 to name modules that exist.

### F-521 [CRITICAL] `README.md` tells operators to schedule two cron endpoints that return 404

- Area: M
- Location: `README.md:82-87` and `README.md:124-129` — vs the 14 routes under `app/api/cron/*/route.ts`
- What happens: the Coolify setup section gives copy-paste `curl` blocks for **Reap idle sandboxes — every 10 minutes** (`/api/cron/reap-sandboxes`) and **Sandbox provider health — every 5 minutes** (`/api/cron/check-sandbox-providers`). Neither route exists. `README.md:180` also documents `SANDBOX_IDLE_MINUTES` defaults to 5, and `README.md:38-43` documents an `E2B_API_KEY` first-boot migration into `SandboxProviderConfig` rows.
  Worse in the other direction: `README.md`'s task list **omits** `/api/cron/cleanup-orphans`, which is real (`app/api/cron/cleanup-orphans/route.ts`) and which `AGENTS.md:78` and `docs/coolify.md:45` both schedule daily. `README.md:152-157` labels one block "Sentry quota + system-check digest — daily" but only curls `observability-quota`, so `/api/cron/system-checks-digest` gets no task either.
- Trigger: a fresh production deploy set up from `README.md` rather than `docs/coolify.md`.
- Impact: two permanently-failing scheduled tasks (noise that trains the operator to ignore cron alerts), plus **two real jobs never scheduled**. `cleanup-orphans` is the publish-compensation orphan sweeper (`lib/jobs/orphans.ts`); `system-checks-digest` is, by `docs/coolify.md:53`'s own account, _"the sender and cannot report its own silence: if it is never scheduled … nothing in the product notices and total silence looks identical to everything being healthy."_ Following `README.md` produces exactly that state.
- Confidence: Confirmed
- Suggested fix: delete the README's duplicated task list and link to `docs/coolify.md:32-97`, which is correct and already carries the dead-man's-switch warning. One list, one owner.

### F-522 [HIGH] `.cursor/README.md` carries the same sandbox staleness on 11 lines

- Area: M
- Location: `.cursor/README.md:43,47,60,62,63,64,70,72,75,76,81` — vs `prisma/migrations/20260819010000_drop_sandbox_columns/migration.sql`
- What happens: lines 63 and 64 are the **Sandbox providers** and **Sandbox lifecycle** bullets in miniature — `lib/sandbox/router.ts`, `lib/sandbox/manager.ts`, `Project.sandboxStatus`, `/api/projects/[id]/sandbox`, `/api/cron/reap-sandboxes`, `SANDBOX_IDLE_MINUTES`, `BOOT_WAIT_MS` / `BOOT_CLAIM_FRESH_MS` / `READY_POLL_MS`, `claimBoot`, `createSandboxOrTerminate`, `pollPreviewReady`. None of these exist. Line 60 says the static preview "Build runs in the generation sandbox then calls `killSandbox`" — `killSandbox` does not exist; `lib/preview/build.ts` compiles in-process. Line 70 mentions sandbox minutes on Plan/Workspace, dropped at `migration.sql:22-24`.
- Trigger: `CLAUDE.md:15` and `AGENTS.md:20` both send agents here for the "full map".
- Impact: the second-line map repeats the first-line map's error, so cross-checking one against the other confirms rather than catches it.
- Confidence: Confirmed
- Suggested fix: rewrite lines 60-64 as one bullet covering `lib/preview/` (in-process esbuild) and delete the sandbox lifecycle/provider bullets. Fix line 47's Plan/Build text in the same pass — it is otherwise accurate.

### F-523 [HIGH] `multi-agent-ownership.mdc` assigns ownership of files that do not exist

- Area: M
- Location: `.cursor/rules/multi-agent-ownership.mdc:36,37,39,40,45,57` — vs the absent `lib/sandbox/` tree
- What happens: this is an `alwaysApply: true` rule (line 3), imported verbatim into every Claude Code session by `CLAUDE.md:27`. Line 39 defines a **Sandbox lifecycle** owner over `lib/sandbox/manager.ts`, `teardown.ts`, `reap.ts`, `boot-errors.ts`, `/api/projects/[id]/sandbox`, `/api/cron/reap-sandboxes`. Line 40 defines a **Sandbox providers** owner over `lib/sandbox/router.ts`, `lib/sandbox/provider.ts`, `SandboxProviderConfig`, `/admin/sandbox-providers`, `POST /api/cron/check-sandbox-providers`. Line 36 tells the Preview-builds owner to _"Build inside the current generation sandbox then call `killSandbox`"_. Line 45 makes shared generation work live in `lib/sandbox/{read-files,install-packages,restart-dev,detect-packages}.ts`. Line 57 tells the plans owner to merge "sandbox minutes" into `limits.ts`. Every path and symbol named is gone.
- Trigger: every session — it is always-on.
- Impact: an always-on rule that reserves nonexistent territory is the most expensive kind of stale doc: agents burn turns looking for owners and files, and the _real_ new owners (`lib/preview/`, `lib/validation/`, `lib/assets/image-worker.ts`) have no entry at all, so parallel agents will collide there — the exact failure the rule exists to prevent.
- Confidence: Confirmed
- Suggested fix: delete lines 39, 40 and the sandbox clauses in 36/45/57, and add ownership entries for `lib/preview/` (in-browser + server bundle), `lib/validation/` (build auto-fix, per `docs/build-autofix.md:89-97`), and `lib/assets/image-worker.ts` + `lib/assets/openverse.ts`.

### F-524 [HIGH] Three documents route work through `/api/apply-ai-code-stream`, a deleted route

- Area: M
- Location: `AGENTS.md:37` and `:57`; `.cursor/README.md:43`; `.cursor/rules/multi-agent-ownership.mdc:45` — vs the route inventory (140 `route.ts` files; no `app/api/apply-ai-code-stream/`)
- What happens: `AGENTS.md:37` says _"the live follow-up is still `apply-ai-code-stream` → `installPackages`"_. `multi-agent-ownership.mdc:45` defines the **Generation engine** owner as _"`lib/generation`, `generate-ai-code-stream`, `apply-ai-code-stream`"_. The route does not exist. The code itself records why: `lib/jobs/settle-generation.ts:83-85` — _"That step used to live in the apply route; when the route went away nothing called it, so generated sites shipped with the literal token sitting in `src` and every hero image was broken."_
- Trigger: any generation-pipeline change; the owner rule points at a route that cannot be edited.
- Impact: the docs describe a two-route apply pipeline; the code has one. `AGENTS.md:37`'s whole "No self-fetch between routes" argument is built on modules (`lib/sandbox/read-files.ts`, `install-packages.ts`, `restart-dev.ts`, `detect-packages.ts`) that no longer exist, so a reader cannot tell which parts of the invariant still bind. The invariant itself is still correct and worth keeping — that is why the stale supporting cast is harmful.
- Confidence: Confirmed
- Suggested fix: restate the no-self-fetch invariant with its surviving example (`lib/generation/analyze-edit-intent.ts`, still real) and drop the four dead module names; remove `apply-ai-code-stream` from the ownership entry.

### F-525 [HIGH] The architecture that replaced the sandbox is documented nowhere authoritative

- Area: M
- Location: absent from `AGENTS.md`, `CLAUDE.md`, `.cursor/README.md`, `README.md`, `docs/coolify.md`, `docs/deployment.md`, `docs/release.md` — present only in `docs/superpowers/specs/2026-08-19-interactive-generation-ux-design.md:15-17`
- What happens: previews now compile **in the browser** — `components/workspace/BrowserPreview.tsx` with `esbuild-wasm` (`package.json:80`), dependencies from `esm.sh`, rendered in a sandboxed iframe; the server-side path is `lib/preview/server-bundle.ts` / `buildStaticSite`; the vendor asset is copied at install by `scripts/copy-preview-vendor.mjs` into `public/preview-vendor/esbuild.wasm` (`package.json:8-9`, `.gitignore:93-94`), and `next.config.ts:15-17` keeps `esbuild` in `serverExternalPackages` for it. The only description of any of this in the repository is a _design spec_ whose status line reads "approved, phase 1 in implementation" (`…design.md:4`), in a directory (`docs/superpowers/specs/`) that no map file mentions. The strings `BrowserPreview`, `esbuild-wasm` and `StreamingCodePanel` appear in **zero** of the seven doc files above.
- Trigger: any work on preview, publish, or generation.
- Impact: the load-bearing fact about how this product renders anything is discoverable only by reading source or an in-flight spec. `AGENTS.md:53`'s **Static preview** bullet still describes a sandbox build + `killSandbox` + a `LIVE_SANDBOX` escape hatch, so a reader who consults the map gets a confidently wrong answer rather than no answer.
- Confidence: Confirmed
- Suggested fix: add one **Preview and bundling** bullet to `AGENTS.md` and `.cursor/README.md` naming `components/workspace/BrowserPreview.tsx`, `lib/preview/server-bundle.ts`, `scripts/copy-preview-vendor.mjs`, `public/preview-vendor/esbuild.wasm`, and the `esm.sh` dependency resolution in `lib/preview/deps.ts`. Then link `docs/build-autofix.md`, which is the one accurate account of what happens to generated code.

### F-526 [MEDIUM] `stack.mdc` says the sandbox provider is env-driven via `SANDBOX_PROVIDER`

- Area: M
- Location: `.cursor/rules/stack.mdc:13` — vs `prisma/migrations/20260819010000_drop_sandbox_columns/migration.sql:26` and `packages/create-open-lovable/lib/installer.js`
- What happens: the rule reads _"**E2B / Vercel sandbox** for code execution. Sandbox provider is env-driven (`SANDBOX_PROVIDER`)."_ This was already wrong before the deletion — `AGENTS.md:56` records that credentials moved to `SandboxProviderConfig` rows "via constructor, not env" — and it is doubly wrong now that there is no sandbox at all. The only occurrence of `SANDBOX_PROVIDER` in the repository is `packages/create-open-lovable/lib/installer.js`, a scaffolder package that no doc mentions. "Vercel sandbox" was dropped even earlier (`docs/codegen-vs-open-lovable.md:102`).
- Trigger: `stack.mdc` is glob-scoped to `{app,components,lib,prisma}/**` (line 3), so it fires on essentially every source edit; `CLAUDE.md:38` tells the agent to read it manually for the same paths.
- Impact: an agent adding execution capability will look for a `SANDBOX_PROVIDER` env var and an E2B client, find neither, and may reintroduce one.
- Confidence: Confirmed
- Suggested fix: replace the bullet with the truth — code is bundled in-process with esbuild and previewed in the browser; there is no execution VM.

### F-527 [MEDIUM] `stack.mdc` tells the agent to run `npm run db:migrate` in a pnpm-only repo

- Area: M
- Location: `.cursor/rules/stack.mdc:12` — vs `package.json:6` (`"packageManager": "pnpm@11.21.0"`), `AGENTS.md:20`, `.cursor/lessons-learned.md:157-160`
- What happens: the rule says _"Use migrations (`npm run db:migrate`)"_. The script exists (`package.json:24`) but the invocation does not: `AGENTS.md:20` says _"Use **pnpm**, not npm — keep `pnpm-lock.yaml`; do not create `package-lock.json`"_, and `.cursor/lessons-learned.md:157-160` is an entire logged incident titled "Do not run npm in this pnpm repo" whose forward rule is _"Use pnpm only. Never `npm install` / `npm add`. Do not create `package-lock.json`."_ `.vscode/settings.json:2` and `package.json:6` are the enforcement.
- Trigger: any Prisma schema change under the rule's glob.
- Impact: the logged incident recurs — `npm run` in this repo is what produced the stray `package-lock.json` that made VS Code switch package managers.
- Confidence: Confirmed
- Suggested fix: `pnpm db:migrate`. And grep the rule set for `npm ` once, since this is not the only survivor (F-528, F-529).

### F-528 [MEDIUM] `AGENTS.md` and `docs/release.md` both offer `npm run verify` as an equal alternative

- Area: M
- Location: `AGENTS.md:79` (_"`pnpm run verify` / `npm run verify`"_) and `docs/release.md:31` (table row _"`pnpm run verify` / `npm run verify`"_) — vs `AGENTS.md:20` and `.cursor/lessons-learned.md:160`
- What happens: the same file that bans npm at line 20 offers it at line 79, and the release runbook repeats the offer in its command table.
- Trigger: pre-push.
- Impact: `npm run verify` in a pnpm workspace resolves `node_modules` differently and writes `package-lock.json` — the exact logged failure. Two documents give an agent explicit permission to do it.
- Confidence: Confirmed
- Suggested fix: delete `/ npm run verify` from both lines.

### F-529 [MEDIUM] `README.md` contradicts itself about the package manager, 38 lines apart

- Area: M
- Location: `README.md:13` vs `README.md:51`
- What happens: line 13 is `pnpm install  # or npm install / yarn install`. Line 51 is _"Always start the dev server with `pnpm dev` — not `npm run dev`, `yarn dev`, or `npx next dev`. This repo pins `packageManager: pnpm@11.21.0` and uses a pnpm workspace; running it through another package manager resolves modules differently and can rewrite `pnpm-workspace.yaml`."_ `pnpm-workspace.yaml` is real and load-bearing — it holds all 21 security `overrides` (lines 18-38) and `verifyDepsBeforeRun: false` (line 43).
- Trigger: first-time setup, which reads line 13 and stops.
- Impact: a `npm install` at step 1 can rewrite the file that carries the audit overrides the verify gate depends on.
- Confidence: Confirmed
- Suggested fix: make line 13 `pnpm install` with no alternatives, and move the line 51 warning up next to it.

### F-530 [MEDIUM] `docs/release.md` and `AGENTS.md` instruct `pnpm exec`, which the same documents forbid

- Area: M
- Location: `docs/release.md:215` vs `docs/release.md:144-146`; `AGENTS.md:62` vs `AGENTS.md:79`
- What happens: `release.md:144` is a section heading — _"Hooks call binaries directly, never `pnpm exec` / `pnpm run`"_ — and :146 explains that pnpm _"tries to **purge it** before running anything"_. Seventy lines later, `release.md:215` is a fenced command block: `pnpm exec tsx scripts/rollback.ts`. `AGENTS.md:79` carries the bolded prohibition **"Do not run `pnpm exec <tool>` here."**; `AGENTS.md:62` says the quality-signal backfill is `pnpm exec tsx scripts/backfill-quality-signals.ts`.
- Trigger: an operator running a rollback or a backfill by copy-paste.
- Impact: per `.cursor/lessons-learned.md:78-80` this aborts only because an agent shell has no TTY; a human terminal has one, and the abort becomes a `node_modules` purge — during a **rollback**, i.e. the moment production is already broken.
- Confidence: Confirmed
- Suggested fix: change both to `node ./node_modules/tsx/dist/cli.mjs <script>`, matching `.husky/pre-commit:13,23`. See also F-534: the hazard may already be neutralised by config, which is a separate documentation problem.

### F-531 [HIGH] `docs/e2e-test-and-fix-prompt.md` is a 659-line agent prompt that violates four always-on rules and drives 10 dead endpoints

- Area: M
- Location: `docs/e2e-test-and-fix-prompt.md:29,30,34,63,66,85,88,100,128,138-141,189,199-203,234,253,422-423,465,503,608`
- What happens: this file is written as a complete instruction set to hand to an agent. It:
  - **mandates `pnpm exec`** — line 29: _"Use `pnpm exec` for binaries"_, then uses it at :63, :66, :128, :138-141, :189, :503. Directly contrary to `AGENTS.md:79`, `CLAUDE.md:69-71`, `docs/release.md:144`, `.cursor/lessons-learned.md:77-80`.
  - **tells the agent to start the dev server** — line 30: _"If it does not, start it with `pnpm dev` and leave it running"_, on `:3000`. `single-dev-server.mdc:12` says this tree serves `3001`, and :53-57 says non-owner agents must never start it.
  - **drives deleted endpoints** — line 100 lists `/api/create-ai-sandbox`, `/api/create-ai-sandbox-v2`, `/api/install-packages`, `/api/install-packages-v2`, `/api/run-command`, `/api/apply-ai-code-stream`, `/api/apply-ai-code`; line 88 budgets _"Sandbox boots (kill each sandbox … `/api/kill-sandbox`)"_; line 234 lists admin page `/sandbox-providers`; line 34 says credentials live in `SandboxProviderConfig` rows. All ten are gone.
  - **names four stack prompts that do not exist** — lines 422-423: _"the six per-stack prompts (nextjs, react, astro, static-html, vue, svelte)"_. `lib/stack-prompts/` contains `nextjs.ts`, `react.ts`, `static-html.ts` only, and `prisma/schema.prisma:28-32` has three `Stack` members.
  - **treats `/builder` as a product route to verify** — lines 182, 219 (see F-548).
- Trigger: anyone hands this file to an agent, which is its stated purpose.
- Impact: a single paste arms a `node_modules` purge, a duplicate dev server on the wrong port, and a test plan whose live-generation budget (lines 85-90: 3 full journeys, 12 evals, 6 sandbox boots) is spent against endpoints that 404.
- Confidence: Confirmed
- Suggested fix: this document cannot be patched line by line — it encodes the pre-2026-08-19 architecture. Either regenerate it against the current route inventory and the `node ./node_modules/…` convention, or move it to an `archive/` path and say at the top that it describes the sandbox era.

## M.2 Verify / release facts

### F-532 [MEDIUM] Three documents state three different, all-wrong coverage floors

- Area: M
- Location: `AGENTS.md:79`, `.cursor/README.md:85`, `docs/release.md:83` — vs `vitest.config.ts:53-56`
- What happens: `vitest.config.ts:48-56` sets `statements: 48, branches: 70, functions: 65, lines: 48`, with a comment at :49-52 explaining the 2026-08-19 recalibration _"when the sandbox subsystem was removed"_. `AGENTS.md:79` says _"49 statements / 70 branches / 65 functions / 49 lines"_. `.cursor/README.md:85` says _"Coverage floors are 49/70/65/49"_. `docs/release.md:83` says _"**41% statements, 68% branches, 58% functions, 41% lines**"_ and backs it with a measurement table at :85-101 that predates the deletion.
- Trigger: someone raising the ratchet, which all three docs instruct ("raise, never lower").
- Impact: a contributor raising statements from the documented 49 to 50 is actually raising it from 48 — a two-point jump against a measured 48.50, which fails the run. `release.md`'s per-tree table (:93-101) is stale in the same direction, and its `lib/verify` / `lib/publish` rows do not match the per-module floors at `vitest.config.ts:57,64`.
- Confidence: Confirmed
- Suggested fix: delete the numbers from all three prose files and point at `vitest.config.ts:48-68`, which already carries the measurement provenance in comments. A ratchet needs exactly one recorded value.

### F-533 [MEDIUM] `pnpm.overrides in package.json` — the overrides are in `pnpm-workspace.yaml`

- Area: M
- Location: `docs/release.md:58`, `AGENTS.md:79`, `.cursor/lessons-learned.md:90` — vs `package.json:1-149` and `pnpm-workspace.yaml:18-38`
- What happens: `release.md:58` — _"High/critical findings are forced via `pnpm.overrides` in `package.json`"_. `package.json` has no `pnpm` key at all; its non-script top-level keys are `dependencies`, `devDependencies`, `lint-staged` (:137) and `prisma` (:146). The 21 overrides live at `pnpm-workspace.yaml:18-38` (`tar: ^7.5.19`, `deepmerge-ts: ^8.0.0`, `minimatch@3/@9/@10`, `glob@10/@11`, `nanoid@3/@5`, …), which is where pnpm 11 reads them. `.cursor/lessons-learned.md:90`'s forward rule names `pnpm.overrides` too, and `:79` even records that a `pnpm.overrides` field in `package.json` was **ignored** — the lesson diagnosed the problem and the rule text still points at the broken location.
- Trigger: patching a new high-severity advisory after `pnpm audit` (`lib/verify/orchestrator.ts:162-165`) goes red.
- Impact: the fixer edits `package.json`, pnpm ignores it, the audit stays red, and the natural next move is to drop the audit step — which `AGENTS.md:79` and `release.md:58` both explicitly forbid.
- Confidence: Confirmed
- Suggested fix: correct all three references to `pnpm-workspace.yaml`, and note that the same file also holds `allowBuilds` and `minimumReleaseAgeExclude`.

### F-534 [HIGH] `verifyDepsBeforeRun: false` disables the hazard four documents describe at length, and is documented nowhere

- Area: M
- Location: `pnpm-workspace.yaml:40-43` — vs `AGENTS.md:79`, `CLAUDE.md:69-71`, `docs/release.md:56,146`, `.cursor/lessons-learned.md:77-80`, `.husky/pre-commit:2-7`
- What happens: `pnpm-workspace.yaml:40-43` reads:
  ```
  # pnpm 11 otherwise runs an implicit install (purging node_modules on drift)
  # before every script - fatal to the running dev server, whose Next/Prisma
  # binaries are locked while it serves.
  verifyDepsBeforeRun: false
  ```
  That setting is the dependency-status check. Four documents and one git hook spend roughly 900 words explaining that the check fires and will purge `node_modules`. None of them mentions that a config line now turns it off. The string `verifyDepsBeforeRun` appears in no `.md` file in the repository.
- Trigger: reading any of the four documents.
- Impact: cuts both ways, and both are bad. If the setting works, the elaborate `node ./node_modules/…` convention is now belt-and-braces and nobody knows it — agents keep paying the cost of a mitigation whose necessity is unexamined. If it does not fully cover `pnpm exec` (the docs distinguish `pnpm run` from `pnpm exec`; the setting is described only for "before every script"), then the four documents are right and `release.md:215` / `AGENTS.md:62` are still live hazards. **The repository does not record which.** That ambiguity is the finding.
- Confidence: Confirmed (the setting exists and is undocumented); Needs check (whether it also covers `pnpm exec`)
- Suggested fix: determine empirically whether `verifyDepsBeforeRun: false` suppresses the purge for `pnpm exec` as well as `pnpm run`, then write the answer once — in `docs/release.md` next to the "never `pnpm exec`" section — and cross-reference it from `AGENTS.md:79`, `CLAUDE.md:70` and the lessons entry. Keep the direct-binary convention either way; it costs nothing and does not depend on a setting.

### F-535 [MEDIUM] `docs/coolify.md` — the one current doc — has two false claims about where credentials live

- Area: M
- Location: `docs/coolify.md:22` — vs `lib/settings/registry.ts` (35 keys) and `lib/api-keys.ts:49-53`
- What happens: line 22 makes two claims that do not hold:
  1. _"`E2B_API_KEY` is still read into the `tooling.e2b.apiKey` setting but nothing consumes it."_ There is no `tooling.e2b.apiKey` in `lib/settings/registry.ts` (the 35 keys are `github.oauth.*`, `ai.deepseek.*`, `ai.primaryModel`, `ai.concurrency`, `tooling.firecrawl.apiKey`, `tooling.morph.apiKey`, `tooling.unsplash.*`, `tooling.images.*`, `email.*`, `storage.*`, `backups.*`, `app.*`), and `E2B_API_KEY` is read by no file under `lib/`, `app/`, `config/` or `scripts/`. It is not read at all.
  2. _"Most of those are also editable in `/admin/config` … `FIRECRAWL_API_KEY`, `MORPH_API_KEY` **and the AI keys**."_ `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY` and `AI_GATEWAY_API_KEY` have no registry entry, and `AGENTS.md:71` states `/admin/config` _"renders entirely from `lib/settings/registry.ts`"_. They are resolved from `OrgApiKey` rows and env through `lib/api-keys.ts:49-53` and `lib/ai/effective-env.ts` — a different store with a different UI (`/settings/api-keys`).
- Trigger: an operator following the deployment guide to configure AI providers.
- Impact: the operator looks for AI keys on `/admin/config`, does not find them, and sets env vars instead. `.cursor/lessons-learned.md:192-195` is a logged production incident about exactly this class of confusion — _"Two halves of one pipeline reading different config stores"_ — and the deployment doc still describes the two stores as one.
- Confidence: Confirmed
- Suggested fix: on `coolify.md:22`, delete the E2B sentence and split the "editable in `/admin/config`" list from the AI-provider keys, naming `/settings/api-keys` + `OrgApiKey` for the latter. `README.md:38-43` needs the same treatment.

### F-536 [MEDIUM] `admin-ownership.mdc` is scoped to a directory that does not exist, so it never fires

- Area: M
- Location: `.cursor/rules/admin-ownership.mdc:3` and `:15` — vs `app/(app)/admin/**` and `app/(app)/admin/team/page.tsx`
- What happens: the frontmatter glob is `"{app/admin,app/api/admin,components/app/studio}/**/*.{ts,tsx}"`. Admin pages live at `app/(app)/admin/…` (15 pages), not `app/admin/`, so the first alternative matches nothing — the rule only ever triggers on API routes and studio chrome, never on the pages it is chiefly about. Line 15 then names _"UI in `app/admin/team/page.tsx`"_; the real file is `app/(app)/admin/team/page.tsx`. `CLAUDE.md:41` reproduces the broken glob verbatim as the manual read-trigger. `.cursor/lessons-learned.md:117-120` records the route-group move (_"after pages moved to `app/(app)/admin`"_), so the rule was simply never updated with it.
- Trigger: editing any admin page.
- Impact: the rule that single-sources admin chrome (`ADMIN_NAV`, `AdminPage`, `ConfirmAction` — all real, at `components/admin/admin-nav.ts` and `components/admin/`) does not load when someone edits an admin page. `AGENTS.md:70` records that this navigation _"previously lived in six drifted copies"_; the guard against a seventh is glob-scoped to nothing.
- Confidence: Confirmed
- Suggested fix: change the glob to `{app/(app)/admin,app/api/admin,components/admin,components/app/studio}/**/*.{ts,tsx}` and fix line 15's path. Update `CLAUDE.md:41` to match.

### F-537 [MEDIUM] `studio-generation.mdc` protects a route that was deleted

- Area: M
- Location: `.cursor/rules/studio-generation.mdc:11` and `:19` — vs `AGENTS.md:48` and the absent `app/generation/page.tsx`
- What happens: line 11 — _"Generation is **backgrounded**. The stream is owned by `GenerationProvider` … Leaving `/generation` must not abort the job."_ `AGENTS.md:48` records that _"`app/generation/page.tsx` is gone; `proxy.ts` has no `/generation` redirect"_, and the 35 pages confirm it. The workspace is `app/project/[id]/page.tsx` → `components/workspace/GenerationWorkspace.tsx`.
- Trigger: the rule's glob matches `{app,components,lib}/**/{studio,generation,admin,providers}/**`, i.e. it fires on `lib/generation/**`.
- Impact: minor on its own — the invariant (`GenerationProvider` owns the stream; `app/providers.tsx:15` confirms it is mounted) is still right. But it teaches the agent a route name that does not exist, and the `useGeneration()` import path at line 13 is the only correct navigation aid in the rule.
- Confidence: Confirmed
- Suggested fix: replace `/generation` with `/project/[id]` in lines 11 and 19.

### F-538 [MEDIUM] `single-dev-server.mdc` contradicts its own port table nine times, and `README.md` disagrees with both

- Area: M
- Location: `.cursor/rules/single-dev-server.mdc:12-13` vs `:70,75,80,81,87,89,102,105`; `README.md:55`
- What happens: the table at :10-13 assigns port **3001** to the primary tree (`.`, branch `ai-genration-improvements`) and **3000** to `.worktrees/main`. The current branch is `ai-genration-improvements` (`git branch --show-current`), so this tree is the 3001 one. Everything below the table still says 3000: :70 _"pnpm dev on :3000"_, :75 _"check if something already listens on 3000 … Never start a second port"_, :80 lists `pnpm dev --port 3001` as a **BAD** example, :87-89 and :102-105 repeat it. `README.md:55` says _"Open http://localhost:3000"_. `AGENTS.md:26-27` gets it right.
- Trigger: the dev-server owner agent restarting the server in this tree.
- Impact: the rule's own worked example forbids the port the rule's own table assigns. An owner following the prose kills or occupies `:3000`, which belongs to the `main` worktree and another agent.
- Confidence: Confirmed
- Suggested fix: parameterise the prose — "the branch's port from the table above" — and delete the `--port 3001` line from the BAD block, which is now the correct command here. Fix `README.md:55`.

### F-539 [MEDIUM] A third worktree exists and no document mentions it

- Area: M
- Location: `.worktrees/` contains `main` and **`ui-polise`** — vs `AGENTS.md:26-34` and `.cursor/rules/single-dev-server.mdc:10-13`, which both describe exactly two trees
- What happens: `AGENTS.md:26` — _"**Two working trees, two ports.**"_ — and the rule's table has two rows. A directory listing of `.worktrees/` returns two entries. (Contents not inspected: the audit brief forbids touching `.worktrees/**`.)
- Trigger: port allocation, or any agent reasoning about which checkouts share the database.
- Impact: `AGENTS.md:28-30` warns that trees share _"Postgres, `public/uploads`, and every `AppSetting` row"_. A third undocumented tree is a third writer to the same database with no assigned port and no owner in `single-dev-server.mdc`. The "one server per checkout, never two" invariant cannot be checked against a table that omits a checkout.
- Confidence: Confirmed
- Suggested fix: add the row (or remove the worktree). The table is the allocation mechanism, so an unlisted tree has no port.

### F-540 [MEDIUM] `docs/codegen-vs-open-lovable.md` names six per-stack prompt files; four do not exist, and its self-verification command will error

- Area: M
- Location: `docs/codegen-vs-open-lovable.md:88` and `:124` — vs `lib/stack-prompts/` and `prisma/schema.prisma:28-32`
- What happens: line 88 — _"`nextjs.ts`, `astro.ts`, `vue.ts`, `svelte.ts`, and `static-html.ts` had no equivalent"_ — and line 124 gives the verification command `grep -L "Edits:" lib/stack-prompts/{astro,nextjs,react,static-html,svelte,vue}.ts`, described at :127 as _"Should return nothing."_ `lib/stack-prompts/` contains `base-rules.ts`, `index.ts`, `nextjs.ts`, `react.ts`, `seo-rules.ts`, `shared.ts`, `static-html.ts`. `astro.ts`, `vue.ts`, `svelte.ts` are absent, matching `Stack` at `prisma/schema.prisma:28-32` (`NEXTJS`, `REACT`, `STATIC_HTML`) and `AGENTS.md:41` — _"There is no Astro, Vue or Svelte stack … this line claimed six until 2026-08-19."_
- Trigger: running the doc's own "Verifying this document" section (:109-127), which is how the doc asks to be trusted.
- Impact: the command errors on four missing files rather than returning nothing, so the verification step cannot distinguish "finding E regressed" from "the doc is out of date". Line 102 (_"replaced by the e2b/modal/daytona router"_) and 101 (`install-packages`, `get-sandbox-files` as thin wrappers) are stale for the same reason.
- Confidence: Confirmed
- Suggested fix: reduce the file list at :88 and :124 to the three stacks that exist, and add a dated note that the sandbox comparison in section F no longer applies.

### F-541 [MEDIUM] Two docs disagree about whether `lib/build-validator.ts` exists

- Area: M
- Location: `docs/codegen-vs-open-lovable.md:105-107` vs `docs/build-autofix.md:7` — `lib/build-validator.ts` does not exist
- What happens: `codegen-vs-open-lovable.md:107` is headed _"## Known remaining gap"_ and says _"`lib/build-validator.ts` is **orphaned in both trees** … This is the largest remaining codegen opportunity and is not addressed here."_ `build-autofix.md:3` opens by saying it _"Closes the gap named in docs/codegen-vs-open-lovable.md"_, and :7 says the file was _"Deleted."_ — with :8 recording that its sandbox-based replacement was then killed by `migration.sql`. The current implementation is `lib/validation/` (`autofix-policy.ts`, `build-check.ts`, `run-build-validation.ts`, `settings.ts`, `import-check.ts`, `fix-prompt.ts`) plus `lib/generation/validate-imports.ts`, exactly as `build-autofix.md:89-97` documents.
- Trigger: reading the comparison doc, which is dated 2026-08-19 and asks to be trusted until upstream moves.
- Impact: an "opportunity" section advertising work that is already done, pointing at a file that is gone. `build-autofix.md` is accurate and verifiable; the stale sibling undercuts it.
- Confidence: Confirmed
- Suggested fix: replace `codegen-vs-open-lovable.md:105-107` with a one-line pointer to `docs/build-autofix.md`.

### F-542 [MEDIUM] Both summaries of the verify gate omit fatal steps

- Area: M
- Location: `CLAUDE.md:65-67` and `AGENTS.md:79` — vs `lib/verify/orchestrator.ts:75-166` (13 steps)
- What happens: the real gate, in order, is `tsc`, `eslint`, `public-routes`, `prisma-validate`, `schema-drift`, `destructive`, `vitest`, `next-build`, `playwright-critical`, **`playwright-authenticated`** (`:136-141`, `fatal: true`), `depcheck`, `knip`, **`audit`** (`:162-165`, `fatal: true`).
  - `CLAUDE.md:65-67` lists eight and stops at "the Playwright `critical` project" — omitting the fatal authenticated journeys, depcheck, knip, and the fatal dependency audit.
  - `AGENTS.md:79` lists depcheck/knip and the audit but omits `playwright-authenticated` entirely, even though the same line later discusses the authenticated journeys at length.
    `docs/release.md:41-54` is the only correct enumeration.
- Trigger: an agent estimating what `verify` will catch, or debugging a red run.
- Impact: `playwright-authenticated` is the only automated proof that a signed-in user can reach the dashboard and create a project (`release.md:52`, `:286`), and `release.md:178` records that it was _"asserted by no automated run on any machine or workflow"_ until 2026-08-19. Leaving it out of both summaries is how it gets dropped again.
- Confidence: Confirmed
- Suggested fix: replace both prose lists with a pointer to `docs/release.md:41-54`, or regenerate them from `VERIFY_STEPS` so they cannot drift.

## M.3 Documented nowhere

### F-543 [HIGH] Password-protected preview deployments are a whole feature with no documentation

- Area: M
- Location: `lib/publish/preview-inject.ts:12-16,81-89`, `lib/publish/publish.ts:204-212`, `lib/coolify/client.ts:216-220`, `app/api/projects/[id]/publish/password/route.ts`, `Deployment.passwordHash` — absent from `AGENTS.md:74`, `.cursor/README.md:81`, `README.md`, `docs/coolify.md`, `docs/deployment.md`, `docs/release.md`
- What happens: preview deployments can be gated behind HTTP Basic Auth. For static stacks it is Coolify's `is_http_basic_auth_enabled`; for NEXTJS it is **generated middleware injected into the user's deploy repo** that compares against a `PREVIEW_PASSWORD` env var written onto the Coolify application (`publish.ts:210-212`). The bcrypt hash lives on `Deployment.passwordHash`; the plaintext lives only as a Coolify env var, because _"middleware cannot verify"_ the hash (`publish.ts:206-207`). `preview-inject.ts:81-83` fails closed: _"a missing PREVIEW_PASSWORD means the Coolify application lost the env var — serving the preview open would be the exact hole the gate exists to close."_ The strings `PREVIEW_PASSWORD` and `publish/password` appear in **no** documentation file.
- Trigger: publishing a password-protected preview; or an operator inspecting a client Coolify app and finding an unexplained `PREVIEW_PASSWORD` env var.
- Impact: an undocumented security control with a two-store invariant (DB hash + Coolify env plaintext) that must be written in a specific order (`publish.ts:207-208`: env var first, then re-publish). An operator who "cleans up" the env var, or a `setApplicationEnvVars` failure, silently changes a client preview's access posture — and nothing in the docs tells anyone the coupling exists. `AGENTS.md:74`'s Publish bullet describes slots, naming, and compensation, and never mentions access control.
- Confidence: Confirmed
- Suggested fix: add a **Preview access control** paragraph to the Publish bullet in `AGENTS.md` and `.cursor/README.md` naming the three stores (`Deployment.passwordHash`, the Coolify `PREVIEW_PASSWORD` env var, the injected middleware), the fail-closed behaviour, and the write ordering. Add `PREVIEW_PASSWORD` to the env table in `docs/coolify.md` labelled **runtime, set by the app, do not edit by hand**.

### F-544 [MEDIUM] The image-generation subsystem is documented as "Unsplash stock"

- Area: M
- Location: `AGENTS.md:58` and `.cursor/README.md:65` — vs `lib/assets/image-worker.ts`, `lib/assets/generate-image.ts`, `lib/assets/openverse.ts`, `lib/settings/registry.ts:188-212`
- What happens: `AGENTS.md:58` describes assets as _"`STORAGE_DRIVER=local|s3` (ElasticLake …), Unsplash stock, `NEED_IMAGE:` intercept."_ The actual pipeline has three providers and a generation path:
  - a **Cloudflare-style image worker** — `lib/assets/image-worker.ts:104` `imageWorkerConfig()` reads `tooling.images.workerUrl` / `.token` / `.model` (registry `:188-212`, env `IMAGE_WORKER_URL` / `IMAGE_WORKER_TOKEN` / `IMAGE_WORKER_MODEL`, default model `lucid-origin`, _"~12s"_ per image per `registry.ts:212` and `fulfill.ts:56`), with prompt rewriting to strip text from generated images (`image-worker.ts:91-92` `rewriteSubject`);
  - **Openverse** as a keyless stock fallback — `lib/assets/openverse.ts:6-18`, added because Unsplash's demo tier is _"50 requests/hour — which one build of a multi-page site with several NEED_IMAGE tokens can plausibly exhaust"_;
  - **Unsplash** as primary when `tooling.unsplash.accessKey` is set (`lib/assets/stock-photo.ts:9,118`).
    The words "image worker", "Openverse", `IMAGE_WORKER_URL` appear in no doc file.
- Trigger: an operator wondering why generated sites have photographs on a deployment with no Unsplash key; or an agent debugging a `NEED_IMAGE` failure.
- Impact: a paid, latency-significant generation path (three concurrent, ~12s each — `fulfill.ts:56-57`) is invisible in the cost model at `AGENTS.md:63`, and the keyless Openverse fallback — the thing that makes a no-key install produce real photos rather than grey boxes — is undiscoverable.
- Confidence: Confirmed
- Suggested fix: expand the Assets bullet in both maps to name the three providers in precedence order, the `tooling.images.*` settings, and the fact that Openverse needs no key.

### F-545 [MEDIUM] `/builder` is an orphaned mock page that fabricates a fake generated site, and only the stale test prompt mentions it

- Area: M
- Location: `app/builder/page.tsx:1-282` (mock at `:39-41`, `sessionStorage` at `:18-19`) — vs `AGENTS.md:40` and `docs/e2e-test-and-fix-prompt.md:182,219`
- What happens: `app/builder/page.tsx:39-41` reads _"// For demo purposes, we'll generate a simple HTML template / // In production, this would call the actual scraping and generation APIs"_ followed by `const mockGeneratedCode = …` — a hard-coded HTML string parameterised by a `style` value. It makes no network call (no `fetch` and no `/api` reference anywhere in the file), then offers **Download code** (`:208-219`). Its input comes from `sessionStorage.getItem('targetUrl')` and `getItem('selectedStyle')` (`:18-19`) — the exact global-key pattern `AGENTS.md:40` says was removed: _"never a global `navroopPrompt` / `targetUrl` / `autoStart`, which auto-started a paid build on the next project opened in the tab."_ Nothing in `app/`, `components/`, `lib/`, `proxy.ts` or `e2e/` links to `/builder` (zero references). It is absent from `AGENTS.md`, `CLAUDE.md`, `.cursor/README.md` and `README.md`; the only mentions are `docs/e2e-test-and-fix-prompt.md:182` (verify it redirects when signed out) and `:219` (exercise it as a product route).
- Trigger: navigating to `/builder` directly.
- Impact: a reachable page that hands the user a downloadable HTML file and calls it their generated website. `proxy.ts` gates `/api` and `/preview-static` (`AGENTS.md:36`), not pages, so this is not behind the invite wall in the way the rest of the product is. The only document that mentions it instructs a test agent to treat it as real.
- Confidence: Confirmed
- Suggested fix: delete `app/builder/page.tsx` and its two references in `docs/e2e-test-and-fix-prompt.md`. If it is wanted as a demo, it needs to say so on screen and be listed in `AGENTS.md`.

### F-546 [MEDIUM] Undocumented environment variables the code reads

- Area: M
- Location: as listed — checked against `AGENTS.md`, `CLAUDE.md`, `.cursor/README.md`, `README.md`, `docs/*.md`, `.env.example` and `lib/settings/registry.ts`
- What happens: 53 distinct `process.env.*` keys are read by non-test application code. These appear in no doc, no `.env.example` entry and no registry entry:

| Variable                                                                | Read at                                                                               | Why it matters                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PREVIEW_PASSWORD`                                                      | `lib/publish/preview-inject.ts:86` (injected), `lib/publish/publish.ts:211` (written) | security control — see F-543                                                                                                                                                                                                                                                                        |
| `NAVROOP_FILE_CONTEXT_TOKEN_CAP`                                        | `lib/generation/selective-context.ts:7`                                               | overrides the 30 000-token follow-up context cap (`:3-4`). A generation-cost tunable behind an env var, contrary to the always-on "admin settings over environment variables" convention that `docs/codegen-vs-open-lovable.md:27` calls _"this repo's `admin-panel-settings-over-env` convention"_ |
| `SOURCE_COMMIT`                                                         | `lib/health/check.ts:102`, `lib/deploy/release.ts:13`                                 | second source for the release SHA behind `GIT_SHA`; `README.md:184` and `docs/release.md:197` document only `GIT_SHA`                                                                                                                                                                               |
| `POSTGRES_CONTAINER`                                                    | `lib/verify/ensure-db.ts`                                                             | verify/test DB bootstrap                                                                                                                                                                                                                                                                            |
| `TEST_DATABASE_ADMIN_URL`, `TEST_DATABASE_NAME`, `SHADOW_DATABASE_NAME` | `scripts/ensure-test-db.ts`                                                           | `docs/release.md:9-21` documents `TEST_DATABASE_URL` and `SHADOW_DATABASE_URL` but not these three                                                                                                                                                                                                  |
| `VERIFY_BASE_URL`                                                       | `scripts/verify-projects-api.mjs`                                                     | —                                                                                                                                                                                                                                                                                                   |
| `SKIP_HTTP`                                                             | `scripts/verify-usage-costs.mjs`                                                      | a check that can be silently skipped                                                                                                                                                                                                                                                                |
| `PLAYWRIGHT_BASE_URL`                                                   | `playwright.config.ts`                                                                | `docs/release.md:75` documents `PLAYWRIGHT_NO_SERVER` and `:287` `PLAYWRIGHT_ALLOW_NO_SERVER`, but not this                                                                                                                                                                                         |
| `NEXT_RUNTIME`                                                          | `instrumentation.ts`, `lib/runtime/shutdown.ts`                                       | Next-provided, fine                                                                                                                                                                                                                                                                                 |
| `HOSTNAME`                                                              | `docker-entrypoint.mjs`                                                               | container-provided, fine                                                                                                                                                                                                                                                                            |

- Trigger: configuring a deployment, or debugging why a tunable has no effect.
- Impact: the first three are the real ones. `PREVIEW_PASSWORD` is a security control; `NAVROOP_FILE_CONTEXT_TOKEN_CAP` silently changes generation cost and quality with no admin surface and no audit trail; `SOURCE_COMMIT` means a deployment can report a release SHA from a variable no runbook mentions, which matters during the rollback procedure at `docs/release.md:212-219`.
- Confidence: Confirmed
- Suggested fix: add `PREVIEW_PASSWORD` and `SOURCE_COMMIT` to the `docs/coolify.md:18-22` optional table with build-time/runtime labels; move `NAVROOP_FILE_CONTEXT_TOKEN_CAP` into `lib/settings/registry.ts` under the `ai` group so it is operator-visible, per the convention the repo already states.

### F-547 [LOW] `.npmrc` sets `dangerouslyAllowAllBuilds=true` and no document says so

- Area: M
- Location: `.npmrc:1` — vs `pnpm-workspace.yaml:1-11` (`allowBuilds` allowlist) and `docs/release.md:54-58`
- What happens: `pnpm-workspace.yaml:1-11` maintains a careful 10-package `allowBuilds` allowlist (Prisma, esbuild, sharp, …), which is the mechanism for deciding whose install scripts may run. `.npmrc:1` then sets `dangerouslyAllowAllBuilds=true`, which makes the allowlist moot. Neither file's intent is recorded anywhere, and the two disagree.
- Trigger: `pnpm install`.
- Impact: every transitive dependency's postinstall script runs, in a repo whose verify gate treats a high-severity advisory as fatal (`lib/verify/orchestrator.ts:162-165`). The allowlist above it reads as if it were the policy.
- Confidence: Confirmed
- Suggested fix: decide which one is the policy. If the allowlist is, delete the `.npmrc` line; if the flag is, delete the allowlist and record why in `docs/release.md` next to the audit step.

### F-548 [LOW] There are two MCP config files and the docs name only one

- Area: M
- Location: `.mcp.json` (repo root) and `.cursor/mcp.json` — vs `AGENTS.md:16` and `.cursor/README.md:9`
- What happens: both files contain the identical `dev3000` HTTP server on `localhost:3684`. `AGENTS.md:16` and `.cursor/README.md:9` document `.cursor/mcp.json` only (_"existing MCP servers (do not wipe)"_). `.claude/settings.local.json:2-5` sets `enableAllProjectMcpServers: true` and `enabledMcpjsonServers: ["dev3000"]`, which is the root `.mcp.json`. Neither `.mcp.json` nor what `dev3000` is appears in any doc.
- Trigger: someone editing MCP config.
- Impact: two copies with no stated relationship, so an edit to one silently diverges; and an unexplained MCP server is enabled by default in a `settings.local.json` that is gitignored (`.gitignore:88`), so nobody reviewing the repo sees the enablement.
- Confidence: Confirmed
- Suggested fix: add a row for `.mcp.json` to the layout table in `AGENTS.md:7-18` and one sentence saying what `dev3000` is and whether both files must stay in step.

### F-549 [LOW] `docs/superpowers/specs/` is a documentation location no map mentions

- Area: M
- Location: `docs/superpowers/specs/2026-08-19-interactive-generation-ux-design.md` — vs `AGENTS.md:7-18`, `.cursor/README.md:5-20`, `CLAUDE.md:7-16`
- What happens: the only record of the current preview architecture and the in-flight streaming work (F-525) lives in a directory that none of the three map files lists. `writing-plans` and `brainstorming` (the skills that produce these) do not say where their output goes in this repo either.
- Trigger: looking for design history.
- Impact: the spec that explains `StreamingCodePanel.tsx` and `BrowserPreview`'s `settleMs` is invisible to anyone who reads the maps.
- Confidence: Confirmed
- Suggested fix: add `docs/superpowers/specs/` to the layout tables with one line on what belongs there and when a spec should be folded into `AGENTS.md`.

### F-550 [LOW] Undocumented API routes on the project surface

- Area: M
- Location: `app/api/projects/[id]/files/route.ts`, `…/job/keep`, `…/job/retry`, `…/job/start-over`, `…/duplicate`, `…/publish/password`, `…/checkpoints/[checkpointId]/bookmark`, `…/checkpoints/exit` — vs `AGENTS.md:39-76` and `.cursor/README.md:46-83`
- What happens: eight routes under `/api/projects/[id]/` have no mention in either map. `AGENTS.md:68` describes job recovery in terms of `showsChatRecovery` and `recoveryRetryIntent` but never names the three `job/*` endpoints the RecoveryPanel calls; `AGENTS.md:55` covers checkpoints but not `bookmark` or `exit`.
- Trigger: an agent auditing or changing the project API surface.
- Impact: the map is the inventory. Eight routes outside it are eight routes nobody reviews when the surface changes; `publish/password` is also F-543.
- Confidence: Confirmed
- Suggested fix: one line each in the relevant `AGENTS.md` bullets.

## M.4 `.cursor/lessons-learned.md` — per-lesson enforcement ledger

39 lessons, newest first (the file's own `### [date]` entries). "Enforced" means a named file in the
current tree implements or guards the rule; "moot" means the code the rule governed no longer exists.

| #   | Date / lesson                                                   | Status                                                     | Evidence                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | --------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | :7 SUCCEEDED job with `filesWritten` is not a site              | **Enforced**                                               | `lib/jobs/settle-generation.ts`, `lib/jobs/resumable-phase.ts`; tests `tests/integration/settle-streamed-generation.test.ts`, `tests/unit/resumable-phase.test.ts`                                                                                                                                                                                                                                           |
| 2   | :12 `textStream` swallows provider errors                       | **Enforced**                                               | `bindStreamErrorCapture` in `lib/ai/empty-completion.ts`, used at `app/api/generate-ai-code-stream/route.ts` and `lib/generation/truncation-recovery.ts`; `tests/unit/truncation-recovery.test.ts`                                                                                                                                                                                                           |
| 3   | :17 `printf %s ${JSON.stringify}` writes literal `\n`           | **Moot**                                                   | rule names Modal `filesystem.writeText`, `absoluteSandboxPath`, `base64DecodeWriteCommand` — none exist; sandbox drivers deleted by `migration.sql`                                                                                                                                                                                                                                                          |
| 4   | :22 client import of a Node builtin 500s the page               | **Enforced, with dead entries**                            | `tests/unit/client-import-boundary.test.ts` runs; its denylist at `:63-64` still names `lib/sandbox/test-run.ts` and `lib/sandbox/teardown.ts`, which do not exist. `lib/security/url-guard-messages.ts` and `lib/import/error-messages.ts` are real and imported by `lib/jobs/copy.ts`                                                                                                                      |
| 5   | :27 a write must not assume it won                              | **Enforced**                                               | `commitActiveJob` / `abandonActiveJob` in `lib/jobs/`; `tests/unit/job-running-write-guard.test.ts`, `tests/unit/cancel-job-compensates-publish.test.ts`                                                                                                                                                                                                                                                     |
| 6   | :32 a message must not promise what the code cannot prove       | **Moot**                                                   | rule is about `TeardownResult` / `teardownProvider` / `sandbox.teardownLeaks`; none exist. The general principle survives; its subject does not                                                                                                                                                                                                                                                              |
| 7   | :37 composed `Prisma.sql` becomes `$1` in the bundle            | **Enforced**                                               | `tests/unit/raw-sql-composition.test.ts` exists; `AGENTS.md:95` states the rule                                                                                                                                                                                                                                                                                                                              |
| 8   | :42 scratch `.ts` at repo root breaks `tsc`                     | **Enforced by config**                                     | `tsconfig.json:34` `include: **/*.ts`; verified `tsc --noEmit --listFilesOnly` pulls in no `.cursor`/`.claude` file (dot-directories are excluded from `**` by TypeScript), so the hazard is still exactly "repo root", as stated                                                                                                                                                                            |
| 9   | :47 two `vitest --coverage` in one checkout                     | **Convention only**                                        | no guard; `vitest.config.ts` has no lock. `AGENTS.md:98` states it                                                                                                                                                                                                                                                                                                                                           |
| 10  | :52 `[]` / `{}` / `false` is not "nothing happened"             | **Partly enforced, partly moot**                           | live: `tests/unit/storage-not-found.test.ts`, `tests/unit/publish-files.test.ts`, `SnapshotReadError` in `lib/checkpoints/snapshot-store.ts`. Moot: the E2B `listFiles` and Daytona-reconnect halves                                                                                                                                                                                                         |
| 11  | :57 one fact, one sentence; a truthy URL is not a URL           | **Enforced**                                               | `applyOutcome` / `applyPageCopy` in `lib/generation/apply-page-copy.ts`, used by `lib/jobs/copy.ts` and `GenerationWorkspace.tsx`. The `https://undefined` half was sandbox preview URLs — moot                                                                                                                                                                                                              |
| 12  | :62 unit tests must not fetch localhost                         | **Enforced**                                               | `tests/setup/network-guard.ts` + `allowLocalhost`; `tests/unit/network-guard.test.ts`                                                                                                                                                                                                                                                                                                                        |
| 13  | :67 do not tighten shared `declare global` types                | **Moot**                                                   | `global.sandboxData` and the four files named are gone                                                                                                                                                                                                                                                                                                                                                       |
| 14  | :72 pre-commit scanned node.exe and failed open                 | **Enforced**                                               | `.husky/pre-commit:10-23` — `cd "$(git rev-parse --show-toplevel)"`, direct `node ./node_modules/…`, existence check at `:15-20`; exit-code contract at `docs/release.md:152-158`                                                                                                                                                                                                                            |
| 15  | :77 `pnpm exec` wants to delete `node_modules`                  | **Enforced in hooks, violated in docs, possibly obsolete** | hooks and all 13 verify steps use direct binaries (`lib/verify/orchestrator.ts:78-165`); but `docs/release.md:215` and `AGENTS.md:62` still print `pnpm exec` (F-530), and `pnpm-workspace.yaml:43` may have removed the hazard without anyone recording it (F-534)                                                                                                                                          |
| 16  | :82 `next-env.d.ts` imports bypass `exclude`                    | **Enforced**                                               | `tsconfig.json:33` includes `types/next-env.d.ts`; `:45-46` excludes `.next` and `next-env.d.ts`; `types/next-env.d.ts` exists                                                                                                                                                                                                                                                                               |
| 17  | :87 audit highs: version-specific overrides                     | **Enforced in the wrong documented place**                 | 21 same-major overrides at `pnpm-workspace.yaml:18-38` incl. `tar: ^7.5.19`, `deepmerge-ts: ^8.0.0`, `minimatch@3/@9/@10`, `nanoid@3/@5`; the rule text at `:90` names `pnpm.overrides` (F-533). The E2B `tar` path is itself moot — `e2b` is no longer a dependency                                                                                                                                         |
| 18  | :92 Playwright `webServer` must inherit `ENCRYPTION_KEY`        | **Enforced**                                               | `lib/verify/playwright-env.ts` exists and is wired at `playwright.config.ts`                                                                                                                                                                                                                                                                                                                                 |
| 19  | :97 `test-exclude` needs `minimatch` v10                        | **Enforced**                                               | `package.json:124` `"minimatch": "^10.2.2"`; `pnpm-workspace.yaml:34` pins `minimatch@10: ^10.2.3`                                                                                                                                                                                                                                                                                                           |
| 20  | :102 legacy DB suites must ensure a default plan                | **Enforced**                                               | `ensureDefaultPlan` in `tests/factories/plan.ts`, called from `tests/audit-invariants.test.ts`, `tests/consumption.test.ts`, `tests/generation-jobs.test.ts`, `tests/plans-limits.test.ts`                                                                                                                                                                                                                   |
| 21  | :107 `migrate diff --from-migrations` needs a shadow URL        | **Enforced**                                               | `lib/verify/schema-drift.ts` + `prismaMigrateDiffCommand()` at `lib/verify/orchestrator.ts:102`                                                                                                                                                                                                                                                                                                              |
| 22  | :112 React Compiler hook rules vs verify                        | **Enforced**                                               | `eslint.config.mjs:45-48` ignores `.cursor/**`, `.claude/**`, `**/.claude/**`; documented at `docs/release.md:77-79` — though that line still says only `.cursor/**` is ignored, which is now half the truth                                                                                                                                                                                                 |
| 23  | :117 stale `.next/types` is not source of truth                 | **Enforced**                                               | `tsconfig.json:45` excludes `.next`; `:20` keeps `allowImportingTsExtensions` with `noEmit`                                                                                                                                                                                                                                                                                                                  |
| 24  | :122 map callback `({)` is a merge leftover                     | **Convention only**                                        | `lib/health/admin.ts` is syntactically valid; no guard exists for the class                                                                                                                                                                                                                                                                                                                                  |
| 25  | :127 chat busy must follow the job, not `Project.phase`         | **Enforced**                                               | `recoveryHeading` in `lib/jobs/copy.ts`, `components/workspace/RecoveryPanel.tsx`; `tests/unit/job-error-codes.test.ts`, `tests/unit/jobs-copy.test.ts`                                                                                                                                                                                                                                                      |
| 26  | :132 `Waiter.settled` must be set inside resolve                | **Likely enforced**                                        | the provider queue survives in `lib/ai/`; the specific test suite was not located by name                                                                                                                                                                                                                                                                                                                    |
| 27  | :137 auth helpers must be discriminated unions                  | **Enforced**                                               | `tests/unit/auth-matrix.test.ts` drives every gate; `tsc` is verify step 1 and is currently green                                                                                                                                                                                                                                                                                                            |
| 28  | :142 flex `h-dvh overflow-hidden` needs `min-h-0`               | **Convention only**                                        | CSS-level; no guard                                                                                                                                                                                                                                                                                                                                                                                          |
| 29  | :147 JSX merge leftovers: wrap ternary siblings                 | **Convention only**                                        | no guard; `next build` is the catch                                                                                                                                                                                                                                                                                                                                                                          |
| 30  | :152 job try/catch must not drop the following Prisma call      | **Convention only**                                        | no guard; `tsc` is the catch                                                                                                                                                                                                                                                                                                                                                                                 |
| 31  | :157 do not run npm in this pnpm repo                           | **Enforced in config, REGRESSED in docs**                  | enforced: `package.json:6`, `.vscode/settings.json:2`, `pnpm-lock.yaml` only. Regressed: `stack.mdc:12`, `AGENTS.md:79`, `docs/release.md:31`, `README.md:13` (F-527, F-528, F-529)                                                                                                                                                                                                                          |
| 32  | :162 do not export sync helpers from `'use server'` files       | **Convention only**                                        | the instance is fixed (`lib/templates/public.ts` exists and holds `toPublic`), and `AGENTS.md:94` states the rule, but there is no `tests/unit/server-actions-async.test.ts` or equivalent. `next build` is the only catch, and it is verify step 8 of 13                                                                                                                                                    |
| 33  | :167 a test wrote the repo `.data`                              | **Enforced**                                               | `tests/setup/data-dir-guard.ts`, `tests/unit/test-data-dir-guard.test.ts`, `tests/setup/repo-write-guard.global.ts`; `lib/observability/migrate-env.ts` no longer writes the file                                                                                                                                                                                                                            |
| 34  | :172 "not checked yet" is not "not writable"                    | **Enforced**                                               | `describeDataDir` in `lib/health/check.ts`, consumed by `lib/health/admin.ts` and `scripts/smoke-test.ts`                                                                                                                                                                                                                                                                                                    |
| 35  | :177 never unlink the destination before the rename             | **Enforced**                                               | `tests/unit/data-dir-cache-write.test.ts`                                                                                                                                                                                                                                                                                                                                                                    |
| 36  | :182 `void` on a telemetry write                                | **Enforced**                                               | `recordRejectedUrl` / `logRejectedUrl` in `lib/security/reject-log.ts`, called from `lib/security/url-guard.ts` and `safe-fetch.ts`; `tests/integration/ssrf-counter.test.ts`, `tests/integration/after-generation-followups.test.ts`                                                                                                                                                                        |
| 37  | :187 clearing an "already alerted" flag with a blanket catch    | **Enforced**                                               | `tests/unit/alert-clear.test.ts`, `tests/unit/alert-clear-failures.test.ts`                                                                                                                                                                                                                                                                                                                                  |
| 38  | :192 two halves of one pipeline reading different config stores | **Enforced in code, contradicted in docs**                 | `lib/ai/effective-env.ts` + `lib/ai/client-for-entry.ts` exist; `tests/unit/generate-provider-preflight.test.ts`, `tests/unit/team-self-guard.test.ts`. But `docs/coolify.md:22` re-describes the two stores as one (F-535)                                                                                                                                                                                  |
| 39  | :197 a saved-but-blank credential fails as the provider's 401   | **Moot / partly enforced**                                 | the refusal at `POST /api/admin/sandbox-providers` is gone with the route. The `serverExternalPackages` half survives at `next.config.ts:10-18`, but its comment at `:7-9` still justifies `form-data` by _"@daytona/sdk dynamically requires form-data … every Daytona build dies at the first file write"_ — the SDK is no longer a dependency, so the entry is retained for a reason that no longer holds |

### F-551 [MEDIUM] `keep-cursor-current.mdc`'s sync list omits every file that actually rotted

- Area: M
- Location: `.cursor/rules/keep-cursor-current.mdc:10-14` — vs the eight stale files in this report
- What happens: the rule that exists to stop documentation drift lists exactly three things to keep in sync: `AGENTS.md`, `.cursor/README.md`, and _"Relevant `*.mdc` rules: `navroop-product`, `multi-agent-ownership`, `single-dev-server`, `secrets`"_. It does not list `README.md`, `CLAUDE.md`, `docs/`, `stack.mdc`, `admin-ownership.mdc`, `studio-generation.mdc`, `brand-theme.mdc` or `skills-availability.mdc`. Every finding in M.1–M.3 is in a file the rule does not cover, except the two it does cover (`AGENTS.md`, `.cursor/README.md`, `multi-agent-ownership.mdc`) — which are stale anyway, so coverage alone is not sufficient either.
- Trigger: the sandbox removal on 2026-08-19, which was a "meaningful product change" by any reading of line 8.
- Impact: this is the mechanism behind F-520 through F-541. `README.md` is the file a new operator reads first and it is not in the list; `stack.mdc` is glob-scoped to every source file and it is not in the list.
- Confidence: Confirmed
- Suggested fix: replace the enumeration with "every file under `.cursor/rules/`, plus `AGENTS.md`, `CLAUDE.md`, `README.md`, and `docs/`", and add the discipline that removing a subsystem means grepping the doc set for its name before the change is done. A `verify` report-only step that greps the docs for symbols absent from the source would have caught all of M.1 mechanically.

### F-552 [LOW] An always-on rule grants a read that `.claude/settings.json` denies

- Area: M
- Location: `.cursor/rules/coolify-local-secrets.mdc:8` vs `.claude/settings.json:5-8`
- What happens: the rule (always-on, imported at `CLAUDE.md:25`) says _"Agents MAY read `.cursor/.env.deploy` or `.env.local` when Coolify or SSH access is needed."_ `.claude/settings.json:7` has `"Read(./.cursor/.env.deploy)"` in `permissions.deny`, alongside `./.env`, `./.env.*` and `./e2e/.auth/**`.
- Trigger: any Coolify task in Claude Code.
- Impact: small but real — the agent is told it may do something the harness refuses, so it spends a turn on a denied read and has no documented fallback. (The deny list is the safer policy; the rule is what should change.)
- Confidence: Confirmed
- Suggested fix: amend the rule to say that under Claude Code these files are deny-listed and the operator must supply the value, and record why `.claude/settings.json` differs from the Cursor posture.

### F-553 [LOW] `AGENTS.md` and `.cursor/README.md` send Claude Code agents to the Cursor copy of the skills

- Area: M
- Location: `AGENTS.md:84`, `.cursor/README.md:91-92`, `.cursor/rules/skills-availability.mdc:8` vs `CLAUDE.md:45-46`
- What happens: `AGENTS.md:84` — _"Open `.cursor/skills/superpowers/using-superpowers/SKILL.md`."_ `.cursor/README.md:91` says the same. `skills-availability.mdc:8` (always-on) says _"Project skills live under `.cursor/skills/`."_ `CLAUDE.md:45-46` says the packs are copied to `.claude/skills/` _"so the Skill tool can invoke them"_. The trees are currently byte-identical (Section L.1), so reading either gives the same text — but the instruction points away from the tree the Skill tool loads, and the moment F-507 comes true the two answers diverge.
- Trigger: session start, every time.
- Impact: an agent reads a file the harness is not loading skills from. Today harmless; it is the tripwire for the sync problem in F-507.
- Confidence: Confirmed
- Suggested fix: in `AGENTS.md:84` and `skills-availability.mdc:8`, say "`.claude/skills/` under Claude Code, `.cursor/skills/` under Cursor — the trees are copies (see `CLAUDE.md`)".

### F-554 [LOW] The layout tables omit the entire Claude Code configuration

- Area: M
- Location: `AGENTS.md:7-18`, `.cursor/README.md:5-20`
- What happens: `AGENTS.md`'s table is headed "Cursor layout" and lists `.cursor/rules/`, the four skill trees, `.cursor/mcp.json`, `.cursor/lessons-learned.md` and `AGENTS.md`. It does not mention `CLAUDE.md`, `.claude/skills/` (204 files), `.claude/settings.json`, `.claude/settings.local.json` or `.mcp.json`. `.cursor/README.md:7-20` has the same gap. `CLAUDE.md` documents the relationship in the other direction, so the linkage exists only from the newer file to the older ones.
- Trigger: an agent orienting itself from `AGENTS.md`, which `CLAUDE.md:9` designates as the product map.
- Impact: half the agent configuration in the repository is invisible from the file that claims to map it.
- Confidence: Confirmed
- Suggested fix: rename the section "Agent configuration layout" and add the five entries.

---

## GAPs

### F-570 [GAP] No mechanical check that documentation names things that exist

- Every finding in M.1 would have been caught by a report-only `verify` step that extracts backticked `path/like/this.ts` tokens and `/api/...` route strings from `AGENTS.md`, `CLAUDE.md`, `.cursor/README.md`, `README.md`, `.cursor/rules/*.mdc` and `docs/*.md`, and reports the ones with no corresponding file or route. That is how this audit found them, in a few seconds. `lib/verify/orchestrator.ts` already has two non-fatal report steps (`depcheck`, `knip`, `:143-156`) as precedent, and `tests/unit/admin-nav-coverage.test.ts` is precedent for pinning docs-like structure with a test.

### F-571 [GAP] No sync check between `.claude/skills/` and `.cursor/skills/`

- See F-507. The obligation is stated at `CLAUDE.md:47-48` and enforced by nothing. Both trees are excluded from ESLint (`eslint.config.mjs:45-48`) and from the `tsc` program, so no existing gate can see them.

### F-572 [GAP] Removing a subsystem has no documented checklist

- The 2026-08-19 sandbox removal updated `prisma/`, `lib/`, `app/`, `vitest.config.ts:49-52`, `docs/coolify.md:22` and `docs/build-autofix.md:8` — a careful job — and missed seven documents, two cron schedules an operator will paste into Coolify, and an always-on ownership rule. `keep-cursor-current.mdc` covers _adding_; nothing covers _deleting_, which is the harder direction because there is no new thing to write about.

### F-573 [GAP] Lessons-learned has no lifecycle

- Three of the 39 lessons (#3, #13, #39 in the M.4 table) govern code that no longer exists, and one (#17) names the wrong file. Nothing marks a lesson as superseded, so the log grows monotonically and an agent reading it — which `CLAUDE.md:15-16` and the always-on memory rule both require before every task — spends attention on rules about deleted subsystems.

### F-574 [GAP] Two real background jobs have no scheduling instructions in the file operators read first

- `/api/cron/cleanup-orphans` and `/api/cron/system-checks-digest` are absent from `README.md`'s scheduled-task list (F-521). `docs/coolify.md:53` explains that the second one, unscheduled, produces silence indistinguishable from health — and recommends an external dead-man's-switch that no runbook step actually sets up.

### F-575 [GAP] `docs/e2e-test-and-fix-prompt.md` is an executable artefact with no owner or freshness marker

- 659 lines written to be handed to an agent verbatim, encoding a route inventory, a package-manager convention, and a stack list — none of which are checked against the code. Unlike `docs/codegen-vs-open-lovable.md`, which carries a date (`:5`) and a "Verifying this document" section (`:109-127`), it has neither.

## IMPROVEMENTs

### F-580 [IMPROVEMENT] Give each doc one owner fact and stop duplicating tables

- The cron list exists three times (`README.md:82-178`, `docs/coolify.md:36-97`, `AGENTS.md:78`) and is wrong in two of them. Coverage floors exist four times (`vitest.config.ts:53-56` + three prose copies) and are wrong in all three copies. The verify step list exists four times and is incomplete in two. In each case one copy is generated-or-authoritative and the rest should be links.

### F-581 [IMPROVEMENT] Trim `AGENTS.md` prose lines

- Several bullets are single lines over 3 000 characters (`:57`, `:68`, `:79`). At that length a stale clause is invisible in a diff, which is part of why the sandbox text survived the deletion. One fact per line would make the next removal reviewable.

### F-582 [IMPROVEMENT] Keep only one skill tree in version control

- 204 files exist twice, byte-identical. If `.claude/skills/` were generated from `.cursor/skills/` by a script (or vice versa) at install time, F-500, F-501, F-505 and F-507 all become a filter in that script rather than four standing hazards, and the repository shrinks by 204 files.

### F-583 [IMPROVEMENT] Record whether `verifyDepsBeforeRun: false` closed the `pnpm exec` hazard

- Four documents, one git hook and two lessons entries exist to route around a purge that a single config line may already prevent (F-534). One measured answer retires a lot of prose, or confirms that `docs/release.md:215` and `AGENTS.md:62` are live bugs.

---

## Files reviewed

### Docs scope (`audit/_scope-p5-docs.txt`, 28 files)

- `.claude/settings.json` — clean — deny list (`:5-8`) and allow list (`:11-23`) both match the repo conventions; the allowed binaries are the `node ./node_modules/…` form the lessons log requires. Related: F-552
- `.claude/settings.local.json` — F-548 — enables the undocumented `dev3000` MCP server (`:3-5`) from a gitignored file (`.gitignore:88`)
- `.cursor/.env.deploy` — **not opened** (secrets file; denied by `.claude/settings.json:7`). Status verified only: untracked, ignored by `.gitignore:63`. F-552
- `.cursor/lessons-learned.md` — reviewed lesson by lesson — see §M.4 ledger (30 lessons). F-533 (rule text names the wrong file), F-573
- `.cursor/mcp.json` — F-548 — duplicate of the undocumented root `.mcp.json`
- `.cursor/README.md` — F-522, F-524, F-532, F-553, F-554
- `.cursor/rules/admin-ownership.mdc` — F-536 — glob and line 15 both point at `app/admin/`, which does not exist
- `.cursor/rules/brand-theme.mdc` — clean — verified against `app/providers.tsx:13` (`defaultTheme="light" enableSystem={false}`) and `components/app/studio/studio.css`
- `.cursor/rules/coolify-local-secrets.mdc` — F-552 — grants a read the Claude Code settings deny; `lib/crypto.ts` reference verified
- `.cursor/rules/keep-cursor-current.mdc` — F-551 — the sync list omits every file that rotted
- `.cursor/rules/multi-agent-ownership.mdc` — F-523, F-524 — always-on rule assigning ownership of `lib/sandbox/**` and `apply-ai-code-stream`
- `.cursor/rules/navroop-product.mdc` — clean — `components/app/studio/{StudioShell,AppHeader,PageTabs}.tsx`, `components/layout/Sidebar.tsx`, `lib/ui-ux-pro-max/`, `lib/design/directions.ts`, `/admin/team`, `/api/admin/invite` and `Role{ADMIN,MEMBER}` (`prisma/schema.prisma:11-14`) all verified present; invite-only is enforced at `app/api/auth/signup/route.ts:3-7` (403)
- `.cursor/rules/secrets.mdc` — clean — verified: `git check-ignore` resolves `.cursor/.env.deploy` to `.gitignore:63` and `.env.local` to `.gitignore:78`; neither is tracked
- `.cursor/rules/single-dev-server.mdc` — F-538 (table says 3001, prose says 3000 nine times), F-539 (third worktree)
- `.cursor/rules/skills-availability.mdc` — F-553 — points at `.cursor/skills/` as the only project skill tree
- `.cursor/rules/stack.mdc` — F-526 (`SANDBOX_PROVIDER` / "E2B / Vercel sandbox"), F-527 (`npm run db:migrate`)
- `.cursor/rules/studio-generation.mdc` — F-537 — protects the deleted `/generation` route; `GenerationProvider` wiring at `app/providers.tsx:15` verified correct
- `AGENTS.md` — F-520, F-524, F-528, F-530, F-532, F-542, F-544, F-550, F-553, F-554
- `CLAUDE.md` — F-500, F-501, F-502, F-507, F-542
- `docs/build-autofix.md` — clean — the most accurate doc in the set. All seven files at `:89-97` exist (`lib/generation/validate-imports.ts`, `lib/validation/{import-check,build-check,autofix-policy,fix-prompt,run-build-validation,settings}.ts`), and the call-site snippet at `:101-117` matches `app/api/generate-ai-code-stream/route.ts:108,1898-1914,2112`, which is the check the doc itself asks for
- `docs/codegen-vs-open-lovable.md` — F-540 (six stack prompts, four missing; the self-verification command errors), F-541 (`lib/build-validator.ts` "orphaned" vs "deleted")
- `docs/coolify.md` — F-535 — otherwise current: the 14-cron table (`:36-51`) matches `app/api/cron/*` exactly, and `:22` is the only place in the repo that states sandboxes are gone
- `docs/deployment.md` — clean — `/data` layout at `:15-20` matches `lib/runtime/data-dir.ts`, `OBSERVABILITY_CONFIG_PATH`, `AppSetting runtime.volumeId` and `POST /api/cron/sweep-tmp`, all verified present
- `docs/e2e-test-and-fix-prompt.md` — F-531, F-545 — mandates `pnpm exec`, starts a dev server on the wrong port, drives 10 deleted endpoints, names 4 nonexistent stack prompts
- `docs/release.md` — F-528, F-530, F-532, F-533, F-534 — the verify step order at `:41-54` is the one correct enumeration in the repo
- `docs/superpowers/specs/2026-08-19-interactive-generation-ux-design.md` — F-525, F-549 — accurate and current (`components/workspace/StreamingCodePanel.tsx` and `BrowserPreview.tsx` both exist), but it is the sole record of the post-sandbox architecture and lives in an unmapped directory
- `docs/verify-bypasses.log` — clean — header only, no bypasses logged; matches `scripts/verify-bypass.ts` and `docs/release.md:160-170`
- `README.md` — F-521, F-529, F-532, F-538 — two 404 cron endpoints, two real crons missing, npm/yarn offered, port 3000, `E2B_API_KEY` / `SANDBOX_IDLE_MINUTES` sections describing a deleted subsystem

### Skills scope (`audit/_scope-p5-skills.txt`, 409 files)

All 409 were hashed and compared (§L.1). 204 pairs are byte-identical, so the per-file verdict is
recorded once per pair; findings attach to the skill, not the individual data file.

**Clean — no drift, no Cursor-only mechanic (93 files across 18 skills):**

- `.claude/skills/autopilot/` (1 file) + `cursor/autopilot/` — identical, clean
- `.claude/skills/brainstorming/` (8 files) + `superpowers/brainstorming/` — identical, clean
- `.claude/skills/design-system/` (27 files) + `design-system/` — identical, clean
- `.claude/skills/dispatching-parallel-agents/` (1 file) + `superpowers/dispatching-parallel-agents/` — identical, clean
- `.claude/skills/executing-plans/` (1 file) + `superpowers/executing-plans/` — identical, clean
- `.claude/skills/finishing-a-development-branch/` (1 file) + `superpowers/finishing-a-development-branch/` — identical, clean
- `.claude/skills/receiving-code-review/` (1 file) + `superpowers/receiving-code-review/` — identical, clean
- `.claude/skills/requesting-code-review/` (2 files) + `superpowers/requesting-code-review/` — identical, clean
- `.claude/skills/split-to-prs/` (1 file) + `cursor/split-to-prs/` — identical, clean
- `.claude/skills/subagent-driven-development/` (6 files) + `superpowers/subagent-driven-development/` — identical, clean
- `.claude/skills/systematic-debugging/` (11 files) + `superpowers/systematic-debugging/` — identical, clean
- `.claude/skills/test-driven-development/` (2 files) + `superpowers/test-driven-development/` — identical, clean
- `.claude/skills/ui-styling/` (16 files) + `ui-styling/` — identical, clean
- `.claude/skills/using-git-worktrees/` (1 file) + `superpowers/using-git-worktrees/` — identical, clean
- `.claude/skills/using-superpowers/` (4 files) + `superpowers/using-superpowers/` — identical, clean
- `.claude/skills/verification-before-completion/` (1 file) + `superpowers/verification-before-completion/` — identical, clean
- `.claude/skills/writing-plans/` (2 files) + `superpowers/writing-plans/` — identical, clean
- `.claude/skills/writing-skills/` (7 files) + `superpowers/writing-skills/` — identical, clean

**Flagged (111 files across 19 skills) — identical between trees, but see the finding:**

- `.claude/skills/automate/` (1 file) + `.cursor/skills/cursor/automate/` — identical; F-501
- `.claude/skills/canvas/` (16 files) + `.cursor/skills/cursor/canvas/` — identical; F-501, F-505
- `.claude/skills/create-hook/` (1 file) + `.cursor/skills/cursor/create-hook/` — identical; F-501
- `.claude/skills/create-rule/` (1 file) + `.cursor/skills/cursor/create-rule/` — identical; F-501
- `.claude/skills/create-skill/` (1 file) + `.cursor/skills/cursor/create-skill/` — identical; F-501
- `.claude/skills/create-subagent/` (1 file) + `.cursor/skills/cursor/create-subagent/` — identical; F-501, F-502
- `.claude/skills/design/` (35 files) + `.cursor/skills/design/` — identical; F-508
- `.claude/skills/migrate-to-skills/` (1 file) + `.cursor/skills/cursor/migrate-to-skills/` — identical; F-501, F-502
- `.claude/skills/onboard/` (1 file) + `.cursor/skills/cursor/onboard/` — identical; F-501, F-502
- `.claude/skills/rename-chat/` (1 file) + `.cursor/skills/cursor/rename-chat/` — identical; F-501, F-502
- `.claude/skills/review/` (1 file) + `.cursor/skills/cursor/review/` — identical; F-500, F-501, F-502
- `.claude/skills/review-bugbot/` (1 file) + `.cursor/skills/cursor/review-bugbot/` — identical; F-501
- `.claude/skills/review-security/` (1 file) + `.cursor/skills/cursor/review-security/` — identical; F-501
- `.claude/skills/sdk/` (1 file) + `.cursor/skills/cursor/sdk/` — identical; F-501
- `.claude/skills/shell/` (1 file) + `.cursor/skills/cursor/shell/` — identical; F-501, F-502, F-503
- `.claude/skills/statusline/` (1 file) + `.cursor/skills/cursor/statusline/` — identical; F-500, F-501
- `.claude/skills/ui-ux-pro-max/` (44 files) + `.cursor/skills/ui-ux-pro-max/` — identical; F-504, F-506
- `.claude/skills/update-cli-config/` (1 file) + `.cursor/skills/cursor/update-cli-config/` — identical; F-501
- `.claude/skills/update-cursor-settings/` (1 file) + `.cursor/skills/cursor/update-cursor-settings/` — identical; F-501
- `.cursor/skills/cursor/loop/SKILL.md` (1 file) — **unpaired**; deliberately not copied (`CLAUDE.md:54-55`). Premise for F-500

Totals: 93 clean + 111 flagged + 1 unpaired, per tree-pair = **409 files accounted for**
(204 in `.claude/skills/` + 205 in `.cursor/skills/`).

---

## Method

SHA-256 over both skill trees, paired by the `{cursor,superpowers}/` mapping; every SKILL.md in
`.claude/skills/` read in full plus every file whose content the findings rest on. All 28 docs read
in full except `.cursor/.env.deploy` (secrets — status only). Doc claims checked by extracting every
backtick-quoted path from the seven map/rule/runbook files and testing it against the filesystem,
then by symbol sweep (≈100 named functions, constants, models and env vars) across every
non-generated `.ts/.tsx/.mjs/.cjs/.js/.prisma/.sql/.json` file in the repo. Route, page, model, enum,
cron and verify-step inventories were generated from `app/`, `prisma/schema.prisma` and
`lib/verify/orchestrator.ts`. `tsc --noEmit --listFilesOnly` was run once (read-only) to confirm the
skill trees are outside the typecheck program; its output file was deleted. No application code,
config, schema, test or doc was modified; no dev server was touched; no worktree was entered.
