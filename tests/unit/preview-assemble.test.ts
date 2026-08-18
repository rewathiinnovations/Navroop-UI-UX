import { describe, expect, it } from 'vitest';
import { assemblePreview } from '@/lib/preview/assemble';

describe('assemblePreview', () => {
  it('mounts a Vite React app from src/App.tsx', () => {
    const result = assemblePreview('REACT', {
      'src/App.tsx': 'export default function App() { return null; }',
      'src/index.css': 'body{}',
    });
    expect(result.kind).toBe('bundle');
    if (result.kind !== 'bundle') return;
    const entry = result.files[result.entry];
    expect(entry).toContain("import Root from '/src/App.tsx'");
    expect(entry).toContain("import '/src/index.css'");
    expect(entry).toContain('createRoot');
  });

  it('uses a project-provided entry when it already mounts the app', () => {
    const result = assemblePreview('REACT', {
      'src/main.tsx': 'createRoot(document.getElementById("root")).render(null);',
      'src/App.tsx': 'export default function App() { return null; }',
    });
    expect(result.kind).toBe('bundle');
    if (result.kind !== 'bundle') return;
    expect(result.entry).toBe('src/main.tsx');
  });

  it('mounts app/page.tsx for Next.js and shims next/* imports', () => {
    const result = assemblePreview('NEXTJS', {
      'app/page.tsx': 'export default function Page() { return null; }',
    });
    expect(result.kind).toBe('bundle');
    if (result.kind !== 'bundle') return;
    expect(result.files[result.entry]).toContain("import Root from '/app/page.tsx'");
    // next/* has no browser build; unshimmed imports kill the preview.
    expect(result.aliases['next/link']).toBeTruthy();
    expect(result.files[result.aliases['next/link']]).toContain("'a'");
    expect(result.files[result.aliases['next/image']]).toContain("'img'");
  });

  it('skips a Next.js layout that renders its own <html>', () => {
    const withHtml = assemblePreview('NEXTJS', {
      'app/page.tsx': 'export default function Page() { return null; }',
      'app/layout.tsx':
        'export default function L({children}){ return <html><body>{children}</body></html>; }',
    });
    if (withHtml.kind !== 'bundle') throw new Error('expected bundle');
    expect(withHtml.files[withHtml.entry]).not.toContain('import Layout');

    const withoutHtml = assemblePreview('NEXTJS', {
      'app/page.tsx': 'export default function Page() { return null; }',
      'app/layout.tsx': 'export default function L({children}){ return <div>{children}</div>; }',
    });
    if (withoutHtml.kind !== 'bundle') throw new Error('expected bundle');
    expect(withoutHtml.files[withoutHtml.entry]).toContain('import Layout');
  });

  it('renders static HTML directly and inlines local assets', () => {
    const result = assemblePreview('STATIC_HTML', {
      'index.html':
        '<html><head><link rel="stylesheet" href="/styles.css"></head><body><script src="app.js"></script></body></html>',
      'styles.css': 'body{color:red}',
      'app.js': 'console.log(1)',
    });
    expect(result.kind).toBe('html');
    if (result.kind !== 'html') return;
    expect(result.html).toContain('<style>body{color:red}</style>');
    expect(result.html).toContain('<script>console.log(1)</script>');
  });

  it('reports a clear reason when there is nothing to render', () => {
    expect(assemblePreview('REACT', {})).toEqual({
      kind: 'empty',
      reason: 'This project has no files yet.',
    });
    const noRoot = assemblePreview('REACT', { 'src/util.ts': 'export const a = 1;' });
    expect(noRoot.kind).toBe('empty');
    if (noRoot.kind !== 'empty') return;
    expect(noRoot.reason).toContain('src/App.tsx');
  });

  it('normalizes leading ./ and / in stored paths', () => {
    const result = assemblePreview('REACT', { './src/App.tsx': 'export default () => null;' });
    expect(result.kind).toBe('bundle');
  });
});
