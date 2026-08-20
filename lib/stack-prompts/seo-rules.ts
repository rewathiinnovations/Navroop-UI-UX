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
  STATIC_HTML: `STATIC HTML metadata:
- Literal <head> on every .html page: title, description, canonical, OG, Twitter, json-ld.
- Literal robots.txt and sitemap.xml listing every page.`,
  REACT: `REACT + VITE head:
- Put title/meta in the document head file (index.html and any helmet/head helper).
- Client-only meta is unreliable for social bots and many crawlers. Do not pretend SPA meta is enough for sharing or AEO.
- Still ship static robots.txt + sitemap.xml of known routes.
- Add an HTML comment in the head/meta file: <!-- Client-rendered meta is unreliable for social bots; server-rendered metadata is stronger for public SEO. -->`,
};

/**
 * The REACT block used to tell the model to "Recommend Next.js or Astro for public marketing
 * sites" — and to write that recommendation into the generated site as an HTML comment. This
 * product has exactly three stacks (`Stack` in prisma/schema.prisma), none of them Astro, so
 * the advice named a migration target the user cannot pick and the comment shipped that
 * confusion to the visitor's page source. Next.js *is* offered, and is the default, so the
 * honest form is the tradeoff without the shopping list (F-099).
 */

/** Tight SEO/AEO block appended to every generation via the shared assembler. */
export function getSeoRules(stack: string): string {
  const id = getStack(stack).id;
  return `${SHARED_SEO_RULES}\n\n${STACK_SEO[id]}`;
}
