import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assemblePreview } from '@/lib/preview/assemble';
import { buildPreviewSrcdoc } from '@/lib/preview/html';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

function source(relative: string) {
  return readFileSync(path.join(REPO_ROOT, relative), 'utf8');
}

/**
 * A sandboxed srcdoc inherits the parent document's URL as `baseURI`. A click
 * on `<a href="/shop">` therefore aims at `http://<app>/shop` — either it
 * escapes the preview into Navroop or the sandbox silently blocks the
 * navigation, so the link looks dead (F-145). Hash links have the same escape.
 *
 * The document-level interceptor has to catch `/` paths as well as `#` hashes,
 * route them through the in-frame navigator, and accept a navigate message
 * from the workspace page picker (which can no longer set `iframe.src` — that
 * only worked when a sandbox VM served a URL).
 */

function inlineScriptContaining(srcdoc: string, needle: string): string {
  for (const part of srcdoc.split('<script>').slice(1)) {
    const end = part.indexOf('</script>');
    const body = end === -1 ? part : part.slice(0, end);
    if (body.includes(needle)) return body;
  }
  throw new Error(`no inline script in the srcdoc contains ${needle}`);
}

describe('preview srcdoc link interceptor', () => {
  const srcdoc = buildPreviewSrcdoc({ code: 'void 0;' });

  it('intercepts in-project absolute paths, not only hash anchors', () => {
    const script = inlineScriptContaining(srcdoc, '__previewNavigate');
    expect(script).toContain('preventDefault');
    // `/shop` must be treated as an in-frame route, same as `#reserve`.
    expect(script).toMatch(/href\[0\]\s*===\s*["']\/["']/);
    expect(script).toMatch(/href\[0\]\s*===\s*["']#["']/);
  });

  it('listens for a parent navigate message so the page picker can route the frame', () => {
    const script = inlineScriptContaining(srcdoc, 'type !== "navigate"');
    expect(script).toContain('__previewNavigate');
    expect(script).toContain('addEventListener("message"');
  });

  it('posts that navigate at the BrowserPreview frame, not the deleted sandbox iframe', () => {
    // GenerationWorkspace.iframeRef is only attached when sandboxData.url is
    // set — a value nothing assigns since the VMs were deleted — so posting
    // there is a guaranteed no-op. The live srcdoc is previewFrameRef in
    // ProjectWorkspace (the same ref BrowserPreview uses).
    const project = source('components/workspace/ProjectWorkspace.tsx');
    const generation = source('components/workspace/GenerationWorkspace.tsx');

    expect(project).toMatch(/postNavigateToPreviewFrame\(\s*previewFrameRef\.current/);
    expect(generation).not.toMatch(/iframeRef\.current\?\.contentWindow\?\.postMessage/);
  });

  it('binds the click listener on capture so a later preventDefault cannot swallow the route', () => {
    const script = inlineScriptContaining(srcdoc, '__previewNavigate');
    expect(script).toMatch(/addEventListener\(\s*["']click["'][\s\S]*true\s*\)/);
  });
});

describe('the next/navigation shim publishes the in-frame navigator', () => {
  it('assigns window.__previewNavigate so the srcdoc interceptor can call it', () => {
    const result = assemblePreview('NEXTJS', {
      'app/page.tsx': 'export default function Home(){ return null; }',
      'app/shop/page.tsx': 'export default function Shop(){ return null; }',
    });
    if (result.kind !== 'bundle') throw new Error('expected bundle');

    const shim = result.files[result.aliases['next/navigation']];
    expect(shim).toContain('__previewNavigate');
    expect(shim).toContain('__navigate');
  });

  it('does not history.pushState a root-absolute path that would leave about:srcdoc', () => {
    const result = assemblePreview('NEXTJS', {
      'app/page.tsx': 'export default function Home(){ return null; }',
    });
    if (result.kind !== 'bundle') throw new Error('expected bundle');

    const shim = result.files[result.aliases['next/navigation']];
    // `history.pushState({}, '', '/shop')` on a srcdoc whose location is the
    // parent app URL becomes a real navigation to http://<app>/shop.
    expect(shim).not.toMatch(/pushState\(\s*\{\s*\}\s*,\s*['"]['"]\s*,\s*path\s*\)/);
  });
});

describe('unknown in-frame routes do not silently stay on home', () => {
  it('renders a not-found page instead of falling back to /', () => {
    const result = assemblePreview('NEXTJS', {
      'app/page.tsx': 'export default function Home(){ return null; }',
      'app/shop/page.tsx': 'export default function Shop(){ return null; }',
    });
    if (result.kind !== 'bundle') throw new Error('expected bundle');

    const entry = result.files[result.entry];
    expect(entry).toContain('Page not found');
    expect(entry).not.toMatch(
      /routes\.find\(function \(route\) \{ return route\.path === '\/'; \}\)/,
    );
  });
});
