# Cursor layout for Navroop / Open Lovable

This folder is project-scoped Cursor config. Existing `mcp.json` is kept. Rules and skills here are meant to be committed (secrets and caches are gitignored).

## Layout

```
.cursor/
  mcp.json                 # existing MCP servers (do not wipe)
  README.md                # this file
  rules/                   # project rules (*.mdc)
  skills/
    superpowers/           # Superpowers process skills (vendored)
    cursor/                # Cursor core skills (create-rule, canvas, …)
    ui-ux-pro-max/         # UI/UX research + briefs
    ui-styling/            # Tailwind / shadcn styling
    design/                # logos, icons, CIP, slides
    design-system/         # tokens and component specs
```

Nested Firecrawl/home rules under `components/` and `styles/` are unchanged. Merge with those; do not delete them.

## Rules

| Rule | When |
| --- | --- |
| `navroop-product.mdc` | Always — invite-only Navroop shell |
| `secrets.mdc` | Always — never commit `.env.local` |
| `skills-availability.mdc` | Always — what is in-repo vs profile-only |
| `multi-agent-ownership.mdc` | Always — wait, re-read, merge; one owner per area |
| `single-dev-server.mdc` | Always — one `:3000` server; dedicated agent only |
| `keep-cursor-current.mdc` | Always — refresh this map after product/schema/API/layout changes |
| `stack.mdc` | App/lib/prisma TypeScript |
| `brand-theme.mdc` | UI — Navroop, light default |
| `studio-generation.mdc` | Studio chrome + `GenerationProvider` |
| `admin-ownership.mdc` | Admin team/usage/invite files |

## Product map

- **Projects API** — `/api/projects`, Prisma `Project` (`lib/projects`)
- **Plan/Build** — `ProjectPhase` + `/api/projects/[id]/plan`; workspace chat `plan` \| `build`
- **Stacks** — Prisma `Stack` + `lib/stacks`. PromptHero / pending-prompt persist `{ text, stack }` (UI default NEXTJS)
- **Sidebar / workspace** — `components/layout/Sidebar`, `components/workspace/`
- **Visual Edits** — `lib/visual-edits` + workspace preview toolbar
- **Connectors / GitHub** — `/connectors`, `/api/github`
- **Checkpoints** — `/api/projects/[id]/checkpoints`
- **Team / usage** — `/admin/team`, `/admin/usage` (ADMIN)
- **Coolify** — `docker-compose.yml` + `Dockerfile` (see `docs/coolify.md`); local Postgres `docker-compose.dev.yml` on `5433`

## Superpowers

Skills are copies of the Superpowers plugin so agents do not depend only on the user plugin cache.

1. Read `.cursor/skills/superpowers/using-superpowers/SKILL.md` at the start of a task.
2. If a skill might apply, read that skill’s `SKILL.md` **before** exploring or editing.
3. Common triggers:
   - New feature → `brainstorming`, then `writing-plans`
   - Bug → `systematic-debugging`
   - Implementation with tests → `test-driven-development`
   - Multi-agent work → `subagent-driven-development` / `dispatching-parallel-agents`
   - Before claiming done → `verification-before-completion`

Announce “Using [skill] to [purpose]” and follow the skill.

## Cursor core and UI skills

- Authoring rules/skills: `.cursor/skills/cursor/create-rule`, `create-skill`
- Product UI: `ui-ux-pro-max`, `ui-styling`, `design-system`
- Generated-site briefs already use `lib/ui-ux-pro-max/` — keep that path; the skill is the research companion.

## Not vendored

`omni-*`, `gstack-*`, `coolify*`, `whm-cpanel`, `cloudflare*`, and most `cli-*` skills stay in the user profile (`~/.cursor/skills/`). They remain available globally; they are not copied here to avoid bloating the repo.
