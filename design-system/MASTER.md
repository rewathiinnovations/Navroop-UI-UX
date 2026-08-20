# Design System: Navroop

Product UI for auth and dashboard. Generated websites use a per-request UI/UX Pro Max brief at creation time.

## Product chrome

- Brand accent is Navroop's own heat scale: `--heat-4` … `--heat-200`, declared in `styles/design-system/colors.css` (`--heat-100` is `#fa5d19`). Reach for `var(--heat-*)` or the `heat-*` Tailwind utility, never a literal hex — the two literals left in the tree (`#FA4500` in `components/ui/shadcn/checkbox.tsx` and `toggle.tsx`) are hover states that predate the token and do not match it. Product chrome is Navroop's, per `.cursor/rules/navroop-product.mdc`; no other company's identity is to be preserved here.
- Studio tokens `--studio-accent`, `--studio-ring` and `--studio-cta-gradient` must stay on heat — never rose `#c92a4e`, never a rainbow CTA.
- Surfaces: `--studio-surface` cards on `--studio-bg` (mapped in `components/app/studio/studio.css`). Do not hardcode `bg-white` / `text-gray-*` in product chrome.
- Type: Inter / existing Geist stack
- Motion: 150-200ms color/opacity/transform only
- Icons: Lucide / existing SVGs, never emoji. Do not switch the product chrome to Phosphor.
- Controls: 44px minimum hit area (`studio-icon-hit` or `min-h/min-w-[44px]`); the glyph can stay 16–20px. Visible `focus-visible` rings on every interactive control. Labeled inputs.
- Default theme is light (`enableSystem={false}`). Dark is an opt-in toggle, not the default.
- Below `md`, the app sidebar is an overlay drawer. Below `lg`, the workspace shows one pane (chat or preview) via the existing chat-collapse toggle.
- Shared primitives — do not invent a fourth: `EmptyState`, `ConfirmAction`, `StatusPill`, `StatusBanner`, `StudioButton`, `StudioField`.

## Generated websites

`lib/ui-ux-pro-max/build-design-brief.ts` selects style, color, type, and landing pattern from the user prompt + selected style, then injects it into the generation system prompt.

## Admin (`/admin/**`)

Everything under `/admin` renders through `components/admin/*`, not hand-rolled markup. A page that needs a new pattern extends one of these rather than reinventing it, so the whole section stays one system instead of fourteen ad hoc ones.

- **Navigation**: `components/admin/admin-nav.ts` is the _only_ place admin routes, labels, descriptions, and icons are declared — `AdminNav` (rail), the admin home cards, and `AdminPage` breadcrumbs all read from it. Adding a page means adding one entry here; nothing else needs to change, and `tests/unit/admin-nav-coverage.test.ts` fails if a route exists with no entry.
- **Icons**: one icon per admin section, resolved through `AdminIcon.tsx` from the `AdminIconName` union — never inline a different icon for the same section in two places. Within a page, give each card and stat tile its own icon too; an admin screen with no icons reads as a wall of text.
- **Page header**: every page opens with `<AdminPage icon="…" title="…" description="…">`. `title` is the page's own name, never the word "Admin" — the heading is how someone confirms which of fourteen pages they're on.
- **Sections**: wrap distinct concerns in `<AdminCard icon title description>`, not a bare `<section>` or a raw bordered `<div>`. A page with four or more anchor-worthy sections (Config, Health) also gets a jump-nav chip row (`<a href="#id">`) right under the header, one chip per card `id`.
- **Numbers**: a KPI belongs in `<StatTile>` (icon, value, label, optional `tone`), not a hand-styled stat box. `tone="warning"`/`"danger"` on a tile that represents a problem (nonzero failures, unconnected integrations) — the color should tell the story before the number does.
- **Tables**: `<AdminTable>` + `Th`/`Tr`/`Td` from `components/admin/AdminTable.tsx`, never a raw `<table>`. Always pass `empty` — a table with zero rows and no empty state reads as broken, not as "nothing here yet."
- **Feedback**: `<StatusBanner tone="error|warning|success|info">` for every inline message — no bare `<p className="text-danger">`. Two red tokens for the same severity is the thing this replaced.
- **Destructive actions**: anything that cannot be undone (deactivate, disconnect, abandon, restart) goes through `<ConfirmAction>`, not a raw `onClick`. Use `confirmPhrase` when the action is expensive to reverse (data loss, service restart).
- **Forms**: `StudioField` / `StudioSelect` / `StudioTextarea` — every input gets a visible `<label>`, not a placeholder standing in for one. A secret input is `type="password"` with an `Eye`/`EyeOff` reveal toggle (see `ConfigAdmin.tsx`), never permanently masked with no way to check what was typed.
- **Status**: a connected/active/healthy state is a small dot + label in a pill (`size-6 rounded-full` colored dot, `rounded-full border px-8 py-2` pill) — not colored text alone, so the signal survives a glance and doesn't depend on color contrast alone.
- **Width**: `<AdminPage width="wide">` for anything table-heavy or multi-column; the `"default"` 880px column is for read-first pages (Config, Team). Don't let a page choose its own max-width outside these two.
