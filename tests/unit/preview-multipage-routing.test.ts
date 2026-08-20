import { describe, expect, it } from 'vitest';
import { assemblePreview, nextPageRoutes } from '@/lib/preview/assemble';

/**
 * A multi-page Next.js site is the default stack's default output, and the
 * preview showed only the home page: other `app/**\/page.tsx` were in the file
 * tree but nothing imported them, so esbuild tree-shook them away. Worse, a
 * `<a href="/about">` in the static preview resolved against the preview origin
 * and navigated the reader out of the preview and into Navroop's own 404
 * (F-145).
 *
 * The preview now enumerates the static App Router pages, mounts them behind a
 * tiny in-frame router keyed off the path, and intercepts every in-project
 * absolute link so it routes in the frame instead of escaping. Dynamic segments
 * (`[slug]`) and per-route nested layouts are the scoped follow-up.
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

  it('skips dynamic segments, which cannot be enumerated ahead of time', () => {
    const routes = nextPageRoutes({
      'app/page.tsx': PAGE('Home'),
      'app/blog/[slug]/page.tsx': PAGE('Post'),
    });

    expect(routes.map((route) => route.path)).toEqual(['/']);
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
