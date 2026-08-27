import {
  DEFAULT_DESIGN_DIRECTION,
  getDirectionTokens,
  renderTokenCss,
} from '@/lib/design/directions';

/**
 * The Tailwind theme extension that turns the CSS variables `renderTokenCss`
 * declares (lib/design/directions.ts) into utility classes.
 *
 * Three consumers need this same object and would otherwise each carry a copy:
 * the NEXTJS scaffold's `tailwind.config.js` (CommonJS), the REACT scaffold's
 * (ESM, because that package is `type: module`), and the inline
 * `tailwind.config = …` the preview frame's Play CDN reads. A name present in
 * two of the three still fails silently: `bg-primary` then resolves through the
 * fallback below instead of through the stylesheet, so the site paints the
 * default direction's colour rather than its own and nothing reports an error.
 * The fallback is a floor under a missing token block, not a licence to let the
 * three drift.
 *
 * So the colour names are generated from one list, in the same two groups
 * shadcn/ui uses: flat colours, and `{ DEFAULT, foreground }` pairs.
 * `tests/unit/starter-kit-renders.test.ts` asserts every `--x` the stylesheet
 * declares is reachable from here.
 */

/** Tokens that map to a single Tailwind colour. */
const FLAT_COLORS = ['border', 'input', 'ring', 'background', 'foreground'] as const;

/** Tokens that map to a `{ DEFAULT, foreground }` pair. */
const PAIRED_COLORS = [
  'primary',
  'secondary',
  'destructive',
  'muted',
  'accent',
  'popover',
  'card',
] as const;

/**
 * What each `--x` resolves to when the project's stylesheet declares none.
 *
 * Read out of the default direction's own token block rather than restated, so
 * a renamed, added or dropped variable cannot leave a stale fallback behind:
 * one list decides the names in `renderTokenCss`, and this reads that list.
 *
 * `getDirectionTokens`, never `getDirection(...).tokens`. This module is on the
 * `'use client'` graph — `lib/preview/deps.ts` imports it for
 * `renderTailwindConfigExpression`, and `BrowserPreview.tsx` reaches that — and
 * the second form's value edge is to `DESIGN_DIRECTIONS`, which also holds all
 * six directions' `signature`, `colorGuidance` and `avoidTraps`. Tree shaking
 * works on bindings, not properties, so one property access here re-links every
 * word of model instruction into the preview bundle. `lib/stacks/templates/index.ts`
 * carries the same warning; this const was quietly undoing it.
 */
const FALLBACK_TOKEN_VALUES: ReadonlyMap<string, string> = new Map(
  [
    ...renderTokenCss(getDirectionTokens(DEFAULT_DESIGN_DIRECTION)).matchAll(
      /--([\w-]+):([^;]+);/g,
    ),
  ].map((match) => [match[1], match[2].trim()] as const),
);

/**
 * A token with no fallback would emit `hsl(var(--card, ) / 1)` — invalid, and
 * dropped by the browser, which is precisely the silent failure the fallback
 * exists to end. There is nothing sensible to return here, so this throws: the
 * only way to reach it is for the theme's colour list and `renderTokenCss` to
 * disagree about a name, which `tests/unit/starter-kit-renders.test.ts` already
 * fails on, and a loud module-load error beats another invisible palette.
 */
function fallbackFor(token: string): string {
  const value = FALLBACK_TOKEN_VALUES.get(token);
  if (!value) {
    throw new Error(`No fallback value for --${token} — the token block declares no such variable`);
  }
  return value;
}

function renderColors(indent: string): string {
  const lines: string[] = [];
  // `<alpha-value>` is what makes `bg-primary/90` work: Tailwind substitutes
  // the modifier, or `1` when there is none. A bare `hsl(var(--primary))`
  // silently drops every opacity modifier, and shadcn's own component sources
  // use them throughout.
  //
  // The `var()` fallback is what keeps a project generated before the token
  // block from losing its colours the first time it is edited. Those projects
  // store their own `app/globals.css` / `src/index.css` in `lastCode`, which
  // correctly wins over the starter one (lib/stacks/starter.ts, and the same
  // ordering in lib/deploy/repo-files.ts), so none of these twenty variables is
  // ever declared for them — while BASE_RULES now *requires* `bg-card`,
  // `border-border` and the rest on follow-ups as well as first builds. Without
  // a fallback the very next edit compiles `bg-card` to
  // `background-color: hsl(var(--card) / 1)`, which substitutes to `hsl( / 1)`
  // — invalid at computed-value time, so the browser drops the declaration and
  // the section renders transparent and unbordered in the preview, the served
  // build, the exported repo and the published site, with nothing thrown, no
  // failed build check (it compiles JS, not CSS) and no finding recorded. It is
  // the `--radius` failure below, in colour.
  //
  // The values are the default direction's, not stock Tailwind's: `card`,
  // `muted` and `ring` are shadcn names that stock Tailwind has no colour for,
  // so there is no "what it had" to restore the way `0.5rem` restores
  // `rounded-lg`. A legacy project therefore degrades to the palette a project
  // with no direction chosen already gets, which reads as an ordinary light
  // site rather than as a hole. It is a floor, not a fix: the real repair is
  // the token block reaching that project's stylesheet, and the moment it does
  // every one of these fallbacks stops being consulted.
  const value = (token: string) => `'hsl(var(--${token}, ${fallbackFor(token)}) / <alpha-value>)'`;
  for (const token of FLAT_COLORS) {
    lines.push(`${indent}${token}: ${value(token)},`);
  }
  for (const token of PAIRED_COLORS) {
    lines.push(`${indent}${token}: {`);
    lines.push(`${indent}  DEFAULT: ${value(token)},`);
    lines.push(`${indent}  foreground: ${value(`${token}-foreground`)},`);
    lines.push(`${indent}},`);
  }
  return lines.join('\n');
}

/**
 * The `theme` value as JavaScript source, indented to sit at `baseIndent`.
 *
 * `container` is top-level rather than inside `extend` deliberately: it
 * replaces Tailwind's default container instead of merging with it, which is
 * what gives every generated page one predictable page gutter.
 */
export function renderTailwindTheme(baseIndent = '  '): string {
  const i = (depth: number) => baseIndent + '  '.repeat(depth);
  return [
    `${baseIndent}theme: {`,
    `${i(1)}container: {`,
    `${i(2)}center: true,`,
    `${i(2)}padding: '1rem',`,
    `${i(2)}screens: { '2xl': '1280px' },`,
    `${i(1)}},`,
    `${i(1)}extend: {`,
    `${i(2)}colors: {`,
    renderColors(i(3)),
    `${i(2)}},`,
    `${i(2)}borderRadius: {`,
    // The fallback is what keeps a project that predates the token block
    // rendering. Those projects ship their own global stylesheet, which
    // correctly wins over the starter one, so they define no `--radius` — and
    // without a fallback `rounded-lg` becomes `var(--radius)` with nothing
    // behind it, an invalid declaration the browser drops. Every existing
    // project silently lost its corner radius that way, which a live check in
    // the preview frame is what caught. 0.5rem is stock Tailwind's own `lg`, so
    // a legacy project keeps what it had.
    //
    // The colours carry the same fallback for the same reason — see
    // `renderColors`. They stopped being exempt when BASE_RULES went from
    // banning the semantic classes to requiring them, which put `bg-card` and
    // `border-border` into edits of projects whose stylesheet declares neither.
    // Their fallback is the default direction's palette rather than a stock
    // Tailwind value, because stock Tailwind has no `card` or `ring` colour.
    `${i(3)}lg: 'var(--radius, 0.5rem)',`,
    `${i(3)}md: 'calc(var(--radius, 0.5rem) - 2px)',`,
    `${i(3)}sm: 'calc(var(--radius, 0.5rem) - 4px)',`,
    `${i(2)}},`,
    `${i(2)}backgroundImage: {`,
    // `bg-gradient-primary` / `bg-gradient-subtle`. The values are whole
    // gradients in the stylesheet, so nothing is composed here.
    //
    // Fallbacks for the same reason as the colours and `--radius` above, and
    // this is the third time that defect has shipped from this file. A project
    // that predates the token block ships its own global stylesheet, which
    // correctly wins over the starter one, so it declares no `--gradient-primary`
    // — and a bare `var(--gradient-primary)` is an invalid declaration the
    // browser drops. A hero told by BASE_RULES to use `bg-gradient-primary` then
    // renders with no background at all, in the preview, the served build, the
    // exported repo and the published site, with nothing thrown and no failed
    // check (the build check compiles JS, not CSS).
    `${i(3)}'gradient-primary': 'var(--gradient-primary, ${fallbackFor('gradient-primary')})',`,
    `${i(3)}'gradient-subtle': 'var(--gradient-subtle, ${fallbackFor('gradient-subtle')})',`,
    `${i(2)}},`,
    `${i(2)}boxShadow: {`,
    // A direction whose shadow is `none` makes `shadow-elegant` a no-op, which
    // is the correct outcome for the three that say "no shadows, 1px borders".
    // The fallback carries that same `none` for a legacy project, so
    // `shadow-elegant` degrades to no shadow rather than to a dropped
    // declaration.
    `${i(3)}elegant: 'var(--shadow-elegant, ${fallbackFor('shadow-elegant')})',`,
    `${i(3)}glow: 'var(--shadow-glow, ${fallbackFor('shadow-glow')})',`,
    `${i(2)}},`,
    // Motion is theme-only, with no CSS variable behind it: `base-rules`
    // already fixes the range at 150-250ms, and a variable would be a second
    // place for that number to live. 200ms sits inside the rule.
    `${i(2)}transitionTimingFunction: {`,
    `${i(3)}smooth: 'cubic-bezier(0.4, 0, 0.2, 1)',`,
    `${i(2)}},`,
    `${i(2)}transitionDuration: {`,
    `${i(3)}smooth: '200ms',`,
    `${i(2)}},`,
    `${i(1)}},`,
    `${baseIndent}},`,
  ].join('\n');
}

/**
 * A whole `tailwind.config.js` body as source.
 *
 * `darkMode: 'class'` is set but no `.dark` token block ships: a generated
 * project may add one on request, and shipping unrequested dark values would
 * double the palette this has to keep correct.
 */
export function renderTailwindConfigBody(contentGlobs: readonly string[]): string {
  return [
    `  darkMode: 'class',`,
    `  content: [`,
    ...contentGlobs.map((glob) => `    '${glob}',`),
    `  ],`,
    renderTailwindTheme(),
    `  plugins: [],`,
  ].join('\n');
}

/**
 * The same object as a single expression, for the preview frame's
 * `tailwind.config = …` assignment. No `content` globs: the Play CDN scans the
 * live DOM rather than files on disk.
 */
export function renderTailwindConfigExpression(): string {
  return ['{', `  darkMode: 'class',`, renderTailwindTheme(), '}'].join('\n');
}

/**
 * Every CSS variable this theme reads, for the drift check.
 *
 * The gradient and shadow names are in here for the same reason the colours
 * are: they are consumed through `backgroundImage` / `boxShadow`, so a name the
 * stylesheet stops declaring turns `bg-gradient-primary` into a no-op rather
 * than into an error.
 */
export function tailwindThemeVariables(): string[] {
  return [
    ...FLAT_COLORS,
    ...PAIRED_COLORS,
    ...PAIRED_COLORS.map((token) => `${token}-foreground`),
    'radius',
    'gradient-primary',
    'gradient-subtle',
    'shadow-elegant',
    'shadow-glow',
  ];
}

/**
 * Just the colour names, which are the ones mapped through `hsl(var(--x, …) /
 * <alpha-value>)` and so the ones a fallback applies to.
 *
 * Exported because the fallback checks used to iterate
 * {@link tailwindThemeVariables} and skip `radius` by name, which quietly
 * assumed every other variable was a colour. `--gradient-primary` and
 * `--shadow-elegant` are whole CSS values, not triplets, so that assumption
 * broke the moment depth tokens existed. One list, no guessing.
 */
export function themeColorTokens(): string[] {
  return [
    ...FLAT_COLORS,
    ...PAIRED_COLORS,
    ...PAIRED_COLORS.map((token) => `${token}-foreground`),
  ];
}
