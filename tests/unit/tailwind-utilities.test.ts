import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import postcss from 'postcss';
import tailwind from 'tailwindcss';
import { beforeAll, describe, expect, it } from 'vitest';

import config from '../../tailwind.config';

/**
 * Two silent-failure shapes in `tailwind.config.ts`.
 *
 * F-835: five of the seven `content` globs named directories that are not in the
 * tree (`pages/`, `components-new/`, three under `styling-reference/`). Tailwind
 * ignores a glob that matches nothing, so the config advertised a pages router
 * and a vendored styling reference the project does not have, and every reader
 * had to go check. Worse, re-creating any of those directories for an unrelated
 * reason would silently pull it into the class scan.
 *
 * F-836: `cw`/`ch`/`cs` centre an element by halving its own size
 * (`left: calc(50% - <size/2>px)`), so they are only meaningful for a pixel
 * length. They were registered with the whole `sizes` scale, which also contains
 * `max-content`, `unset`, `100%`, `inherit` and the n/6 fractions. `parseInt`
 * turned those into `NaN` (dropping the `left` declaration while `width` still
 * applied — an element that sizes but does not centre) or read `"50%"` as 50px.
 * A half-broken class is worse than no class, so the numeric subset plus
 * `type: ['length']` is the fix.
 */

const ROOT = resolve(import.meta.dirname, '..', '..');

const PROBE = 'cw-686 cw-full cw-1/2 cw-max cw-[1110px] ch-470 cs-10 mw-100 cmw-100';

let css = '';

function rule(selector: string): string | null {
  // Escape the class the way Tailwind emits it, then slice the declaration block.
  const escaped = `.${selector.replace(/([/[\]])/g, '\\$1')}`;
  const at = css.indexOf(`${escaped} {`);
  if (at < 0) return null;
  return css.slice(at, css.indexOf('}', at) + 1).replace(/\s+/g, ' ');
}

beforeAll(async () => {
  const result = await postcss([
    tailwind({ ...config, content: [{ raw: PROBE, extension: 'html' }] }),
  ]).process('@tailwind utilities;', { from: undefined });
  css = result.css;
}, 60_000);

describe('tailwind content globs', () => {
  it('names only directories that exist', () => {
    const globs = config.content as string[];
    expect(Array.isArray(globs)).toBe(true);
    const missing = globs.filter((glob) => {
      const dir = /^\.\/([^*]+?)\/\*\*/.exec(glob)?.[1];
      return dir ? !existsSync(resolve(ROOT, dir)) : false;
    });
    expect(missing).toEqual([]);
  });

  it('still scans the two trees that hold every className in the app', () => {
    expect(config.content).toContain('./components/**/*.{js,ts,jsx,tsx,mdx}');
    expect(config.content).toContain('./app/**/*.{js,ts,jsx,tsx,mdx}');
  });
});

describe('centring utilities', () => {
  it('centre correctly for the pixel values the app actually uses', () => {
    expect(rule('cw-686')).toBe('.cw-686 { width: 686px; left: calc(50% - 343px) }');
    expect(rule('ch-470')).toBe('.ch-470 { height: 470px; top: calc(50% - 235px) }');
    expect(rule('cs-10')).toBe(
      '.cs-10 { width: 10px; height: 10px; left: calc(50% - 5px); top: calc(50% - 5px) }',
    );
  });

  it('accepts an arbitrary length, which components rely on', () => {
    expect(rule('cw-[1110px]')).toBe('.cw-\\[1110px\\] { width: 1110px; left: calc(50% - 555px) }');
  });

  it('emits nothing at all for a non-length value rather than a half-broken rule', () => {
    // Previously: `.cw-full { width: 100%; left: calc(50% - NaNpx) }` — the invalid
    // declaration is dropped by the browser and the element silently does not centre.
    for (const cls of ['cw-full', 'cw-max', 'cw-1/2']) {
      expect(rule(cls), `${cls} should not be generated`).toBeNull();
    }
    expect(css).not.toContain('NaN');
  });

  it('does not register the unused mw/cmw utilities', () => {
    expect(rule('mw-100')).toBeNull();
    expect(rule('cmw-100')).toBeNull();
  });
});
