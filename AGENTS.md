# Agent guide — Navroop / Open Lovable

Navroop is an invite-only admin shell around Open Lovable (Next.js App Router, React 19, Tailwind, Prisma/Postgres, E2B, Firecrawl). Brand the product as Navroop. Default theme is light. Do not revert studio/admin chrome. Generation runs in the background via `GenerationProvider`.

## Cursor layout

| Path | Purpose |
| --- | --- |
| `.cursor/rules/*.mdc` | Project rules (always-on + glob-scoped) |
| `.cursor/skills/superpowers/` | Superpowers (brainstorming, TDD, debugging, plans, …) |
| `.cursor/skills/cursor/` | Cursor core (create-rule, create-skill, canvas, …) |
| `.cursor/skills/ui-ux-pro-max` | UI/UX research |
| `.cursor/skills/ui-styling` | Tailwind / shadcn |
| `.cursor/skills/design` | Logos, icons, CIP |
| `.cursor/skills/design-system` | Tokens |
| `.cursor/mcp.json` | Existing MCP config — keep |
| `AGENTS.md` | This file |

Full map: `.cursor/README.md`. After meaningful product/schema/API/layout changes, update this file and `.cursor` docs in the same session (`keep-cursor-current.mdc`).

## Product map

Authenticated app chrome: `components/layout/Sidebar` + studio shell. Generation is backgrounded via `GenerationProvider`. One Next.js server on `:3000` — only the dedicated **dev server** agent may start/restart it (`single-dev-server.mdc`). Coolify production is `docker-compose.yml` (`app` + `postgres`); local Postgres on host `5433` is `docker-compose.dev.yml`. See `docs/coolify.md`.

- **Projects API** — `/api/projects`, Prisma `Project` (`lib/projects`)
- **Plan/Build** — `ProjectPhase` + `/api/projects/[id]/plan`; workspace chat modes `plan` | `build`
- **Stacks** — Prisma `Stack` + `lib/stacks` (Next.js, React, Astro, static HTML, Vue, Svelte). New projects default **NEXTJS**. PromptHero + pending-prompt (`navroop_pending_prompt`) persist `{ text, stack, savedAt, designDirection, importMode }` (defaults NEXTJS + `minimal` + `reimagine`)
- **Design directions** — `lib/design/directions.ts` presets (minimal, bold, premium, playful, editorial, technical). `Project.designDirection` + PromptHero picker. Generation prompts: `lib/stack-prompts` (`base-rules` + `seo-rules` + direction + stack). Stable prefix is cacheable; follow-ups use selective file context (`lib/generation/`)
- **Workspace** — `components/workspace/` (preview/code/Quality/Assets/Brain, Plan/Build). Quality tab has SEO & AI search + Code & performance sub-tabs. Brain tab: workspace + project memory + Skills section.
- **SEO / AEO** — generation rules in `lib/stack-prompts/seo-rules.ts` (appended by the shared assembler). On-demand audit: Prisma `SeoAudit`, `lib/seo/`, `/api/projects/[id]/seo`, Quality → SEO & AI search. Owner/ADMIN mutations; any member can `getLatestSeoAudit`.
- **Code quality** — Prisma `CodeAudit`, `lib/audit/` (static E2B checks, sandbox bundle estimates, axe-core a11y, optional AI review). `/api/projects/[id]/audit`, Quality → Code & performance. `getTopRecurringIssues()` on `/admin/usage` and `/admin/quality`. Owner/ADMIN mutations; any member can `getLatestCodeAudit`.
- **Visual Edits** — `lib/visual-edits` + workspace preview toolbar
- **Connectors / GitHub** — `/connectors`, `/api/github`, Prisma `GitHubConnection`
- **Checkpoints** — `/api/projects/[id]/checkpoints`, Prisma `Checkpoint`
- **Assets** — Prisma `ProjectAsset` + `lib/assets` + `lib/storage`; workspace Assets tab; `/api/projects/[id]/assets`. `STORAGE_DRIVER=local|s3`, Unsplash stock, `NEED_IMAGE:` intercept
- **URL import** — Prisma `ImportSource` + `lib/import/` (Playwright capture, WebP rehost, section segment, per-section generate). `createProject` skips planning for URL input. Modes `reimagine` (default) | `replicate`. Progress in chat. `POST /api/projects/[id]/import`. Workspace top bar shows the source URL.
- **Skills** — Prisma `Skill` (workspace-scoped, no projectId). Conditional instruction sets matched per message (`lib/skills/`, max 2). Injected AFTER the cacheable prefix, never inside it. CRUD ADMIN-only; members read-only. UI: `/settings/skills` and the Skills section in the workspace Brain tab. Usage table on `/admin/usage`. Distinct from always-on Brain memory.
- **Brain memory** — Prisma `MemoryEntry` + `AppSetting.memoryExtractionEnabled` (default true). Workspace + project durable context in `lib/memory/`. Injected INSIDE the cacheable prefix (`buildMemoryBlock`). Manual = ACTIVE; extracted = PENDING until approved. Token cap ~1500. ADMIN toggle on `/admin/usage`.
- **Quality signals** — Prisma `QualitySignal` + `PromptVersion`, `lib/signals/`, `lib/prompts/version.ts`. Collectors swallow errors. ADMIN `/admin/quality`. No self-grading AI signal. Backfill: `npx tsx scripts/backfill-quality-signals.ts`.
- **Team / usage** — `/admin/team`, `/admin/usage`, `/admin/quality` (ADMIN)
- **Coolify** — `Dockerfile` + `docker-compose.yml` (migrate on boot); local DB `docker-compose.dev.yml`

## How to use Superpowers here

1. Open `.cursor/skills/superpowers/using-superpowers/SKILL.md`.
2. If a skill might apply, read it before any other action.
3. Process skills first (brainstorming, systematic-debugging, TDD), then UI/implementation skills.
4. Do not rely only on the user Superpowers plugin cache — copies live in this repo.

## Do not

- Commit or overwrite `.env.local`
- Dump `omni-*` / `gstack-*` / Coolify / WHM skill trees into this repo (still available from `~/.cursor/skills/`)
- Touch Next.js version or unrelated runtime unless asked

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
