import { describe, expect, it } from 'vitest';
import { assemblePreview, matchNextRoute, nextPageRoutes } from '@/lib/preview/assemble';

/**
 * A multi-page Next.js site is the default stack's default output, and the
 * preview showed only the home page: other `app/**\/page.tsx` were in the file
 * tree but nothing imported them, so esbuild tree-shook them away. Worse, a
 * `<a href="/about">` in the static preview resolved against the preview origin
 * and navigated the reader out of the preview and into Navroop's own 404
 * (F-145).
 *
 * The preview enumerates App Router pages (including `[slug]` / `[id]`),
 * mounts them behind an in-frame router, and intercepts in-project absolute
 * links so they route in the frame instead of escaping. Catch-all
 * (`[...slug]`) and per-route nested layouts remain out of scope.
 */

const PAGE = (name: string) => `export default function ${name}(){ return null; }`;

describe('nextPageRoutes', () => {
  it('maps app/**/page files to routes, home first, dropping route groups', () => {
    const routes = nextPageRoutes({
      'app/page.tsx': PAGE('Home'),
      'app/about/page.tsx': PAGE('About'),
      'app/pricing/page.jsx': PAGE('Pricing'),
      'app/(marketing)/contact/page.tsx': PAGE('Contact'),
    });

    expect(routes).toEqual([
      { path: '/', file: 'app/page.tsx' },
      { path: '/about', file: 'app/about/page.tsx' },
      { path: '/contact', file: 'app/(marketing)/contact/page.tsx' },
      { path: '/pricing', file: 'app/pricing/page.jsx' },
    ]);
  });

  it('includes [slug] / [id] as patterns and still drops catch-alls', () => {
    const routes = nextPageRoutes({
      'app/page.tsx': PAGE('Home'),
      'app/product/[slug]/page.tsx': PAGE('Product'),
      'app/blog/[id]/page.tsx': PAGE('Post'),
      'app/docs/[...slug]/page.tsx': PAGE('Docs'),
    });

    expect(routes).toEqual([
      { path: '/', file: 'app/page.tsx' },
      { path: '/blog/[id]', file: 'app/blog/[id]/page.tsx' },
      { path: '/product/[slug]', file: 'app/product/[slug]/page.tsx' },
    ]);
  });
});

describe('matchNextRoute', () => {
  const routes = nextPageRoutes({
    'app/page.tsx': PAGE('Home'),
    'app/shop/page.tsx': PAGE('Shop'),
    'app/product/[slug]/page.tsx': PAGE('Product'),
    'app/product/new/page.tsx': PAGE('NewProduct'),
  });

  it('loads app/product/[slug]/page.tsx for /product/northwind-mug', () => {
    const match = matchNextRoute('/product/northwind-mug', routes);
    expect(match?.route.file).toBe('app/product/[slug]/page.tsx');
    expect(match?.params).toEqual({ slug: 'northwind-mug' });
  });

  it('prefers a static page over a competing [slug] on the same prefix', () => {
    const match = matchNextRoute('/product/new', routes);
    expect(match?.route.file).toBe('app/product/new/page.tsx');
    expect(match?.params).toEqual({});
  });

  it('strips query strings before matching', () => {
    const match = matchNextRoute('/shop?discount=50', routes);
    expect(match?.route.file).toBe('app/shop/page.tsx');
  });

  it('returns null for a path with no page file', () => {
    expect(matchNextRoute('/cart', routes)).toBeNull();
  });
});

describe('assemblePreview — multi-page Next.js', () => {
  it('imports every static page and wires the in-frame router', () => {
    const result = assemblePreview('NEXTJS', {
      'app/page.tsx': PAGE('Home'),
      'app/about/page.tsx': PAGE('About'),
    });
    if (result.kind !== 'bundle') throw new Error('expected bundle');

    const entry = result.files[result.entry];
    expect(entry).toContain("'/app/page.tsx'");
    expect(entry).toContain("'/app/about/page.tsx'");
    // A path table the router matches against, and the navigation store it reads.
    expect(entry).toContain('path: "/about"');
    expect(entry).toContain('__setRoutes');
  });
  it('imports a [slug] page so /product/:id is not tree-shaken away', () => {
    const result = assemblePreview('NEXTJS', {
      'app/page.tsx': PAGE('Home'),
      'app/product/[slug]/page.tsx': PAGE('Product'),
    });
    if (result.kind !== 'bundle') throw new Error('expected bundle');

    const entry = result.files[result.entry];
    expect(entry).toContain("'/app/product/[slug]/page.tsx'");
    expect(entry).toContain('path: "/product/[slug]"');
    expect(entry).toContain('__matchRoute');
  });

  it('wraps an async page so React 19 does not mount it as a client component', () => {
    // React 19.2 #482: "An unknown Component is an async Client Component.
    // Only Server Components can be async at the moment." The in-frame router
    // used to createElement the raw default export. App Router pages that
    // `await params` (Next 15) are `export default async function` — valid on
    // the server, a 482 the moment the preview's client React sees them.
    // Layouts already get a client boundary (F-153); pages did not.
    const result = assemblePreview('NEXTJS', {
      'app/page.tsx': PAGE('Home'),
      'app/product/[slug]/page.tsx':
        'export default async function ProductPage({ params }) { const { slug } = await params; return <h1>{slug}</h1>; }',
    });
    if (result.kind !== 'bundle') throw new Error('expected bundle');

    const entry = result.files[result.entry];
    expect(entry).toContain("'/app/product/[slug]/page.tsx'");
    expect(entry).toContain('__previewPage');
    expect(entry).toContain('AsyncFunction');
    expect(entry).toMatch(/createElement\(__previewPage\(/);
    // The project's own file stays the async server page.
    expect(result.files['app/product/[slug]/page.tsx']).toContain(
      'export default async function ProductPage',
    );
  });
  it('intercepts in-project absolute links so they cannot escape the frame', () => {
    const result = assemblePreview('NEXTJS', {
      'app/page.tsx': PAGE('Home'),
      'app/about/page.tsx': PAGE('About'),
    });
    if (result.kind !== 'bundle') throw new Error('expected bundle');

    const entry = result.files[result.entry];
    // A delegated click listener that routes in-frame instead of letting the
    // browser navigate the preview origin.
    expect(entry).toContain("addEventListener('click'");
    expect(entry).toContain('preventDefault');
    expect(entry).toContain('__navigate');
  });
});

describe('the next/navigation shim', () => {
  it('exposes a real in-frame router, not the old noop', () => {
    const result = assemblePreview('NEXTJS', {
      'app/page.tsx': PAGE('Home'),
      'app/about/page.tsx': PAGE('About'),
    });
    if (result.kind !== 'bundle') throw new Error('expected bundle');

    const shim = result.files[result.aliases['next/navigation']];
    expect(shim).toContain('export function __navigate');
    expect(shim).toContain('export function __setRoutes');
    // usePathname must reflect the current in-frame path, not a constant '/'.
    expect(shim).toContain('export function usePathname');
    expect(shim).not.toMatch(/usePathname\(\)\s*\{\s*return '\/';\s*\}/);
    // push has to route, not swallow.
    expect(shim).toContain('push:');
  });

  it('matches hash #/product/foo against [slug] and exposes params', () => {
    const result = assemblePreview('NEXTJS', {
      'app/page.tsx': PAGE('Home'),
      'app/product/[slug]/page.tsx': PAGE('Product'),
    });
    if (result.kind !== 'bundle') throw new Error('expected bundle');

    const shim = result.files[result.aliases['next/navigation']];
    expect(shim).toContain('export function __matchRoute');
    expect(shim).not.toMatch(/useParams\(\)\s*\{\s*return \{\};\s*\}/);
  });
});

describe('assemblePreview — single-page Next.js still works', () => {
  it('mounts the one page and still guards against link escape', () => {
    const result = assemblePreview('NEXTJS', { 'app/page.tsx': PAGE('Home') });
    if (result.kind !== 'bundle') throw new Error('expected bundle');

    const entry = result.files[result.entry];
    expect(entry).toContain("'/app/page.tsx'");
    expect(entry).toContain("addEventListener('click'");
  });
});
