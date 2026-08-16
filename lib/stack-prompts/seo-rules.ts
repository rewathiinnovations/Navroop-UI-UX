import { getStack, type StackId } from '@/lib/stacks';

const SHARED_SEO_RULES = `SEO / AEO (every public route):
- Unique title 50-60 characters and meta description 140-160 characters per route. No duplicates. No placeholders ("Home", "Page", "Lorem", "Welcome to my site").
- Open Graph + Twitter tags per route. twitter:card must be summary_large_image. Include og:title, og:description, og:image, og:url, twitter:title, twitter:description, twitter:image.
- One canonical URL per route (absolute).
- JSON-LD matching purpose: Organization + WebSite on home; Article on articles; Product on products; BreadcrumbList on nested pages. Omit JSON-LD on utility, dashboard, app, settings, login, and admin tools.
- html lang and viewport meta on every document.
- Do not noindex public marketing pages.`;

const STACK_SEO: Record<StackId, string> = {
  NEXTJS: `NEXT.JS metadata:
- Use the Metadata API or generateMetadata in each app/**/page.tsx (and root layout defaults). Never a client-only document.title.
- Add app/sitemap.ts and app/robots.ts (App Router). Do not skip these files.`,
  ASTRO: `ASTRO metadata:
- Set title, description, canonical, OG, and Twitter in frontmatter or a shared BaseLayout <head>.
- Add @astrojs/sitemap in astro.config. Include robots.txt.`,
  STATIC_HTML: `STATIC HTML metadata:
- Literal <head> on every .html page: title, description, canonical, OG, Twitter, json-ld.
- Literal robots.txt and sitemap.xml listing every page.`,
  REACT: `REACT + VITE head:
- Put title/meta in the document head file (index.html and any helmet/head helper).
- Client-only meta is unreliable for social bots and many crawlers. Do not pretend SPA meta is enough for sharing or AEO. Recommend Next.js or Astro for public marketing sites.
- Still ship static robots.txt + sitemap.xml of known routes.
- Add an HTML comment in the head/meta file: <!-- Client-rendered meta is unreliable for social bots; prefer Next.js or Astro for public SEO. -->`,
  VUE: `VUE + VITE head:
- Use the stack head manager (index.html + vue-router meta or useHead if already present).
- Client-only meta is unreliable for social bots and many crawlers. Do not pretend SPA meta is enough for sharing or AEO. Recommend Next.js or Astro for public marketing sites.
- Still ship static robots.txt + sitemap.xml of known routes.
- Add an HTML comment in the head/meta file: <!-- Client-rendered meta is unreliable for social bots; prefer Next.js or Astro for public SEO. -->`,
  SVELTE: `SVELTE / SVELTEKIT head:
- Use <svelte:head> in +layout/+page. Still treat public SEO as weaker than Next/Astro unless pages are server-rendered.
- Client-only meta is unreliable for social bots. Do not pretend SPA meta is enough. Recommend Next.js or Astro for public marketing sites.
- Still ship static robots.txt + sitemap.xml of known routes (or SvelteKit sitemap endpoints).
- Add an HTML comment in the head/meta file: <!-- Client-rendered meta is unreliable for social bots; prefer Next.js or Astro for public SEO. -->`,
};

/** Tight SEO/AEO block appended to every generation via the shared assembler. */
export function getSeoRules(stack: string): string {
  const id = getStack(stack).id;
  return `${SHARED_SEO_RULES}\n\n${STACK_SEO[id]}`;
}
