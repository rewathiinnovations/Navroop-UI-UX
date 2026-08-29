import type { DirectionTokens } from '@/lib/design/directions';

/**
 * Merge an industry palette into a design direction's structural tokens.
 *
 * ## Why this exists
 *
 * Two blocks used to describe the palette, both marked mandatory, and they
 * disagreed. `toPromptBlock` said "Off-white #FAFAF9, ink #111111, one accent
 * #2563EB. Do not invent a different palette", while the UI/UX PRO MAX brief
 * said "Primary #1C1917, Accent #A16207, Background #FAFAF9" for the same run.
 * A generated dental clinic came out gold on cream with a Playfair heading while
 * its stored `designDirection` was `minimal` — the direction lost silently and
 * nothing in the pipeline noticed.
 *
 * The split now is: **the direction owns form** (type pairing, spacing, radius,
 * depth, tone) and **the palette owns colour**. This module is where the two
 * meet, so exactly one set of numbers reaches the model, and it reaches it as a
 * ready-to-paste `:root` block rather than as prose the model has to translate.
 *
 * Everything here is pure and dependency-free. It runs inside the generation
 * route and inside `lib/projects/plan.ts`, and the only import is a type.
 */

/** The subset of a palette this needs. Mirrors the UI/UX brief's ColorProfile. */
export type PaletteInput = {
  mode: 'light' | 'dark';
  primary: string;
  background: string;
  foreground: string;
};

type Hsl = { h: number; s: number; l: number };

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

/**
 * `#RGB` and `#RRGGBB`, with or without the hash. Anything else returns null so
 * the caller can fall back to the direction's own token rather than emitting a
 * variable of `NaN`, which renders as transparent instead of as an error.
 */
export function hexToHsl(hex: string): Hsl | null {
  const raw = (hex || '').trim().replace(/^#/, '');
  const full =
    raw.length === 3
      ? raw
          .split('')
          .map((char) => char + char)
          .join('')
      : raw;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;

  const r = parseInt(full.slice(0, 2), 16) / 255;
  const g = parseInt(full.slice(2, 4), 16) / 255;
  const b = parseInt(full.slice(4, 6), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const delta = max - min;

  if (delta === 0) return { h: 0, s: 0, l: l * 100 };

  const s = delta / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = ((g - b) / delta) % 6;
  else if (max === g) h = (b - r) / delta + 2;
  else h = (r - g) / delta + 4;
  h = h * 60;
  if (h < 0) h += 360;

  return { h, s: s * 100, l: l * 100 };
}

/** The `H S% L%` form Tailwind reads through `hsl(var(--x) / <alpha-value>)`. */
export function formatTriplet(hsl: Hsl): string {
  return `${Math.round(hsl.h)} ${Math.round(hsl.s)}% ${Math.round(hsl.l)}%`;
}

function lighten(hsl: Hsl, amount: number): Hsl {
  return { ...hsl, l: clamp(hsl.l + amount, 0, 100) };
}

/** Move `from` toward `to` by `ratio` in lightness only, keeping the hue story. */
function towards(from: Hsl, to: Hsl, ratio: number): Hsl {
  return { ...from, l: clamp(from.l + (to.l - from.l) * ratio, 0, 100) };
}

/**
 * Black or white text on a given surface, by the WCAG relative-luminance rule of
 * thumb. Returned as a triplet because that is what every variable here is.
 *
 * The invisible-button class of bug is what this is for: a CTA whose foreground
 * was chosen by vibe rather than by contrast. `--primary-foreground` is now
 * derived, so it cannot disagree with `--primary`.
 */
export function readableForeground(hsl: Hsl): string {
  return hsl.l >= 60 ? '0 0% 8%' : '0 0% 100%';
}

/**
 * The project's real tokens: the direction's radius and shadow, the palette's
 * colour, and surfaces derived from the palette background so a card can never
 * be a pure-white rectangle on a dark page (or the reverse).
 *
 * `directionTokens` is the fallback for every field the palette cannot supply,
 * and for the whole result if the palette's hexes do not parse.
 */
export function resolveProjectTokens(
  directionTokens: DirectionTokens,
  palette: PaletteInput,
): DirectionTokens {
  const background = hexToHsl(palette.background);
  const foreground = hexToHsl(palette.foreground);
  const primary = hexToHsl(palette.primary);
  if (!background || !foreground || !primary) return directionTokens;

  const isDark = palette.mode === 'dark';
  // A card is a step away from the page, in the direction that reads as "raised"
  // for the surface it sits on: brighter on a dark page, whiter on a light one.
  const surface = isDark ? lighten(background, 6) : lighten(background, 100 - background.l);
  const surfaceAlt = isDark ? lighten(background, 3) : lighten(background, -3);
  const border = isDark ? lighten(background, 14) : lighten(background, -10);

  return {
    background: formatTriplet(background),
    surface: formatTriplet(surface),
    surfaceAlt: formatTriplet(surfaceAlt),
    foreground: formatTriplet(foreground),
    // 40% of the way to the background: readable, clearly secondary, and it can
    // never invert on a dark palette the way a fixed grey does.
    mutedForeground: formatTriplet(towards(foreground, background, 0.4)),
    primary: formatTriplet(primary),
    primaryGlow: formatTriplet(lighten(primary, isDark ? 14 : 13)),
    primaryForeground: readableForeground(primary),
    border: formatTriplet(border),
    // Mostly background with the primary's hue showing through: a third surface
    // that alternates visibly against `surfaceAlt` without introducing a colour
    // the palette never named.
    accent: formatTriplet(towards(background, primary, 0.12)),
    // Form and voice belong to the direction, and only to the direction. A
    // palette says what the colours are; it has no opinion about the typeface.
    radius: directionTokens.radius,
    fontDisplay: directionTokens.fontDisplay,
    fontBody: directionTokens.fontBody,
    shadow: directionTokens.shadow,
  };
}
