import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, posix, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * F-769: `design-system/MASTER.md` — the single source of truth a designer or an
 * agent reads before touching product chrome — opened with "Keep the existing
 * Firecrawl heat/orange brand (`#FA4500`)", while
 * `.cursor/rules/navroop-product.mdc` requires branding the product as Navroop.
 * Two authorities disagreed and the design doc won for whoever read it first.
 * Beside it the repo shipped a Firecrawl wordmark SVG (with a 🔥 emoji in a
 * `<text>` element and a camelCase `fontSize` attribute that is not valid SVG)
 * and a WebP served at `/firecrawl-logo` with no file extension at all, so its
 * content type was whatever the server guessed.
 *
 * The hex in that rule was not even the token: `--heat-100` is `#fa5d19`.
 */

const ROOT = resolve(import.meta.dirname, '..', '..');

/** Every product-chrome authority that a reader could take as definitive. */
const CHROME_AUTHORITIES = [
  'design-system/MASTER.md',
  '.cursor/rules/brand-theme.mdc',
  '.cursor/rules/navroop-product.mdc',
];

function publicFiles(dir = 'public', out: string[] = []): string[] {
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = posix.join(dir, entry.name);
    if (entry.isDirectory()) {
      // User uploads and vendored preview bundles are not ours to police.
      if (entry.name === 'uploads' || entry.name === 'preview-vendor') continue;
      publicFiles(rel, out);
      continue;
    }
    out.push(rel);
  }
  return out;
}

describe('product chrome names one brand', () => {
  /**
   * A negated mention is the correct kind — `navroop-product.mdc` says "brand the
   * product as Navroop, **not** Firecrawl or Lovable". What must not exist is an
   * instruction to keep, retain or preserve that branding, which is what
   * MASTER.md carried.
   */
  it('no chrome authority instructs a reader to keep Firecrawl branding', () => {
    const offenders: string[] = [];
    for (const file of CHROME_AUTHORITIES) {
      if (!existsSync(join(ROOT, file))) continue;
      const text = readFileSync(join(ROOT, file), 'utf8');
      for (const hit of text.matchAll(
        /\b(keep|retain|preserve|reuse|match)\b[^.\n]{0,60}firecrawl/gi,
      )) {
        offenders.push(`${file}: ${hit[0].slice(0, 60)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the design system points at the heat token rather than a bare hex', () => {
    const master = readFileSync(join(ROOT, 'design-system/MASTER.md'), 'utf8');
    expect(master).toMatch(/--heat-/);
    // The token's real value, so a reader who copies the hex copies the right one.
    const css = readFileSync(join(ROOT, 'styles/design-system/colors.css'), 'utf8');
    const heat = /--heat-100:\s*(#[0-9a-f]{6})/i.exec(css)?.[1];
    expect(heat).toBe('#fa5d19');
    expect(master).toContain(heat as string);
  });
});

describe('nothing Firecrawl-branded ships in public/', () => {
  const files = publicFiles();

  it('walks a non-empty tree, so an empty result is not a broken walk', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('serves no Firecrawl asset', () => {
    expect(files.filter((file) => /firecrawl/i.test(file))).toEqual([]);
  });

  it('serves no extensionless file, whose content type the server has to guess', () => {
    expect(files.filter((file) => extname(file) === '')).toEqual([]);
  });

  it('ships no SVG that renders an emoji or uses a camelCase presentation attribute', () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (extname(file) !== '.svg') continue;
      if (!statSync(join(ROOT, file)).isFile()) continue;
      const svg = readFileSync(join(ROOT, file), 'utf8');
      // Emoji in chrome is banned outright by design-system/MASTER.md; a
      // camelCase attribute is silently ignored by every SVG renderer.
      if (/\p{Extended_Pictographic}/u.test(svg)) offenders.push(`${file}: emoji`);
      if (/\s(fontSize|strokeWidth|fillOpacity|textAnchor)=/.test(svg)) {
        offenders.push(`${file}: camelCase attribute`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
