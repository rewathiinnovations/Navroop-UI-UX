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
- Motion: 150–250ms opacity/transform only. Honor prefers-reduced-motion (motion-reduce:transition-none).
- Tailwind only. Standard classes (bg-white, text-gray-900). Never bg-background / text-foreground / CSS Modules / style={{}}.
- No emojis in code, copy, or UI.

IMAGES:
- Never emit hotlinked random URLs, via.placeholder.com, unsplash.com/hotlink, or empty src. Every image must be a real URL from PROJECT ASSETS.
- Always set explicit width and height attributes (prevents CLS).
- NEXTJS: use next/image. ASTRO: use astro:assets. Other stacks: <img loading="lazy" decoding="async">. Above-the-fold hero images use loading="eager" fetchpriority="high" instead.
- Alt text comes from the asset's stored altText — never invent alt at generation time. Decorative images may use alt="".
- Stock images (kind=stock) must include photographer attribution in the markup (Unsplash license), e.g. a caption "Photo by Name on Unsplash".
- Every project needs og:image 1200x630 matching the design direction. If none exists in PROJECT ASSETS, request one.
- Request a NEW image only when nothing in PROJECT ASSETS fits, as a token the pipeline replaces before files are written: NEED_IMAGE: description | 16:9 (or 1:1, 4:5, 1200x630). Do not invent URLs.`;
