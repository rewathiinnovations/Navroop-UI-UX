import { describe, expect, it } from 'vitest';
import { assemblePreview } from '@/lib/preview/assemble';
import { buildStaticSite } from '@/lib/preview/server-bundle';
import { getStackStarterFiles } from '@/lib/stacks/starter';

/**
 * The preview and the deployed site have to agree about borders.
 *
 * `@layer base { … }` in a Tailwind v3 stylesheet is a build directive: PostCSS
 * removes the wrapper and emits the rules into the base layer, unlayered, after
 * preflight. The preview has no PostCSS — esbuild passes the stylesheet through —
 * so the literal at-rule used to reach the frame's `<style>` tag as a *real* CSS
 * cascade layer, while the Play CDN injects its preflight unlayered. Layer order
 * is resolved before specificity, so every declaration inside that block sat
 * below preflight's `border-color: #e5e7eb` no matter what: a
 * `className="border rounded-lg"` card rendered gray-200 in the workspace
 * preview and the direction's `--border` in the served `/preview-static` build,
 * the ZIP export and the published site. The user approved one appearance and
 * shipped another — the exact property `lib/preview/server-bundle.ts` claims for
 * itself.
 *
 * Found by looking at the running app, so these cases assert the two mechanisms
 * that decide the outcome — where the rule sits in the layer order, and what its
 * selector outranks — rather than a screenshot's worth of proxy.
 */

const PAGE = `export default function Page() {
  return <div className="border rounded-lg p-4">Card</div>;
}
`;

/** The `<style>` element's contents — the whole stylesheet the frame ever sees. */
function previewStylesheet(html: string): string {
  const open = html.indexOf('<style>');
  const close = html.indexOf('</style>', open);
  if (open === -1 || close === -1) throw new Error('the built document carries no <style>');
  return html.slice(open + '<style>'.length, close);
}

/**
 * The `@layer` names wrapping the first occurrence of `needle`, outermost first.
 *
 * Counting braces rather than matching a string, because "the sheet still
 * mentions `@layer` somewhere" and "this declaration is inside one" are
 * different questions and only the second one changes what the browser paints.
 */
function enclosingLayers(css: string, needle: string): string[] {
  const at = css.indexOf(needle);
  if (at === -1) throw new Error(`the stylesheet does not contain ${needle}`);
  const open: Array<string | null> = [];
  let blockStart = 0;
  for (let i = 0; i < at; i += 1) {
    if (css[i] === '{') {
      const header = css.slice(blockStart, i).trim();
      const layer = /@layer\s+([\w-]+)\s*$/i.exec(header);
      open.push(layer ? layer[1] : null);
      blockStart = i + 1;
    } else if (css[i] === '}') {
      open.pop();
      blockStart = i + 1;
    } else if (css[i] === ';') {
      blockStart = i + 1;
    }
  }
  return open.filter((name): name is string => name !== null);
}

/** The selector of the rule that paints `--border` onto everything. */
function borderRuleSelector(css: string): string {
  const match = /([^{}]+)\{[^{}]*border-color:\s*hsl\(var\(--border\)\)/.exec(css);
  if (!match) throw new Error('the stylesheet has no --border base rule');
  return match[1].trim();
}

describe('the base rules outrank preflight in the preview, as they do in the repo', () => {
  for (const [stack, pagePath] of [
    ['NEXTJS', 'app/page.tsx'],
    ['REACT', 'src/App.tsx'],
  ] as const) {
    it(`${stack}: the border rule reaches the frame unlayered`, async () => {
      const built = await buildStaticSite(stack, { [pagePath]: PAGE }, 'premium');
      expect(built.ok).toBe(true);
      if (!built.ok) return;
      const css = previewStylesheet(built.files['index.html']);

      // Inside a layer it loses to the CDN's unlayered preflight regardless of
      // specificity, which is the whole defect.
      expect(enclosingLayers(css, 'border-color:hsl(var(--border))')).toEqual([]);
      // The token block travels with it and must not be stranded in a layer either.
      expect(enclosingLayers(css, '--border:')).toEqual([]);
    });

    it(`${stack}: the border rule's selector beats preflight and loses to a utility`, async () => {
      const built = await buildStaticSite(stack, { [pagePath]: PAGE }, 'premium');
      expect(built.ok).toBe(true);
      if (!built.ok) return;
      const selector = borderRuleSelector(previewStylesheet(built.files['index.html']));

      // Preflight's rule is `*, ::before, ::after` — specificity (0,0,0). A bare
      // `*` here ties with it, and a tie is decided by source order, which for
      // the preview means the injection point of an unpinned third-party script
      // at cdn.tailwindcss.com. One type selector settles it for good.
      expect(selector).toMatch(/(^|\s)[a-z]+(\s|$)/);
      // …and no class or id, so `border-primary` — (0,1,0) — still overrides it.
      expect(selector).not.toMatch(/[.#[]/);
    });
  }

  it('flattens a layer the model wrote itself, not only the starter kit’s', async () => {
    // The larger half of the same defect: every shadcn/ui snippet in the training
    // data wraps its base rules this way, so a project that ships its own
    // `app/globals.css` reproduces it with the starter stylesheet nowhere in
    // sight — and that project's own file correctly wins the merge.
    const built = await buildStaticSite(
      'NEXTJS',
      {
        'app/page.tsx': PAGE,
        'app/globals.css': `@tailwind base;

@layer base {
  :root {
    --border: 200 20% 80%;
  }

  html * {
    border-color: hsl(var(--border));
  }
}
`,
      },
      'premium',
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const css = previewStylesheet(built.files['index.html']);
    expect(css).toContain('--border: 200 20% 80%');
    expect(enclosingLayers(css, 'border-color:hsl(var(--border))')).toEqual([]);
  });

  it('leaves a layer name Tailwind does not own exactly where the author put it', () => {
    // Tailwind only ever removes `base`, `components` and `utilities` — it errors
    // on any other name, having no `@tailwind` directive to emit it into. So any
    // other name is a real cascade layer the author meant, and unwrapping it here
    // would change the page rather than stop changing it.
    const result = assemblePreview('NEXTJS', {
      'app/page.tsx': PAGE,
      'app/globals.css': '@layer navroop { .card { color: red } }\n@layer base { .b { color: blue } }\n',
    });
    if (result.kind !== 'bundle') throw new Error('expected a bundle');
    expect(result.files['app/globals.css']).toContain('@layer navroop {');
    expect(result.files['app/globals.css']).not.toContain('@layer base {');
  });

  it('returns an unbalanced stylesheet untouched rather than dropping a brace', () => {
    // Removing an opener whose closer was never found emits a stray `}` and takes
    // out every rule after it — a worse answer than the layering this fixes.
    const broken = '@layer base { .a { color: red }\n';
    const result = assemblePreview('NEXTJS', {
      'app/page.tsx': PAGE,
      'app/globals.css': broken,
    });
    if (result.kind !== 'bundle') throw new Error('expected a bundle');
    expect(result.files['app/globals.css']).toBe(broken);
  });

  it('leaves STATIC_HTML layered, because nginx serves that sheet byte for byte', () => {
    // There is no PostCSS anywhere on that stack's path, so its `@layer` really is
    // a cascade layer in production. Flattening it in the preview would create the
    // divergence the rest of this file removes.
    const layered = '@layer base { .card { border-color: rebeccapurple } }';
    const result = assemblePreview('STATIC_HTML', {
      'index.html': '<html><head><link rel="stylesheet" href="/site.css"></head><body></body></html>',
      'site.css': layered,
    });
    if (result.kind !== 'html') throw new Error('expected html');
    expect(result.html).toContain(layered);
  });
});

describe('the stylesheet the repo ships is still the one PostCSS wants', () => {
  for (const [stack, cssPath, pagePath] of [
    ['NEXTJS', 'app/globals.css', 'app/page.tsx'],
    ['REACT', 'src/index.css', 'src/App.tsx'],
  ] as const) {
    it(`${stack}: keeps the @layer base wrapper, and the same selector reaches both`, async () => {
      const shipped = getStackStarterFiles(stack, 'premium')[cssPath];
      // The wrapper is what hoists these ahead of components and utilities once
      // PostCSS runs. Deleting it here to "match the preview" would move the rules
      // to the end of the sheet in every exported and published repo; the preview
      // is brought to the repo instead, in `flattenTailwindLayers`.
      expect(shipped).toContain('@layer base {');

      // One stylesheet, one selector. The two paths are allowed to differ in how
      // the layer is spelled — only PostCSS strips it for real — and in nothing
      // else, or "what you approve is what you ship" is back to being a claim.
      const built = await buildStaticSite(stack, { [pagePath]: PAGE }, 'premium');
      expect(built.ok).toBe(true);
      if (!built.ok) return;
      expect(borderRuleSelector(previewStylesheet(built.files['index.html']))).toBe(
        borderRuleSelector(shipped),
      );
    });
  }
});
