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
