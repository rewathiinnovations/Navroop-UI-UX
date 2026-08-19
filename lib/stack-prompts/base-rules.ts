/**
 * Shared quality block prepended to every stack prompt.
 * Keep tight — this ships on every generation call.
 */
export const BASE_RULES = `QUALITY (every file):
- Copy: real on-topic text from the user prompt. No lorem, placeholders, "Feature 1", or "Lorem ipsum".
- Structure: small composed components, not one monolith.
- HTML: one h1, no heading skips, landmarks nav/main/footer. Link text names the destination — never "click here".
- Images: meaningful alt; decorative alt="".
- A11y: visible focus, full keyboard, WCAG AA contrast, 44px tap targets.
- States: loading, empty, error, disabled for every interactive flow.
- Layout: mobile-first; no horizontal overflow at 375px.
- Tokens: define colors/spacing/type once (CSS variables or one Tailwind @theme). No scattered hex or magic numbers.
- Motion: hover/press transitions 150–250ms, opacity/transform only. Honor prefers-reduced-motion (motion-reduce:transition-none).
- Tailwind only. Standard classes (bg-white, text-gray-900). Never bg-background / text-foreground / CSS Modules / style={{}}.
- No emojis in code, copy, or UI.

DESIGN (look designed, not assembled):
- Hero: real art direction — layered background (image, gradient wash, or oversized display type), one value line, primary CTA plus a quiet secondary. Never centered text on a flat white block.
- Nav: sticky header; after scroll it gains a translucent background, backdrop blur, and a hairline border.
- Rhythm: alternate section background and density (full-bleed vs contained, light vs tinted). Vary layouts — split, offset grid, stacked feature, quote band. Never two identical card grids in a row.
- CTA hierarchy: one primary button style per view; every other action is secondary or ghost.
- Proof: when the subject plausibly has customers, include one proof moment (testimonial, logo row, or rating) styled to the direction.
- Footer: real multi-column footer (nav, contact, legal) in the direction's palette — never a single centered line.
- Entrances: reveal sections once on scroll (IntersectionObserver; opacity + translate ≤16px; 300–500ms; stagger ≤80ms). Reduced motion renders everything visible with no animation.
- Every interactive element has a visible hover state (lift, tint, or underline slide) and a focus-visible ring.

IMAGES:
- Never emit hotlinked random URLs, via.placeholder.com, unsplash.com/hotlink, or empty src. Every image must be a real URL from PROJECT ASSETS.
- Always set explicit width and height attributes (prevents CLS).
- NEXTJS: use next/image. REACT and STATIC_HTML: <img loading="lazy" decoding="async">. Above-the-fold hero images use loading="eager" fetchpriority="high" instead.
- Alt text comes from the asset's stored altText — never invent alt at generation time. Decorative images may use alt="".
- Never write a photographer or provider credit you were not given — no "Photo by …", no "via Unsplash". PROJECT ASSETS carries no attribution string, and a NEED_IMAGE photo is sourced after generation from a provider you cannot know, so add a credit caption only when an asset is listed with an explicit attribution line.
- Every project needs og:image 1200x630 matching the design direction. If none exists in PROJECT ASSETS, request one.
- Request a NEW image only when nothing in PROJECT ASSETS fits, as a token the pipeline replaces before files are written: NEED_IMAGE: description | 16:9 (or 1:1, 4:5, 1200x630). Do not invent URLs.`;
