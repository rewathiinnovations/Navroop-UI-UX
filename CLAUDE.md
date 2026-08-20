# Navroop — Claude Code project memory

This project was developed in Cursor before moving to Claude Code. The Cursor configuration is
still the source of truth for the _content_ of the rules and skills; this file is the entry
point that makes Claude Code load them. Keep the two in step — see `keep-cursor-current` below.

## Read this before non-trivial work

**`AGENTS.md`** is the product map: routes, Prisma models, the job lifecycle, the preview and
publish pipeline, the verify gate, and the invariants that are easy to break by accident. It is
~42 KB, so it is deliberately _not_ auto-imported into every session — read it with the Read
tool before changing product behaviour, schema, API routes, or layout. Do not guess at any of
what it documents.

`.cursor/README.md` is the map of the Cursor layout. `.cursor/lessons-learned.md` is a
self-evolving mistake log — read it before starting, and append to it when corrected.

## Always-on rules

These are the `alwaysApply: true` Cursor rules, imported verbatim so they apply in every
session exactly as they did in Cursor.

@.cursor/rules/navroop-product.mdc
@.cursor/rules/secrets.mdc
@.cursor/rules/coolify-local-secrets.mdc
@.cursor/rules/single-dev-server.mdc
@.cursor/rules/multi-agent-ownership.mdc
@.cursor/rules/keep-cursor-current.mdc
@.cursor/rules/skills-availability.mdc

## Path-scoped rules

These carry `globs:` in their frontmatter rather than `alwaysApply`. Claude Code has no glob
trigger for memory files, so read the matching rule yourself when you touch these paths.

| Read this rule                        | When touching                                                         |
| ------------------------------------- | --------------------------------------------------------------------- |
| `.cursor/rules/stack.mdc`             | `{app,components,lib,prisma}/**/*.{ts,tsx,js,jsx,prisma}`             |
| `.cursor/rules/brand-theme.mdc`       | `{app,components,styles}/**/*.{tsx,css}`                              |
| `.cursor/rules/studio-generation.mdc` | `{app,components,lib}/**/{studio,generation,admin,providers}/**`      |
| `.cursor/rules/admin-ownership.mdc`   | `{app/(app)/admin,app/api/admin,components/app/studio}/**/*.{ts,tsx}` |

## Skills

The portable Cursor skill packs are copied to `.claude/skills/` so the Skill tool can invoke them
(`superpowers`, `ui-ux-pro-max`, `ui-styling`, `design`, `design-system`, plus the host-agnostic
`autopilot` and `split-to-prs`). `.cursor/skills/` remains as it was for anyone still using Cursor.
**A skill that exists in both trees and is edited in one place must be copied to the other**, or the
two drift apart silently.

The `cursor/*` pack is **deliberately not copied**. Those skills automate Cursor's own mechanics —
the `cursor-app-control` MCP tool, the `AskQuestion` / `cursor_dialog` / `SwitchMode` tools, Cursor
`subagent_type`s, `~/.cursor/**` config paths, `@cursor/sdk` — none of which exist in Claude Code,
and several of them write `.cursor/rules/*.mdc`, `.cursor/agents/*.md` or `.cursor/hooks.json`
entries that Claude Code will never load. They also rely on the `disable-model-invocation`
frontmatter key, which Claude Code ignores, so a slash-only skill could be auto-selected here. The
excluded set is `automate`, `canvas`, `create-hook`, `create-rule`, `create-skill`,
`create-subagent`, `loop`, `migrate-to-skills`, `onboard`, `rename-chat`, `review`,
`review-bugbot`, `review-security`, `sdk`, `shell`, `statusline`, `update-cli-config`,
`update-cursor-settings`. Read them from `.cursor/skills/cursor/` if you need to know what Cursor
does; do not re-copy them into `.claude/skills/`. (`loop` is excluded for a second reason: Claude
Code ships its own `/loop` and a project skill of that name would shadow it.)

## Commands

Use **pnpm**, never npm — keep `pnpm-lock.yaml`, never create `package-lock.json`.

```bash
pnpm run verify
```

The pre-push gate: tsc, eslint `--max-warnings 0`, the public-route allowlist, prisma validate

- migrate diff, the destructive-migration detector, vitest with coverage, `next build`, and the
  Playwright `critical` project. `pnpm run verify:full` runs every Playwright project.

Read the **Verify / release** section of `AGENTS.md` before running it. In particular it
explains why you must not run `pnpm exec <tool>` in an agent shell (pnpm's dependency-status
check tries to purge `node_modules`) — run the installed binary directly instead.

Tests use `TEST_DATABASE_URL` (`openlovable_test` on 5433), never the application database.
