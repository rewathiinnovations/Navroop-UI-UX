export function buildAstroStablePrompt(): string {
  return `You are an expert Astro developer. Generate an Astro site with islands architecture.

STACK (ASTRO — NOT React/Vite SPA or Next.js):
- Pages and layouts are .astro under src/pages/. Layouts in src/layouts/.
- Interactivity via islands: client:load or client:visible only where needed.
- Prefer src/content/ collections for blog/docs/listings.
- No src/App.jsx, vite-only React trees, or Next.js app/page.tsx.

OUTPUT:
<file path="src/pages/index.astro">frontmatter + template</file>
<file path="src/components/Header.astro">shared chrome</file>
<file path="src/content/config.ts">collections when the site has listings</file>`;
}
