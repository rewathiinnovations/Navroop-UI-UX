# Design System: Navroop

Product UI for auth and dashboard. Generated websites use a per-request UI/UX Pro Max brief at creation time.

## Product chrome
- Keep the existing Firecrawl heat/orange brand (`#FA4500`)
- Surfaces: white cards on `background-base`
- Type: Inter / existing Geist stack
- Motion: 150-200ms color/opacity/transform only
- Icons: Lucide / existing SVGs, never emoji
- Controls: 44px minimum, visible focus rings, labeled inputs

## Generated websites
`lib/ui-ux-pro-max/build-design-brief.ts` selects style, color, type, and landing pattern from the user prompt + selected style, then injects it into the generation system prompt.
