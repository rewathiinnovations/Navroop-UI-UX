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
    expect(result.files[result.entry]).toContain("'/app/page.tsx'");
    // next/* has no browser build; unshimmed imports kill the preview.
    expect(result.aliases['next/link']).toBeTruthy();
    expect(result.files[result.aliases['next/link']]).toContain("'a'");
    expect(result.files[result.aliases['next/image']]).toContain("'img'");
  });

  it('mounts a Next.js layout that renders its own <html>, so the nav and footer appear', () => {
    // The incident: a generated site had components/Nav.tsx and components/Footer.tsx,
    // and app/layout.tsx imported both — the Next.js App Router's own convention.
    // The preview dropped the layout because it rendered <html>, so the site
    // previewed with no header and no footer and read as if they were never built.
    const result = assemblePreview('NEXTJS', {
      'app/page.tsx': 'export default function Page() { return null; }',
      'app/layout.tsx':
        'import Nav from "@/components/Nav";\nexport default function L({children}){ return <html lang="en"><body className="x"><Nav />{children}</body></html>; }',
      'components/Nav.tsx': 'export default function Nav(){ return <nav>site</nav>; }',
    });
    if (result.kind !== 'bundle') throw new Error('expected bundle');

    expect(result.files[result.entry]).toContain('import Layout');
    const adapted = result.files['app/__preview-layout.tsx'];
    // React mounts into an existing document, so only the document tags are
    // swapped; everything else, including the Nav import, is untouched.
    expect(adapted).toBeTruthy();
    expect(adapted).not.toMatch(/<html|<\/html>|<body|<\/body>/);
    expect(adapted).toContain('<div lang="en">');
    expect(adapted).toContain('<div className="x">');
    expect(adapted).toContain('<Nav />');
    expect(adapted).toContain('{children}');
    // The project's own file is never rewritten.
    expect(result.files['app/layout.tsx']).toContain('<html lang="en">');
  });

  it('keeps the adapted copy beside the original, so relative imports still resolve', () => {
    // First attempt put the copy at `__preview/layout.tsx`, which moved `./globals.css`
    // one directory away: the pane reported `imports "./globals.css", but no file with
    // that path was generated` and the site would not compile at all.
    const result = assemblePreview('NEXTJS', {
      'app/page.tsx': 'export default function Page() { return null; }',
      'app/globals.css': 'body{margin:0}',
      'app/layout.tsx':
        'import "./globals.css";\nexport default function L({children}){ return <html><body>{children}</body></html>; }',
    });
    if (result.kind !== 'bundle') throw new Error('expected bundle');

    expect(result.files['app/__preview-layout.tsx']).toContain('import "./globals.css"');
    expect(result.files[result.entry]).toContain("import Layout from '/app/__preview-layout.tsx'");
  });

  it('exports every font the project imports, not a fixed list', () => {
    // The first real site asked for `Open_Sans`, which the hardcoded shim did not
    // have, so the whole preview failed to compile on a font name once the layout
    // was mounted. Google ships hundreds of families; a list can only miss.
    const result = assemblePreview('NEXTJS', {
      'app/page.tsx': 'export default function Page() { return null; }',
      'app/layout.tsx':
        'import { Open_Sans, Poppins as display } from "next/font/google";\nexport default function L({children}){ return <html><body>{children}</body></html>; }',
    });
    if (result.kind !== 'bundle') throw new Error('expected bundle');

    const shim = result.files[result.aliases['next/font/google']];
    expect(shim).toContain('export const Open_Sans = font;');
    // An alias still needs the exported name, not the local one.
    expect(shim).toContain('export const Poppins = font;');
    expect(shim).not.toContain('export const display');
    expect(shim).toContain('export default font;');
  });

  it('imports a layout that needs no adaptation directly', () => {
    const result = assemblePreview('NEXTJS', {
      'app/page.tsx': 'export default function Page() { return null; }',
      'app/layout.tsx': 'export default function L({children}){ return <div>{children}</div>; }',
    });
    if (result.kind !== 'bundle') throw new Error('expected bundle');

    expect(result.files[result.entry]).toContain("import Layout from '/app/layout.tsx'");
    expect(result.files['app/__preview-layout.tsx']).toBeUndefined();
  });

  it('mounts an async layout instead of silently dropping it', () => {
    // F-153: `export default async function RootLayout` is idiomatic App Router
    // for a layout that fetches data, and the assembler skipped the whole file —
    // so the nav and the footer vanished from the preview while components/Nav.tsx
    // sat in the file tree, the exact symptom mounting the layout exists to
    // prevent. React cannot render a promise, so the async body is called outside
    // render and its result swapped in when it resolves; until then (and if it
    // rejects, which server-only data fetching in a browser will) the children
    // render alone, which is all dropping the layout ever achieved.
    const result = assemblePreview('NEXTJS', {
      'app/page.tsx': 'export default function Page() { return null; }',
      'app/layout.tsx':
        'import Nav from "@/components/Nav";\nexport default async function L({children}){ const d = await fetch("/x"); return <html><body><Nav />{children}</body></html>; }',
    });
    if (result.kind !== 'bundle') throw new Error('expected bundle');

    expect(result.files[result.entry]).toContain('import Layout');
    const adapted = result.files['app/__preview-layout.tsx'];
    expect(adapted).toBeTruthy();
    // The async body survives under its own name, no longer default-exported…
    expect(adapted).not.toMatch(/export\s+default\s+async\s+function/);
    expect(adapted).toContain('async function L({children})');
    // …and the new default export is a sync component that renders the children
    // first and the resolved layout after.
    expect(adapted).toMatch(/export default function \w+/);
    expect(adapted).toContain('<div>');
    expect(adapted).not.toMatch(/<html|<body/);
    // The project's own file is never rewritten.
    expect(result.files['app/layout.tsx']).toContain('export default async function L');
  });

  it('rewrites document tags only in code position, not inside strings', () => {
    // F-152: the swap was a plain regex over the file's text, so an analytics
    // snippet or a <noscript> fallback carrying the literal "<body" in a string
    // had that string rewritten too — the preview then rendered markup the real
    // build never contains, invisibly.
    const result = assemblePreview('NEXTJS', {
      'app/page.tsx': 'export default function Page() { return null; }',
      'app/layout.tsx': [
        'const SNIPPET = `<body class="tracked"></body>`;',
        'const NOTE = "closes </html> for old crawlers";',
        '// <head> in a comment stays a comment',
        'export default function L({children}){',
        '  return <html><body><div dangerouslySetInnerHTML={{ __html: SNIPPET }} />{NOTE}{children}</body></html>;',
        '}',
      ].join('\n'),
    });
    if (result.kind !== 'bundle') throw new Error('expected bundle');

    const adapted = result.files['app/__preview-layout.tsx'];
    expect(adapted).toContain('`<body class="tracked"></body>`');
    expect(adapted).toContain('"closes </html> for old crawlers"');
    expect(adapted).toContain('// <head> in a comment stays a comment');
    // The JSX the layout actually renders is still adapted.
    expect(adapted).toContain('return <div><div>');
  });

  it('reads JSX text as prose, so an apostrophe or a URL cannot hide a later tag', () => {
    // The hazard a string-aware scan introduces if it treats JSX text as
    // JavaScript: the ' in "Don't" would open a string and the // in a URL a
    // comment, swallowing the </body> that follows and leaving a second <body>
    // in the mounted copy — worse than the blanket rewrite it replaced.
    const result = assemblePreview('NEXTJS', {
      'app/page.tsx': 'export default function Page() { return null; }',
      'app/layout.tsx': [
        'export default function L({children}){',
        '  return <html><body>',
        "    <p>Don't stop — see https://example.com/docs for more</p>",
        '    {children}',
        '  </body></html>;',
        '}',
      ].join('\n'),
    });
    if (result.kind !== 'bundle') throw new Error('expected bundle');

    const adapted = result.files['app/__preview-layout.tsx'];
    expect(adapted).not.toMatch(/<html|<body|<\/html>|<\/body>/);
    expect(adapted).toContain("Don't stop — see https://example.com/docs for more");
  });

  it('hides a <head> without stopping its stylesheet links from loading', () => {
    const result = assemblePreview('NEXTJS', {
      'app/page.tsx': 'export default function Page() { return null; }',
      'app/layout.tsx':
        'export default function L({children}){ return <html><head><link rel="stylesheet" href="https://fonts.example/x.css" /></head><body>{children}</body></html>; }',
    });
    if (result.kind !== 'bundle') throw new Error('expected bundle');

    const adapted = result.files['app/__preview-layout.tsx'];
    expect(adapted).toContain('<div hidden>');
    expect(adapted).toContain('rel="stylesheet"');
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
