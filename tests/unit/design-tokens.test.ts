import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * F-833: `tailwind.config.ts` maps every key of the colour manifest to
 * `var(--<key>)`, so a Tailwind utility exists whether or not a CSS variable
 * backs it. Three keys had no definition anywhere (`heat-90`, `accent-forest`,
 * `accent-honey`) and `--heat-200` was defined in CSS but absent from the
 * manifest, so `bg-heat-200` was never generated. Both failures are silent: an
 * invalid `var()` drops the declaration and an ungenerated class emits nothing,
 * so the build stays green and editors still autocomplete the class.
 *
 * Two source families are checked because the repo used both spellings —
 * `bg-heat-90` (needs a manifest key) and `hover:bg-[color:var(--heat-90)]` on
 * the shared shadcn Button (needs a CSS declaration).
 */

const CSS_PATH = 'styles/design-system/colors.css';

/**
 * The manifest that Tailwind actually reads, resolved from the config's import
 * rather than hardcoded — the file existed twice until this wave.
 */
function loadManifest() {
  const config = readFileSync('tailwind.config.ts', 'utf8');
  const importPath = /import\s+colorsJson\s+from\s+["'](.+?)["']/.exec(config)?.[1];
  if (!importPath) throw new Error('tailwind.config.ts no longer imports a colour manifest');
  const resolved = importPath.replace(/^\.\//, '');
  return { path: resolved, keys: Object.keys(JSON.parse(readFileSync(resolved, 'utf8'))) };
}

/** Declared custom properties, split by the two blocks that must stay in step. */
function declaredVariables(css: string) {
  const p3Start = css.indexOf('@supports');
  const srgb = css.slice(0, p3Start);
  const p3 = css.slice(p3Start);
  const names = (block: string) => [...block.matchAll(/^\s*--([a-z0-9-]+):/gim)].map((m) => m[1]);
  return { srgb: names(srgb), p3: names(p3) };
}

/**
 * Custom properties that belong to the shadcn semantic layer in
 * `styles/main.css` (HSL triplets consumed as `hsl(var(--x))`) or to stock
 * Tailwind, and therefore have no manifest key by design.
 */
const NOT_MANIFEST_KEYS = ['white', 'black', 'foreground', 'foreground-dimmer'];

/** Prefixes owned by the manifest. A utility naming one of these must resolve. */
const TOKEN_FAMILIES = [
  'heat-',
  'accent-',
  'black-alpha-',
  'white-alpha-',
  'illustrations-',
  'border-',
  'background-',
];

/**
 * `theme.extend.colors` in tailwind.config.ts also declares the shadcn semantic
 * scale, whose `accent.foreground` key collides with the manifest's `accent-*`
 * family. It is a real utility backed by `styles/main.css`, not a manifest token.
 */
const SHADCN_SEMANTIC = ['accent-foreground'];

const UTILITY_PREFIXES =
  'bg|text|border|fill|stroke|ring|from|to|via|outline|divide|decoration|caret|shadow|placeholder';

function sourceFiles() {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|tsx)$/.test(name)) out.push(path);
    }
  };
  walk('components');
  walk('app');
  return out;
}

describe('design-system colour tokens', () => {
  const manifest = loadManifest();
  const css = readFileSync(CSS_PATH, 'utf8');
  const declared = declaredVariables(css);

  it('every manifest key has a CSS declaration in both the sRGB and display-p3 blocks', () => {
    const missingSrgb = manifest.keys.filter((key) => !declared.srgb.includes(key));
    const missingP3 = manifest.keys.filter((key) => !declared.p3.includes(key));
    expect({ missingSrgb, missingP3 }).toEqual({ missingSrgb: [], missingP3: [] });
  });

  it('every declared token has a manifest key, so a Tailwind utility exists for it', () => {
    const orphans = declared.srgb.filter(
      (name) => !NOT_MANIFEST_KEYS.includes(name) && !manifest.keys.includes(name),
    );
    expect(orphans).toEqual([]);
  });

  it('the two CSS blocks declare the same manifest tokens', () => {
    // `foreground` / `foreground-dimmer` are deliberately excluded: they are
    // declared only in the sRGB block, and `--foreground` additionally collides
    // with the shadcn HSL triplet in styles/main.css (unlayered here vs
    // `@layer base` there, so this file wins and `hsl(var(--foreground))` is
    // invalid). That is a separate defect, reported, not covered here.
    const manifestOnly = (names: string[]) =>
      names.filter((name) => !NOT_MANIFEST_KEYS.includes(name)).sort();
    expect(manifestOnly(declared.p3)).toEqual(manifestOnly(declared.srgb));
  });

  it('no source file names a colour utility outside the manifest', () => {
    const pattern = new RegExp(`\\b(?:${UTILITY_PREFIXES})-([a-z]+(?:-[a-z0-9]+)+)\\b`, 'g');
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      for (const match of readFileSync(file, 'utf8').matchAll(pattern)) {
        const token = match[1];
        if (SHADCN_SEMANTIC.includes(token)) continue;
        if (!TOKEN_FAMILIES.some((family) => token.startsWith(family))) continue;
        if (manifest.keys.includes(token)) continue;
        offenders.push(`${file}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no source file reads an undeclared design-system CSS variable', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      for (const match of readFileSync(file, 'utf8').matchAll(/var\(--([a-z0-9-]+)\)/g)) {
        const name = match[1];
        if (!TOKEN_FAMILIES.some((family) => name.startsWith(family))) continue;
        if (declared.srgb.includes(name)) continue;
        offenders.push(`${file}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
