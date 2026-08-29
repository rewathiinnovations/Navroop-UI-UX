import { describe, expect, it } from 'vitest';
import { buildRepoFiles } from '@/lib/deploy/repo-files';
import {
  DEFAULT_DESIGN_DIRECTION,
  DESIGN_DIRECTIONS,
  renderTokenCss,
} from '@/lib/design/directions';
import {
  renderTailwindConfigExpression,
  tailwindThemeVariables,
  themeColorTokens,
} from '@/lib/design/tailwind-theme';
import { OPTIONAL_PREVIEW_DEPS, PREVIEW_DEPS, projectPreviewDeps } from '@/lib/preview/deps';
import { buildStaticSite } from '@/lib/preview/server-bundle';
import { resolveBareSpecifier } from '@/lib/preview/resolve-bare';
import { buildStablePromptPrefix } from '@/lib/stack-prompts';
import { STARTER_DEPENDENCIES } from '@/lib/stacks/templates/starter-kit';
import { getStackStarterFiles, starterFilePaths, withStarterFiles } from '@/lib/stacks/starter';
import { checkBuild } from '@/lib/validation/build-check';
import { decideAutoFix } from '@/lib/validation/autofix-policy';

/**
 * The locked stack, proved end to end rather than asserted file by file.
 *
 * Four things have to hold at once for a semantic class to be a colour in a
 * generated site, and each of them fails silently on its own:
 *
 * 1. the starter files have to reach the bundle (they are not in `lastCode`),
 * 2. `@/lib/utils` and `@/components/ui/*` have to resolve,
 * 3. the token CSS has to survive into the emitted document,
 * 4. the preview frame's Play CDN has to be handed the theme.
 *
 * Miss (3) or (4) and `bg-primary` compiles to `hsl()` with nothing in it,
 * which renders transparent — so a broken locked stack looks like an unstyled
 * site and nothing reports an error. Compiling a page that uses all four is the
 * only check that cannot pass while one of them is missing.
 */

/** A page that exercises the whole chain: the alias, `cn`, and two token classes. */
const PAGE = `import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export default function Page() {
  return (
    <main className={cn('bg-background', 'text-foreground')}>
      <Button className="bg-primary text-primary-foreground">Go</Button>
    </main>
  );
}
`;

/**
 * A page built the way the DESIGN rules now ask: Reveal-wrapped sections, a
 * SectionHeader opener, the premium and hero Button variants, and the entrance
 * animation utilities. If any of the craft machinery fails to compile, the model
 * following the prompt to the letter produces a broken build — so this page
 * compiling is the machinery's contract.
 */
const CRAFT_PAGE = `import { Button } from '@/components/ui/button';
import { Reveal } from '@/components/ui/reveal';
import { SectionHeader } from '@/components/ui/section-header';

export default function Page() {
  return (
    <main>
      <section className="bg-gradient-subtle">
        <h1 className="animate-fade-up text-6xl tracking-tight">Headline</h1>
        <Button variant="premium">Book now</Button>
        <Button variant="hero">Watch the film</Button>
      </section>
      <section className="bg-secondary/50">
        <Reveal>
          <SectionHeader eyebrow="Services" title="What we do" lede="Real copy." />
        </Reveal>
        <Reveal delay={80}>
          <p>Card</p>
        </Reveal>
      </section>
    </main>
  );
}
`;

const STACK_PAGE_PATH: Record<string, string> = {
  NEXTJS: 'app/page.tsx',
  REACT: 'src/App.tsx',
};

describe('the locked starter kit compiles and its tokens reach the frame', () => {
  for (const stack of ['NEXTJS', 'REACT'] as const) {
    it(`${stack}: a page using @/components/ui/button and cn() builds`, async () => {
      const files = {
        ...getStackStarterFiles(stack, 'premium'),
        [STACK_PAGE_PATH[stack]]: PAGE,
      };
      const result = await checkBuild({ stack, files, designDirection: 'premium' });
      expect(result.errors).toEqual([]);
      expect(result.status).toBe('passed');
    });

    it(`${stack}: a page using the craft machinery (Reveal, SectionHeader, premium/hero variants) builds`, async () => {
      const files = {
        ...getStackStarterFiles(stack, 'premium'),
        [STACK_PAGE_PATH[stack]]: CRAFT_PAGE,
      };
      const result = await checkBuild({ stack, files, designDirection: 'premium' });
      expect(result.errors).toEqual([]);
      expect(result.status).toBe('passed');
    });

    it(`${stack}: the built document carries the direction's tokens and the CDN config`, async () => {
      const built = await buildStaticSite(stack, { [STACK_PAGE_PATH[stack]]: PAGE }, 'premium');
      expect(built.ok).toBe(true);
      if (!built.ok) return;
      const html = built.files['index.html'];
      // premium's primary is the gold accent from its colorGuidance (#C4A35A).
      expect(html).toContain('--primary: 41 47% 56%');
      expect(html).toContain('--background: 39 44% 94%');
      // Without this the frame runs the Play CDN's stock theme and every
      // semantic class resolves to nothing.
      expect(html).toContain('tailwind.config =');
      // `<alpha-value>` is what keeps `bg-primary/90` working; the `var()` fallback
      // is what keeps a project whose stylesheet declares no `--primary` from
      // compiling `hsl( / 1)`. Matched as a shape rather than a literal because the
      // fallback is the *default* direction's triplet while this document is
      // premium's — the pair is checked against the token block itself further down.
      expect(html).toMatch(/hsl\(var\(--primary, [\d.]+ [\d.]+% [\d.]+%\) \/ <alpha-value>\)/);
    });
  }

  it('the starter files are merged in, not required from the caller', async () => {
    // The caller passes one page. If `assemblePreview` did not merge the starter
    // kit, `@/lib/utils` would not resolve and this would fail — which is what
    // makes the previous case a test of the merge and not of its own fixture.
    const built = await buildStaticSite('NEXTJS', { 'app/page.tsx': PAGE }, 'minimal');
    expect(built.ok).toBe(true);
  });

  it('a project file beats its starter counterpart', () => {
    const merged = withStarterFiles('NEXTJS', { 'app/globals.css': '/* mine */' }, 'premium');
    expect(merged['app/globals.css']).toBe('/* mine */');
    // The rest of the kit is still there.
    expect(merged['components/ui/button.tsx']).toContain('buttonVariants');
  });

  it('STATIC_HTML gets no starter kit', () => {
    expect(getStackStarterFiles('STATIC_HTML', 'premium')).toEqual({});
    expect(withStarterFiles('STATIC_HTML', { 'index.html': '<html></html>' })).toEqual({
      'index.html': '<html></html>',
    });
  });
});

/**
 * An unresolvable package used to compile clean.
 *
 * Both bundlers ended their resolve hook with `if (isBare(path)) return { external:
 * true }` and no allowlist, so an import of a package the import map does not serve
 * bundled fine, `checkBuild` reported `passed`, the user was told the build
 * succeeded, and the failure arrived in the iframe as "The preview could not load
 * one of its packages". It also left `decideAutoFix`'s `install` branch dead: nothing
 * ever produced a `missing-package` error for it to act on.
 *
 * These three are the before/after/and-the-policy-can-see-it triple.
 */
describe('an unresolvable package is a build error, not a clean compile', () => {
  const ACCORDION_PAGE = `import * as Accordion from '@radix-ui/react-accordion';

export default function Page() {
  return <Accordion.Root type="single" />;
}
`;

  function manifest(dependencies: Record<string, string>): string {
    return `${JSON.stringify({ name: 'app', dependencies }, null, 2)}\n`;
  }

  it('fails the build and names the package', async () => {
    const result = await checkBuild({
      stack: 'NEXTJS',
      files: {
        ...getStackStarterFiles('NEXTJS', 'premium'),
        'app/page.tsx': ACCORDION_PAGE,
      },
      designDirection: 'premium',
    });
    expect(result.status).toBe('failed');
    expect(result.missingPackages).toEqual(['@radix-ui/react-accordion']);
    expect(result.errors.some((error) => error.kind === 'missing-package')).toBe(true);
  });

  it('passes once the project declares it, at the pinned version', async () => {
    const files = {
      ...getStackStarterFiles('NEXTJS', 'premium'),
      'app/page.tsx': ACCORDION_PAGE,
      'package.json': manifest({ '@radix-ui/react-accordion': '^1.0.0' }),
    };
    const result = await checkBuild({ stack: 'NEXTJS', files, designDirection: 'premium' });
    expect(result.status).toBe('passed');
    // The version in the manifest is ignored — the pin is the product's.
    expect(projectPreviewDeps(files)['@radix-ui/react-accordion']).toBe(
      OPTIONAL_PREVIEW_DEPS['@radix-ui/react-accordion'],
    );
  });

  it('a package in neither map stays unavailable however the manifest asks', async () => {
    const files = {
      ...getStackStarterFiles('NEXTJS', 'premium'),
      'app/page.tsx': `import x from 'left-pad';\nexport default function Page() { return <p>{String(x)}</p>; }\n`,
      'package.json': manifest({ 'left-pad': '^1.3.0' }),
    };
    expect(projectPreviewDeps(files)['left-pad']).toBeUndefined();
    const result = await checkBuild({ stack: 'NEXTJS', files, designDirection: 'premium' });
    expect(result.status).toBe('failed');
    expect(result.missingPackages).toEqual(['left-pad']);
  });

  it('the autofix policy can now reach its install branch', async () => {
    const result = await checkBuild({
      stack: 'NEXTJS',
      files: {
        ...getStackStarterFiles('NEXTJS', 'premium'),
        'app/page.tsx': ACCORDION_PAGE,
      },
      designDirection: 'premium',
    });
    expect(decideAutoFix({ result, attempt: 0 })).toEqual({
      action: 'install',
      reason: 'missing-packages',
      packages: ['@radix-ui/react-accordion'],
    });
  });

  it('control: the same page with no import compiles', async () => {
    const result = await checkBuild({
      stack: 'NEXTJS',
      files: {
        ...getStackStarterFiles('NEXTJS', 'premium'),
        'app/page.tsx': 'export default function Page() { return <p>ok</p>; }\n',
      },
      designDirection: 'premium',
    });
    expect(result.status).toBe('passed');
  });
});

/**
 * The regression the allowlist created and the suite caught.
 *
 * esbuild asks the resolve hook about the target of every CSS `url()` and
 * `@import`, so absolute URLs arrive here routinely — a Google Fonts import, a CDN
 * image, a `data:` URI, and a project image that `previewAssetOrigin` rewrote to an
 * absolute URL. The blanket `external: true` the allowlist replaced covered them by
 * accident; without a scheme test `packageNameOf('https://…')` is `'https:'`, which
 * is in no dependency map, and every generated site with a web font or an image
 * failed to build with `Cannot find module "https:"`.
 *
 * One case per scheme, because the failure is per scheme.
 */
describe('a URL is not a package', () => {
  for (const specifier of [
    'https://fonts.googleapis.com/css2?family=Karla&display=swap',
    'http://cdn.example.com/hero.webp',
    'data:image/svg+xml;base64,PHN2Zy8+',
    'blob:https://example.com/abc',
    '//cdn.example.com/protocol-relative.webp',
    'vfs:app/page.tsx',
  ]) {
    it(`leaves ${specifier.slice(0, 34)} external`, () => {
      expect(resolveBareSpecifier(specifier, PREVIEW_DEPS)).toEqual({ external: true });
    });
  }

  it('still refuses a real package that is not available', () => {
    expect(resolveBareSpecifier('left-pad', PREVIEW_DEPS)).toEqual({
      error: 'Cannot find module "left-pad"',
    });
    // A subpath is judged on its package name.
    expect(resolveBareSpecifier('left-pad/deep/inner', PREVIEW_DEPS)).toEqual({
      error: 'Cannot find module "left-pad"',
    });
  });

  it('allows an available package and its subpath', () => {
    expect(resolveBareSpecifier('react', PREVIEW_DEPS)).toEqual({ external: true });
    expect(resolveBareSpecifier('@radix-ui/react-slot', PREVIEW_DEPS)).toEqual({ external: true });
    expect(resolveBareSpecifier('lucide-react/icons/x', PREVIEW_DEPS)).toEqual({ external: true });
  });

  /**
   * The whole point of the allowlist: a web font in the stylesheet must not stop the
   * build, and a missing package must. Both in one compile.
   */
  it('compiles a project whose stylesheet imports a web font', async () => {
    const files = {
      ...getStackStarterFiles('NEXTJS', 'premium'),
      'app/globals.css': `@import url("https://fonts.googleapis.com/css2?family=Karla&display=swap");\n@tailwind base;\n@tailwind components;\n@tailwind utilities;\n`,
      'app/page.tsx': 'export default function Page() { return <p>ok</p>; }\n',
    };
    const result = await checkBuild({ stack: 'NEXTJS', files, designDirection: 'premium' });
    expect(result.status).toBe('passed');
  });

  /**
   * The half of the scheme test that is not a URL.
   *
   * `node:fs` matches `scheme:` exactly as `https:` does, so a shape test alone
   * hands a Node builtin the same `external: true` it hands a web font — and no
   * browser resolves one. That compiles clean, `checkBuild` reports `passed`, the
   * user is told the build succeeded, and the iframe throws `Failed to resolve
   * module specifier`: the clean-compile-then-die this allowlist exists to end,
   * reintroduced through the exception carved out for stylesheet URLs. `node:` is
   * also the spelling a model reaches for first, and the unprefixed `fs` never
   * matched, so nothing else in this file would have caught it.
   */
  it('reports a Node builtin rather than reading its scheme as a URL', () => {
    expect(resolveBareSpecifier('node:fs', PREVIEW_DEPS)).toEqual({
      error: 'Cannot find module "node:fs"',
    });
    expect(resolveBareSpecifier('node:path/posix', PREVIEW_DEPS)).toEqual({
      error: 'Cannot find module "node:path"',
    });
    // The unprefixed spelling was never at risk and must stay refused with it.
    expect(resolveBareSpecifier('fs', PREVIEW_DEPS)).toEqual({
      error: 'Cannot find module "fs"',
    });
  });

  /**
   * The same fact through the real bundler, because the resolver is only half of
   * it: the refusal has to reach `extractMissingPackages` as a name a person can
   * act on, which is what makes the failure visible instead of iframe-only.
   */
  it('fails the build on a Node builtin, naming it', async () => {
    const files = {
      ...getStackStarterFiles('NEXTJS', 'premium'),
      'app/page.tsx':
        "import { readFileSync } from 'node:fs';\n" +
        'export default function Page() { return <p>{typeof readFileSync}</p>; }\n',
    };
    const result = await checkBuild({ stack: 'NEXTJS', files, designDirection: 'premium' });
    expect(result.status).toBe('failed');
    expect(result.missingPackages).toContain('node:fs');
  });
});

describe('the three things that must agree about a token name', () => {
  it('every variable the Tailwind theme reads is declared by the stylesheet', () => {
    for (const direction of Object.values(DESIGN_DIRECTIONS)) {
      const css = renderTokenCss(direction.tokens);
      for (const name of tailwindThemeVariables()) {
        expect(css, `${direction.id} is missing --${name}`).toContain(`--${name}:`);
      }
    }
  });

  it('every direction declares the same set of variables', () => {
    const names = Object.values(DESIGN_DIRECTIONS).map((direction) =>
      [...renderTokenCss(direction.tokens).matchAll(/--([\w-]+):/g)].map((match) => match[1]),
    );
    for (const list of names) {
      // 21 colour/radius names plus `primary-glow`, two gradients, two shadows
      // and the two font stacks. A direction that declared a different set would
      // give the model a class that works on five directions and silently does
      // nothing on one.
      expect(list).toHaveLength(27);
      expect(list).toEqual(names[0]);
    }
  });

  it('the depth and gradient tokens are derived from the direction palette', () => {
    // A gradient authored per direction could disagree with the colours it is
    // built from; deriving it means it cannot.
    const premium = renderTokenCss(DESIGN_DIRECTIONS.premium.tokens);
    expect(premium).toContain(
      '--gradient-primary: linear-gradient(135deg, hsl(41 47% 56%), hsl(41 60% 70%));',
    );
    expect(premium).toContain('--shadow-glow: 0 0 40px hsl(41 60% 70% / 0.4);');
    // premium's shadowGuidance is layered and soft.
    expect(premium).toMatch(/--shadow-elegant: 0 1px 2px .+, 0 8px 24px .+;/);

    // The three directions whose prose says "no shadows, 1px borders" get a
    // no-op `shadow-elegant`, which is the correct outcome rather than a gap.
    for (const id of ['minimal', 'editorial', 'technical'] as const) {
      expect(renderTokenCss(DESIGN_DIRECTIONS[id].tokens)).toContain('--shadow-elegant: none;');
    }
    // bold's is the hard offset its prose names, with no blur.
    expect(renderTokenCss(DESIGN_DIRECTIONS.bold.tokens)).toContain(
      '--shadow-elegant: 4px 4px 0 hsl(var(--foreground));',
    );
  });

  it('the theme exposes the gradients, shadows and motion as classes', () => {
    const theme = renderTailwindConfigExpression();
    // The classes exist and each carries a fallback. This case used to pin the
    // *bare* form, which is exactly the shape a project that declares none of
    // these variables drops on the floor — see the two fallback cases below.
    expect(theme).toMatch(/'gradient-primary': 'var\(--gradient-primary, linear-gradient\(/);
    expect(theme).toMatch(/elegant: 'var\(--shadow-elegant, /);
    expect(theme).toMatch(/glow: 'var\(--shadow-glow, /);
    // Motion is theme-only: BASE_RULES fixes 150-250ms, so 200ms must sit
    // inside that range and must not also exist as a CSS variable.
    expect(theme).toContain("smooth: '200ms'");
    expect(renderTokenCss(DESIGN_DIRECTIONS.minimal.tokens)).not.toContain('--transition');
  });

  it('the starter dependency ranges match the preview import map pins', () => {
    for (const [name, range] of Object.entries(STARTER_DEPENDENCIES)) {
      const pinned = PREVIEW_DEPS[name];
      expect(pinned, `${name} is in the starter kit but not in the import map`).toBeDefined();
      // `^2.1.1` against `2.1.1`: the scaffold's range and the preview's pin have
      // to name the same version, or the two compile different code.
      expect(range).toBe(`^${pinned}`);
    }
  });

  it('a project with no --radius keeps a usable corner radius', () => {
    // Found in the live preview frame, not by a unit test: a project generated
    // before the token block ships its own global stylesheet, which correctly
    // wins over the starter one — so it defines no `--radius`. A bare
    // `var(--radius)` is then an invalid declaration the browser drops, and
    // every existing project lost its corner radius with nothing reported.
    const theme = renderTailwindConfigExpression();
    expect(theme).toContain("lg: 'var(--radius, 0.5rem)'");
    expect(theme).toContain("md: 'calc(var(--radius, 0.5rem) - 2px)'");
    expect(theme).toContain("sm: 'calc(var(--radius, 0.5rem) - 4px)'");
    // No bare form survives anywhere.
    expect(theme).not.toMatch(/var\(--radius\)/);

    // The colours are no longer the exception they were when this case was
    // written. `BASE_RULES` went from banning the semantic classes to requiring
    // them, which put `bg-card` and `border-border` into edits of projects whose
    // stylesheet declares neither, and a bare `hsl(var(--card) / 1)` substitutes
    // to `hsl( / 1)` — dropped by the browser, so the section renders transparent
    // with nothing thrown. So they carry the same fallback `--radius` does, read
    // out of the default direction's own token block. The full sweep over all
    // twenty is in "every colour the theme maps has a fallback, not only --radius".
    expect(theme).toMatch(/hsl\(var\(--primary, [\d.]+ [\d.]+% [\d.]+%\) \/ <alpha-value>\)/);
  });

  it('every direction resolves to a distinct palette', () => {
    const blocks = Object.values(DESIGN_DIRECTIONS).map((row) => renderTokenCss(row.tokens));
    expect(new Set(blocks).size).toBe(blocks.length);
  });
});

/**
 * The legacy project — the one that already exists when the token block ships.
 *
 * Its own `app/globals.css` / `src/index.css` is in `lastCode`, and it wins over
 * the starter stylesheet at every merge point (`withStarterFiles` here,
 * `buildRepoFiles` for the pushed repo). So none of the twenty variables is
 * declared for it, while `BASE_RULES` now *requires* `bg-card`, `border-border`
 * and the rest — on follow-ups as well as first builds. The first edit after
 * that change therefore rewrites a section in classes the project's stylesheet
 * cannot resolve, and without a fallback each one compiles to `hsl( / 1)`, an
 * invalid declaration the browser drops: the section renders transparent and
 * unbordered, in the preview, the served build, the exported repo and the
 * published site, with nothing thrown, no failed build check (it compiles JS,
 * not CSS) and no finding recorded.
 *
 * These cases pin the floor: absent tokens must still paint something.
 */
describe('a project whose stylesheet predates the token block still renders', () => {
  /** An HSL triplet with no `hsl()` wrapper — what the token block declares. */
  const HSL_TRIPLET = /^[\d.]+ [\d.]+% [\d.]+%$/;

  /** Every `hsl(var(--x, fallback) / <alpha-value>)` the theme emits. */
  function themeFallbacks(source: string): Map<string, string> {
    return new Map(
      [...source.matchAll(/hsl\(var\(--([\w-]+), ([^)]+)\) \/ <alpha-value>\)/g)].map(
        (match) => [match[1], match[2]] as const,
      ),
    );
  }

  /**
   * What a project generated under the old prompt actually stores: Tailwind's
   * layers, a font rule, and its own private variable — none of the twenty.
   */
  const LEGACY_GLOBAL_CSS = `@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  --brand: #c4a35a;
}

body {
  font-family: Inter, sans-serif;
}
`;

  /** The edit the user asks for: "make the pricing section warmer". */
  const PRICING_PAGE = `export default function Page() {
  return (
    <section className="rounded-lg border border-border bg-card p-8 text-card-foreground">
      <h1 className="text-foreground">Pricing</h1>
      <p className="text-muted-foreground">Two plans, no surprises.</p>
    </section>
  );
}
`;

  it('every colour the theme maps has a fallback, not only --radius', () => {
    const fallbacks = themeFallbacks(renderTailwindConfigExpression());
    for (const name of themeColorTokens()) {
      const fallback = fallbacks.get(name);
      expect(fallback, `--${name} resolves to nothing on a project that declares it`).toBeDefined();
      expect(fallback).toMatch(HSL_TRIPLET);
    }
    // No colour may keep the bare form: that is the shape that compiles to an
    // invalid declaration the moment the variable is absent.
    expect(renderTailwindConfigExpression()).not.toMatch(/hsl\(var\(--[\w-]+\)/);
  });

  it('the fallbacks are the default direction, read from the token block itself', () => {
    // Restating a palette here is how the fallback and the stylesheet drift into
    // two different answers, so the values are derived from `renderTokenCss` and
    // this asserts they still are.
    const theme = renderTailwindConfigExpression();
    const tokens = renderTokenCss(DESIGN_DIRECTIONS[DEFAULT_DESIGN_DIRECTION].tokens);
    const declared = new Map(
      [...tokens.matchAll(/--([\w-]+): ([^;]+);/g)].map((match) => [match[1], match[2]]),
    );
    // Colours only here: the gradients and shadows are whole CSS values reached
    // through `backgroundImage` / `boxShadow` rather than triplets, so they carry
    // a fallback of a different shape and are swept in the case below.
    for (const name of themeColorTokens()) {
      const value = declared.get(name);
      expect(value, `the token block declares no --${name}`).toBeDefined();
      expect(theme).toContain(`hsl(var(--${name}, ${value}) / <alpha-value>)`);
    }
  });

  /**
   * The same defect as `--radius` and then the colours, in the two token groups
   * the earlier sweeps could not see: `themeFallbacks` only matches the
   * `hsl(var(--x, f) / <alpha-value>)` shape, and these four are whole CSS values
   * — a gradient and a shadow — so they sat bare through both fixes.
   *
   * A project that predates the token block declares none of them, so
   * `bg-gradient-primary` on a hero was an invalid declaration the browser drops:
   * no background at all, in the preview, the served build, the exported repo and
   * the published site, with nothing thrown and no failed check.
   *
   * Shapes, not literal values, for the same reason the colour case uses shapes:
   * the fallback is the default direction's while a document under test may be
   * another direction's.
   */
  it('the gradients and shadows have fallbacks too, not only the colours', () => {
    const theme = renderTailwindConfigExpression();
    for (const name of ['gradient-primary', 'gradient-subtle'] as const) {
      expect(theme, `--${name} is still bare`).not.toContain(`'var(--${name})'`);
      expect(theme).toMatch(new RegExp(`var\\(--${name}, linear-gradient\\([^)]`));
    }
    for (const name of ['shadow-elegant', 'shadow-glow'] as const) {
      expect(theme, `--${name} is still bare`).not.toContain(`'var(--${name})'`);
      expect(theme).toMatch(new RegExp(`var\\(--${name}, [^)]`));
    }
    // Nothing in the theme keeps the bare form, whatever its shape.
    expect(theme).not.toMatch(/var\(--[\w-]+\)/);
  });

  it('the gradient and shadow fallbacks come from the token block, not restated', () => {
    const theme = renderTailwindConfigExpression();
    const tokens = renderTokenCss(DESIGN_DIRECTIONS[DEFAULT_DESIGN_DIRECTION].tokens);
    const declared = new Map(
      [...tokens.matchAll(/--([\w-]+): ([^;]+);/g)].map((match) => [match[1], match[2]]),
    );
    for (const name of [
      'gradient-primary',
      'gradient-subtle',
      'shadow-elegant',
      'shadow-glow',
    ] as const) {
      const value = declared.get(name);
      expect(value, `the token block declares no --${name}`).toBeDefined();
      expect(theme).toContain(`var(--${name}, ${value})`);
    }
  });

  /**
   * The exported repo and the published site are built by `buildRepoFiles`, which
   * merges the scaffold rather than going through the preview merge — so a fix
   * that lived only in the preview theme would leave every shipped
   * `tailwind.config.js` bare.
   */
  it('the shipped tailwind.config.js carries the gradient and shadow fallbacks', () => {
    for (const stack of ['NEXTJS', 'REACT'] as const) {
      const config = getStackStarterFiles(stack, 'premium')['tailwind.config.js'];
      expect(config, `${stack} ships no tailwind.config.js`).toBeTruthy();
      expect(config, `${stack} ships a bare var()`).not.toMatch(/var\(--[\w-]+\)/);
      expect(config).toMatch(/var\(--gradient-primary, linear-gradient\(/);
      expect(config).toMatch(/var\(--shadow-glow, [^)]/);
    }
  });

  for (const [stack, cssPath, pagePath] of [
    ['NEXTJS', 'app/globals.css', 'app/page.tsx'],
    ['REACT', 'src/index.css', 'src/App.tsx'],
  ] as const) {
    it(`${stack}: bg-card and border-border still paint in the served build`, async () => {
      const built = await buildStaticSite(
        stack,
        { [cssPath]: LEGACY_GLOBAL_CSS, [pagePath]: PRICING_PAGE },
        'premium',
      );
      expect(built.ok).toBe(true);
      if (!built.ok) return;
      const html = built.files['index.html'];
      // The project's own stylesheet won, exactly as it must — a model edit to
      // the stylesheet has to beat the starter copy.
      expect(html).toContain('--brand');
      expect(html).not.toContain('--card:');
      expect(html).not.toContain('--border:');
      // …and the theme the frame is handed still gives both a real colour.
      const fallbacks = themeFallbacks(html);
      expect(fallbacks.get('card')).toMatch(HSL_TRIPLET);
      expect(fallbacks.get('card-foreground')).toMatch(HSL_TRIPLET);
      expect(fallbacks.get('border')).toMatch(HSL_TRIPLET);
    });
  }

  it('the tailwind.config.js the repo ships carries the same fallbacks', () => {
    // The exported repo and the published site are built by `buildRepoFiles`,
    // which merges the scaffold underneath the generated files rather than going
    // through `withStarterFiles` — so a fix that lived only in the preview merge
    // would leave the deployed site transparent. This config is the one file
    // both paths share.
    for (const stack of ['NEXTJS', 'REACT'] as const) {
      const config = getStackStarterFiles(stack, 'premium')['tailwind.config.js'];
      const fallbacks = themeFallbacks(config);
      expect(fallbacks.get('card'), `${stack} ships no --card fallback`).toMatch(HSL_TRIPLET);
      expect(fallbacks.get('border'), `${stack} ships no --border fallback`).toMatch(HSL_TRIPLET);
    }
  });

  it('STATIC_HTML keeps its colour exception, because no theme ever reaches it', () => {
    // The third stack has no starter kit, no tailwind.config.js and no injected
    // `tailwind.config` — `buildPreviewSrcdoc` renders its markup verbatim. A
    // fallback cannot help there, so the only thing that keeps the QUALITY rule
    // from demanding classes this stack cannot resolve is the exception in its
    // own stack prompt. Removing that is the same defect by another route.
    expect(getStackStarterFiles('STATIC_HTML', 'premium')).toEqual({});
    const prompt = buildStablePromptPrefix('STATIC_HTML', 'premium');
    expect(prompt).toContain('COLOUR EXCEPTION for this stack only');
    expect(prompt).toContain('do NOT apply here');
  });
});

/**
 * The kit's blast radius, pinned rather than inferred.
 *
 * It is merged at read time instead of being seeded into `Project.lastCode`, and
 * `lib/stacks/starter.ts` gives the reason: a non-empty `lastCode` is the
 * product's evidence that a site exists — `resumablePhaseFromEvidence`,
 * `duplicateProject`, the provisional-name check and `settleStreamedGeneration`
 * all read it that way — so seeding would make every brand-new project report as
 * finished before a file was generated. Merging at read time is retroactive by
 * construction: a project built months ago picks the kit up on its next preview,
 * and on its next `buildRepoFiles`, which is what an export, a GitHub push and a
 * republish all build from — including a PREVIEW publish started by something as
 * unrelated as setting a preview password.
 *
 * That retroactivity is the design. What keeps it from repainting a live site on
 * a deploy that was supposed to change a password is a two-part bound: the
 * project's own copy of a file wins at every merge point, and the set of paths
 * the kit can introduce is fixed. Both halves were only checked on the preview
 * path. `buildRepoFiles` is the one that reaches a customer's domain, and the
 * only merge it had a case for was `src/index.css`.
 */
describe('the starter kit cannot overwrite a project that already decided', () => {
  /**
   * Every path the kit may add, per stack. Written out rather than derived from
   * `starterFilePaths` so that growing the kit fails here and the decision to
   * push a twelfth file into every existing project gets made on purpose.
   */
  const STARTER_PATHS: Record<string, string[]> = {
    NEXTJS: [
      'app/globals.css',
      'components/sections/contact-form.tsx',
      'components/sections/cta-band.tsx',
      'components/sections/faq.tsx',
      'components/sections/feature-grid.tsx',
      'components/sections/hero.tsx',
      'components/sections/logo-cloud.tsx',
      'components/sections/pricing-tiers.tsx',
      'components/sections/site-footer.tsx',
      'components/sections/stats-band.tsx',
      'components/sections/testimonials.tsx',
      'components/ui/badge.tsx',
      'components/ui/button.tsx',
      'components/ui/card.tsx',
      'components/ui/dialog.tsx',
      'components/ui/input.tsx',
      'components/ui/label.tsx',
      'components/ui/reveal.tsx',
      'components/ui/section-header.tsx',
      'components/ui/skeleton.tsx',
      'components/ui/tabs.tsx',
      'lib/utils.ts',
      'tailwind.config.js',
    ],
    REACT: [
      'src/components/sections/contact-form.tsx',
      'src/components/sections/cta-band.tsx',
      'src/components/sections/faq.tsx',
      'src/components/sections/feature-grid.tsx',
      'src/components/sections/hero.tsx',
      'src/components/sections/logo-cloud.tsx',
      'src/components/sections/pricing-tiers.tsx',
      'src/components/sections/site-footer.tsx',
      'src/components/sections/stats-band.tsx',
      'src/components/sections/testimonials.tsx',
      'src/components/ui/badge.tsx',
      'src/components/ui/button.tsx',
      'src/components/ui/card.tsx',
      'src/components/ui/dialog.tsx',
      'src/components/ui/input.tsx',
      'src/components/ui/label.tsx',
      'src/components/ui/reveal.tsx',
      'src/components/ui/section-header.tsx',
      'src/components/ui/skeleton.tsx',
      'src/components/ui/tabs.tsx',
      'src/index.css',
      'src/lib/utils.ts',
      'tailwind.config.js',
    ],
  };

  const HOME_PAGE: Record<string, [string, string]> = {
    NEXTJS: ['app/page.tsx', 'export default function Page() { return null; }\n'],
    REACT: ['src/App.tsx', 'export default function App() { return null; }\n'],
  };

  for (const stack of ['NEXTJS', 'REACT'] as const) {
    it(`${stack}: the kit introduces exactly the paths it is allowed to`, () => {
      expect(starterFilePaths(stack)).toEqual(STARTER_PATHS[stack]);

      // …and that list is what a project which has none of them actually gains,
      // so the prompt's account of the kit and the merge's cannot drift apart.
      const [homePath, homeSource] = HOME_PAGE[stack];
      const merged = withStarterFiles(stack, { [homePath]: homeSource }, 'editorial');
      expect(Object.keys(merged).sort()).toEqual([...STARTER_PATHS[stack], homePath].sort());
    });

    it(`${stack}: a republish keeps every file the project wrote itself`, () => {
      // The failure this rules out: a site built on "editorial" is republished
      // for a domain change or a preview password, and the deploy repo comes
      // back with a globals.css painting the page the direction's background,
      // every bare border utility repainted off `--border`, and a container
      // capped at 1280px where the project's own config left Tailwind's 1536px.
      // Nothing about that deploy was supposed to change how the site looks.
      const own: Record<string, string> = {};
      for (const path of STARTER_PATHS[stack]) {
        own[path] = `/* the project's own ${path} — do not touch */\n`;
      }
      const [homePath, homeSource] = HOME_PAGE[stack];
      own[homePath] = homeSource;

      const repo = buildRepoFiles(stack, own, { designDirection: 'editorial' });
      for (const path of STARTER_PATHS[stack]) {
        expect(repo[path], `${path} was overwritten by the scaffold`).toBe(own[path]);
      }
      // The same merge, on the path the workspace preview takes, so the two
      // cannot answer this differently.
      const preview = withStarterFiles(stack, own, 'editorial');
      for (const path of STARTER_PATHS[stack]) {
        expect(preview[path], `${path} was overwritten in the preview`).toBe(own[path]);
      }
    });

    it(`${stack}: a project that wrote none of them gets the direction it was built on`, () => {
      // The other half of the bound. Retroactive is only defensible while the
      // palette the repo receives is the project's own — `designDirection`
      // reaching `buildRepoFiles` is what makes the deployed site agree with the
      // preview the customer approved rather than silently becoming `minimal`.
      const [homePath, homeSource] = HOME_PAGE[stack];
      const cssPath = stack === 'NEXTJS' ? 'app/globals.css' : 'src/index.css';
      const repo = buildRepoFiles(
        stack,
        { [homePath]: homeSource },
        {
          designDirection: 'premium',
        },
      );
      expect(repo[cssPath]).toBe(getStackStarterFiles(stack, 'premium')[cssPath]);
      expect(repo[cssPath]).not.toBe(getStackStarterFiles(stack, 'editorial')[cssPath]);
    });
  }

  it('STATIC_HTML is outside the radius entirely, on both paths', () => {
    // No module graph and no package.json, so there is nowhere for
    // `components/ui/*` or a shared config to live. It has to stay excluded on
    // the repo path too, or an export would ship a Tailwind config to a stack
    // that never runs Tailwind.
    expect(starterFilePaths('STATIC_HTML')).toEqual([]);
    const repo = buildRepoFiles('STATIC_HTML', { 'index.html': '<html></html>' });
    expect(repo['tailwind.config.js']).toBeUndefined();
    expect(repo['components/ui/button.tsx']).toBeUndefined();
  });
});
