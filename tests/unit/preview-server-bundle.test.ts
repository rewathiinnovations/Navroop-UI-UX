import { describe, expect, it } from 'vitest';
import { buildStaticSite } from '@/lib/preview/server-bundle';

/**
 * The published build must come out of the same bundler as the live preview,
 * or a user approves one thing and deploys another.
 */
describe('buildStaticSite', () => {
  it('bundles a multi-file React project into a single document', async () => {
    const result = await buildStaticSite('REACT', {
      'src/App.tsx': `import { Card } from './Card';
export default function App() { return <Card />; }`,
      'src/Card.tsx': `export function Card() { return <div className="p-4">Hi</div>; }`,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const html = result.files['index.html'];
    expect(html).toContain('<!DOCTYPE html>');
    // Bare imports resolve through the import map at runtime, not in the bundle.
    expect(html).toContain('"react"');
    expect(html).toContain('esm.sh/react@');
    expect(html).toContain('Hi');
  });

  it('passes a static HTML project through untouched', async () => {
    const result = await buildStaticSite('STATIC_HTML', {
      'index.html': '<html><body><h1>Plain</h1></body></html>',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files['index.html']).toContain('<h1>Plain</h1>');
  });

  it('compiles a multi-page Next.js site with the router and navigation shim (F-145)', async () => {
    const result = await buildStaticSite('NEXTJS', {
      'app/page.tsx': `import Link from 'next/link';
import { usePathname } from 'next/navigation';
export default function Home() { return <div><h1>Home {usePathname()}</h1><Link href="/about">About</Link></div>; }`,
      'app/about/page.tsx': `export default function About() { return <h1>About</h1>; }`,
      'app/layout.tsx': `export default function L({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }`,
      'app/globals.css': 'body{margin:0}',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The second page compiled into the bundle rather than being tree-shaken as
    // an unreferenced module — proof the router imports it. (The un-minified
    // router/interceptor wiring is asserted in preview-multipage-routing.)
    expect(result.files['index.html']).toContain('About');
  });

  it('compiles an async product page through the router boundary (React #482)', async () => {
    const result = await buildStaticSite('NEXTJS', {
      'app/page.tsx': `export default function Home() { return <h1>Home</h1>; }`,
      'app/product/[slug]/page.tsx': `export default async function ProductPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <h1>{slug}</h1>;
}`,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files['index.html']).toContain('Home');
  });

  it('compiles an async layout through the boundary the assembler adds (F-153)', async () => {
    // The layout used to be dropped for being async, so the published build lost
    // its nav. Proof the appended boundary is valid TSX and reaches the bundle.
    const result = await buildStaticSite('NEXTJS', {
      'app/page.tsx': `export default function Home() { return <h1>Home</h1>; }`,
      'app/layout.tsx': `async function loadLabel() { return 'Studio'; }
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const label = await loadLabel();
  return <html><body><nav>{label}</nav>{children}</body></html>;
}`,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files['index.html']).toContain('Studio');
  });

  it('reports a compile error instead of shipping a broken site', async () => {
    const result = await buildStaticSite('REACT', {
      'src/App.tsx': `import { Missing } from './nope';
export default function App() { return <Missing />; }`,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('Cannot resolve');
  });

  it('says what is missing when there is no root component', async () => {
    const result = await buildStaticSite('REACT', { 'src/util.ts': 'export const a = 1;' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('src/App.tsx');
  });
});
