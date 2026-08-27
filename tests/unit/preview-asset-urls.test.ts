import { afterEach, describe, expect, it, vi } from 'vitest';
import { assemblePreview } from '@/lib/preview/assemble';
import { buildStaticSite } from '@/lib/preview/server-bundle';

/**
 * The preview frame has to be able to *load* a project image, not merely mention
 * it.
 *
 * `components/workspace/BrowserPreview.tsx` renders the assembly into a `srcdoc`
 * iframe whose sandbox is `allow-scripts allow-forms allow-modals allow-popups`
 * — deliberately no `allow-same-origin`, because the document runs model-authored
 * JavaScript and same-origin would hand it the viewer's session (F-140). A
 * document with an opaque origin has no base URL, so a root-relative
 * `/uploads/projects/{id}/assets/{id}.webp` resolves against nothing and the
 * request is never made. Found live, not here: a build that placed four real
 * `ProjectAsset` images rendered every one of them as its alt text while
 * `HEAD /uploads/…` answered 200 on the app origin, so the customer approved a
 * page with no photographs and published one with photographs.
 *
 * These cases therefore assert the loadability of what comes out, not the
 * presence of the helper that produces it.
 */

const ORIGIN = 'https://navroop.example';
const ASSET = '/uploads/projects/p1/assets/4cJnaTWcbkyreSFK.webp';

/** Pretend to be the workspace tab, which is where the origin is read from. */
function inTheWorkspaceTab() {
  vi.stubGlobal('location', { origin: ORIGIN });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/**
 * Whether the sandboxed frame could fetch this reference.
 *
 * `new URL(ref)` with no base is exactly the question the browser asks in an
 * opaque-origin document: there is no base to fall back on, so only an absolute
 * reference resolves. A `data:` URI resolves too, which is correct — the frame
 * can load one of those without help.
 */
function loadableFromAnOpaqueOrigin(ref: string): boolean {
  try {
    new URL(ref);
    return true;
  } catch {
    return false;
  }
}

/**
 * Every URL the frame would actually request from this source: the `src` /
 * `srcSet` / `href` attribute values and the CSS `url(...)` targets, with a
 * `srcSet` split into its candidates and each descriptor (`2x`, `640w`) dropped.
 * Reading the emitted text the way a browser reads it is what keeps this from
 * re-implementing — and so agreeing with — the rewrite it is checking.
 */
function requestedUrls(source: string): string[] {
  const urls: string[] = [];
  for (const match of source.matchAll(/(?:src|srcSet|srcset|href)=["']([^"']+)["']/g)) {
    for (const candidate of match[1].split(',')) {
      const url = candidate.trim().split(/\s+/)[0];
      if (url) urls.push(url);
    }
  }
  for (const match of source.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)) {
    urls.push(match[2].trim());
  }
  return urls;
}

function bundleFiles(stack: string, files: Record<string, string>) {
  const result = assemblePreview(stack, files);
  if (result.kind !== 'bundle') throw new Error(`expected a bundle, got ${result.kind}`);
  return result.files;
}

describe('a project image reaches the sandboxed preview frame', () => {
  const PAGE = `import Image from 'next/image';

export default function Page() {
  return (
    <main>
      <Image src="${ASSET}" alt="The dining room" width={1200} height={800} />
      <img srcSet="${ASSET} 1x, /uploads/projects/p1/assets/wide.webp 2x" src="${ASSET}" alt="" />
      <div style={{ backgroundImage: 'url(/uploads/projects/p1/assets/hero.webp)' }} />
    </main>
  );
}
`;

  const CSS = `.hero {
  background-image: url("/uploads/projects/p1/assets/bg.webp");
}
`;

  it('every project-asset reference the frame would request is one it can resolve', () => {
    inTheWorkspaceTab();
    const files = bundleFiles('NEXTJS', { 'app/page.tsx': PAGE, 'app/globals.css': CSS });

    const requested = [
      ...requestedUrls(files['app/page.tsx']),
      ...requestedUrls(files['app/globals.css']),
    ].filter((url) => url.includes('/uploads/'));

    // The count is asserted so a fixture that stopped reaching the assembly —
    // a renamed key, a stack that no longer bundles — cannot pass this vacuously.
    expect(requested).toHaveLength(6);
    for (const url of requested) {
      expect(loadableFromAnOpaqueOrigin(url), `${url} is not loadable from an opaque origin`).toBe(
        true,
      );
      expect(new URL(url).origin).toBe(ORIGIN);
    }
  });

  it('resolves the second candidate of a comma-separated srcSet as well as the first', () => {
    // `srcset` may separate candidates with no space at all, which the HTML
    // parser accepts. Stopping the URL run only at whitespace read the whole
    // list as one path, so the first image pointed at a nonsense URL and the
    // second was never rewritten — one attribute away from the defect this
    // rewrite exists to close.
    inTheWorkspaceTab();
    const files = bundleFiles('NEXTJS', {
      'app/page.tsx': `export default function P(){ return <img srcSet="${ASSET},/uploads/projects/p1/assets/wide.webp 2x" alt="" />; }`,
    });

    const requested = requestedUrls(files['app/page.tsx']);
    expect(requested).toEqual([`${ORIGIN}${ASSET}`, `${ORIGIN}/uploads/projects/p1/assets/wide.webp`]);
  });

  it('rewrites a static-HTML page the same way', () => {
    inTheWorkspaceTab();
    const result = assemblePreview('STATIC_HTML', {
      'index.html': `<html><body><img src="${ASSET}" alt="The dining room"></body></html>`,
    });
    if (result.kind !== 'html') throw new Error(`expected html, got ${result.kind}`);
    expect(requestedUrls(result.html)).toEqual([`${ORIGIN}${ASSET}`]);
  });

  it('leaves a reference alone when it is already something the frame can fetch', () => {
    inTheWorkspaceTab();
    const source = `const remote = "https://cdn.example.com/uploads/hero.webp";
const bucket = "//bucket.example.com/uploads/hero.webp";
const inline = "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=";
const built = \`\${base}/uploads/hero.webp\`;
`;
    const files = bundleFiles('NEXTJS', {
      'app/page.tsx': 'export default function P(){ return null; }',
      'lib/images.ts': source,
    });
    // Byte-identical: an absolute URL, a protocol-relative one and a `data:`
    // payload already resolve, and prefixing the origin onto a template hole
    // would point it at a host that does not exist.
    expect(files['lib/images.ts']).toBe(source);
  });

  it('does not rewrite the project files publish and export still read', () => {
    // `collectPublishAssets` (lib/publish/assets.ts) copies the bytes into
    // `{publicDir}/uploads/…` in the deploy repo, so the deployed page answers
    // its own `/uploads/…` — which needs the *stored* files to keep the relative
    // form. The preview resolves the same path the other way round, and must not
    // reach back into the map it was handed.
    inTheWorkspaceTab();
    const raw = { 'app/page.tsx': PAGE, 'app/globals.css': CSS };
    const before = JSON.stringify(raw);
    bundleFiles('NEXTJS', raw);
    expect(JSON.stringify(raw)).toBe(before);
  });

  it('leaves the reference relative when this deployment cannot name an origin', () => {
    // The documented floor. A guessed host points every image on the page at
    // somewhere that does not exist; leaving it relative costs the one broken
    // image it already cost.
    vi.stubGlobal('location', undefined);
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '');
    const files = bundleFiles('NEXTJS', { 'app/page.tsx': PAGE });
    expect(requestedUrls(files['app/page.tsx'])).toContain(ASSET);
  });

  it('refuses an unparseable origin rather than inventing a host', () => {
    vi.stubGlobal('location', undefined);
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://undefined');
    const files = bundleFiles('NEXTJS', { 'app/page.tsx': PAGE });
    expect(files['app/page.tsx']).not.toContain('https://undefined/uploads/');
  });

  it('reads the build-time public URL when there is no tab to ask', () => {
    // `buildStaticSite` runs this same assembly on the server for the served
    // `/preview-static` build, which is a *different* origin again and answers no
    // `/uploads/…` of its own.
    vi.stubGlobal('location', undefined);
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.navroop.example/');
    const files = bundleFiles('NEXTJS', { 'app/page.tsx': PAGE });
    expect(requestedUrls(files['app/page.tsx'])).toContain(
      `https://app.navroop.example${ASSET}`,
    );
  });
});

/**
 * The same assembly, one step further on — the document a customer is sent a
 * link to.
 *
 * Every case above reads `assemblePreview`'s file map, which is the source the
 * bundler is handed rather than the thing a browser loads. `buildStaticSite`
 * (lib/preview/server-bundle.ts) runs that same assembly on the server and puts
 * it through esbuild for the served `/preview-static` build, and esbuild has an
 * opinion about these references: a CSS `url()` token is a module specifier to
 * it, so it either resolves one, rewrites it, or fails the build on it. A change
 * to any of that would undo the fix without a single case above changing colour,
 * which is why the assertions here are on the emitted document.
 */
describe('the rewritten reference survives the bundler into the served document', () => {
  const CSS_ASSET = '/uploads/projects/p1/assets/hero.webp';

  /** There is no tab on the server, so the build-time public URL is the only origin. */
  function onTheServer(appUrl: string) {
    vi.stubGlobal('location', undefined);
    vi.stubEnv('NEXT_PUBLIC_APP_URL', appUrl);
  }

  it('emits no root-relative project-asset reference, in markup or in CSS', async () => {
    onTheServer('https://app.navroop.example');
    const built = await buildStaticSite(
      'NEXTJS',
      {
        'app/page.tsx': `export default function Page() {
  return <img src="${ASSET}" alt="The dining room" />;
}
`,
        'app/globals.css': `.hero { background-image: url("${CSS_ASSET}"); }`,
      },
      'premium',
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const html = built.files['index.html'];

    // The three openers a reference can appear behind once it is in the document:
    // an attribute value, a string literal in the compiled module, and a CSS
    // `url(`. The served build sits on the preview host, which answers no
    // `/uploads/…` of its own, so a survivor here is a 404 rather than an image.
    expect(html).not.toMatch(/["'(]\/uploads\//);
    expect(html).toContain(`https://app.navroop.example${ASSET}`);
    expect(html).toContain(`https://app.navroop.example${CSS_ASSET}`);
  });

  it('the floor when no origin is known is a dead preview, not one broken image', async () => {
    // Measured, not assumed — and it is why the comment on `previewAssetOrigin`
    // no longer promises "one broken image" for this branch. With no origin the
    // reference stays relative, and the virtual resolver behind the bundler
    // reads the CSS `url()` as a module specifier it has no entry for, so the
    // build fails and the page renders not at all. A `src` in the same project
    // would have cost only itself. This is pinned so the cost is visible to
    // whoever chooses this floor next; closing it means marking project-asset
    // references `external` in lib/preview/bundle.ts and server-bundle.ts, which
    // own the esbuild options.
    onTheServer('');
    const built = await buildStaticSite(
      'NEXTJS',
      {
        'app/page.tsx': 'export default function Page() { return null; }',
        'app/globals.css': `.hero { background-image: url("${CSS_ASSET}"); }`,
      },
      'premium',
    );
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error).toContain(CSS_ASSET);
    expect(built.error).toContain('app/globals.css');
  });
});
