import { describe, expect, it } from 'vitest';
import { DESIGN_DIRECTIONS, renderTokenCss } from '@/lib/design/directions';
import {
  renderTailwindConfigExpression,
  tailwindThemeVariables,
} from '@/lib/design/tailwind-theme';

/**
 * The two holes that made six design directions look like two.
 *
 * `renderTokenCss` used to map `secondary`, `muted` *and* `accent` all onto
 * `surfaceAlt`, so alternating `bg-muted` with `bg-accent` — the exact thing the
 * `flat-rhythm` advisory asks for — produced no visible alternation at all. A
 * model that tries the supported route, sees nothing happen, and reaches for
 * `bg-slate-100` instead is behaving reasonably; `raw-color` then reports it.
 *
 * The second hole was typography: `fontPairing` named Fraunces, Playfair and IBM
 * Plex in prose and asked the model to import them, but no token declared a
 * family, so a skipped import left every direction in the same default sans.
 */

const DIRECTIONS = Object.values(DESIGN_DIRECTIONS);

function tokenValue(css: string, name: string): string | undefined {
  return new RegExp(`--${name}: ([^;]+);`).exec(css)?.[1];
}

describe('surfaces a page can actually alternate between', () => {
  it('gives every direction a distinct accent, secondary and card surface', () => {
    for (const direction of DIRECTIONS) {
      const css = renderTokenCss(direction.tokens);
      const surfaces = [
        tokenValue(css, 'card'),
        tokenValue(css, 'secondary'),
        tokenValue(css, 'accent'),
      ];
      expect(new Set(surfaces).size, `${direction.id} repeats a surface value`).toBe(3);
    }
  });

  it('keeps the accent inside the direction, not beside it', () => {
    // Same hue family as the primary: a third surface has to belong to the
    // palette, or it is the raw colour this token exists to prevent.
    for (const direction of DIRECTIONS) {
      const css = renderTokenCss(direction.tokens);
      const accentHue = Number(tokenValue(css, 'accent')?.split(' ')[0]);
      const primaryHue = Number(tokenValue(css, 'primary')?.split(' ')[0]);
      const distance = Math.min(
        Math.abs(accentHue - primaryHue),
        360 - Math.abs(accentHue - primaryHue),
      );
      expect(distance, `${direction.id} accent hue is unrelated to its primary`).toBeLessThan(25);
    }
  });
});

describe('typography is a token, not a sentence', () => {
  it('declares a display and a body family for every direction', () => {
    for (const direction of DIRECTIONS) {
      const css = renderTokenCss(direction.tokens);
      expect(tokenValue(css, 'font-display'), direction.id).toBeTruthy();
      expect(tokenValue(css, 'font-body'), direction.id).toBeTruthy();
    }
  });

  it('ends every stack in a real generic, so a skipped webfont still reads right', () => {
    for (const direction of DIRECTIONS) {
      for (const stack of [direction.tokens.fontDisplay, direction.tokens.fontBody]) {
        expect(stack, `${direction.id}: ${stack}`).toMatch(/(sans-serif|serif|monospace)$/);
      }
    }
  });

  it('quotes family names with double quotes, because the config is single-quoted JS', () => {
    // A stack carrying `'Inter'` lands inside `'var(--font-body, …)'` in
    // tailwind.config.js and takes the whole config out with a SyntaxError —
    // which reads in the frame as "Tailwind never loaded", not as a bad token.
    for (const direction of DIRECTIONS) {
      for (const stack of [direction.tokens.fontDisplay, direction.tokens.fontBody]) {
        expect(stack).not.toContain("'");
      }
    }
  });

  it('names the direction its own family before any fallback', () => {
    const first = (stack: string) => stack.split(',')[0].replace(/"/g, '').trim();
    expect(first(DESIGN_DIRECTIONS.editorial.tokens.fontDisplay)).toBe('Playfair Display');
    expect(first(DESIGN_DIRECTIONS.premium.tokens.fontDisplay)).toBe('Fraunces');
    expect(first(DESIGN_DIRECTIONS.technical.tokens.fontBody)).toBe('IBM Plex Sans');
    expect(first(DESIGN_DIRECTIONS.playful.tokens.fontBody)).toBe('Nunito Sans');
  });
});

describe('the theme reads what the stylesheet writes', () => {
  it('exposes the families as font-sans and font-display', () => {
    const config = renderTailwindConfigExpression();
    expect(config).toContain('--font-body');
    expect(config).toContain('--font-display');
  });

  it('produces a parseable config, quotes and all', () => {
    // The guard that would have caught the single-quote defect at its source.
    expect(() => new Function(`return ${renderTailwindConfigExpression()};`)()).not.toThrow();
  });

  it('declares every variable the theme reads, for every direction', () => {
    for (const direction of DIRECTIONS) {
      const css = renderTokenCss(direction.tokens);
      for (const name of tailwindThemeVariables()) {
        expect(css, `${direction.id} is missing --${name}`).toContain(`--${name}:`);
      }
    }
  });
});
