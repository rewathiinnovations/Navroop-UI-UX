export const DESIGN_DIRECTION_IDS = [
  'minimal',
  'bold',
  'premium',
  'playful',
  'editorial',
  'technical',
] as const;

export type DesignDirectionId = (typeof DESIGN_DIRECTION_IDS)[number];

export const DEFAULT_DESIGN_DIRECTION: DesignDirectionId = 'minimal';

/**
 * The values every generated project's CSS variables are written from.
 *
 * The colour fields are HSL triplets with no `hsl()` wrapper, so Tailwind's
 * opacity modifiers work through `hsl(var(--x) / <alpha-value>)`. A direction's
 * `colorGuidance` prose above is the same palette in words and must not
 * disagree with these numbers.
 *
 * `primaryGlow` and `shadow` exist so depth and gradients are part of the
 * design system rather than written ad hoc in a component. A generated page
 * that wants a rich hero reaches for `bg-gradient-primary` or `shadow-elegant`;
 * without these it reaches for an inline style or an arbitrary value, which is
 * exactly what the token rules forbid.
 */
export type DirectionTokens = {
  background: string;
  surface: string;
  surfaceAlt: string;
  foreground: string;
  mutedForeground: string;
  primary: string;
  /** A lighter primary, same hue. The far end of `--gradient-primary` and the glow colour. */
  primaryGlow: string;
  primaryForeground: string;
  border: string;
  radius: string;
  /**
   * A complete CSS `box-shadow` value, or `none`.
   *
   * Per-direction rather than derived, because depth is where the directions
   * genuinely disagree: `bold` is a hard offset with no blur, `premium` is
   * layered and soft, and `minimal`, `editorial` and `technical` all say "no
   * shadows, 1px borders" — for those the honest value is `none`, and a
   * `shadow-elegant` that does nothing is the correct outcome.
   */
  shadow: string;
};

export type DesignDirection = {
  id: DesignDirectionId;
  label: string;
  fontPairing: string;
  radiusScale: string;
  spacingScale: string;
  shadowStyle: string;
  colorGuidance: string;
  toneWords: string[];
  /**
   * The one memorable element to build around. Every direction spends its
   * boldness here and stays quiet elsewhere (frontend-design: "spend your
   * boldness in one place. Let the signature element be the one memorable
   * thing, keep everything around it quiet and disciplined.").
   */
  signature: string;
  /**
   * What this direction must NOT drift into. Anti-slop guardrails so the
   * output stays on-brief rather than collapsing to a templated default.
   */
  avoidTraps: string[];
  /**
   * The machine-readable half of `colorGuidance`: the exact values the
   * project's CSS variables are written from, so the semantic Tailwind classes
   * the prompt now requires resolve to this direction's palette.
   */
  tokens: DirectionTokens;
};

/**
 * Shared bottom-line interface rules, distilled from the referenced skills:
 * Vercel web-interface guidelines (keyboard, focus, hit targets, motion),
 * emilkowal's animation discipline, taste-skill's anti-slop rules, and
 * perception-first's 5-layer hierarchy. Appended to every direction so the
 * quality floor is never optional.
 *
 * The literal starts at the first character and ends at the last on purpose.
 * This was a template literal that opened with a newline and closed with
 * `.trim()`, and a module-scope call is a side effect: no bundler may prove it
 * returns nothing observable, so the binding was pinned live even where nothing
 * read it. `lib/preview/assemble.ts` reaches this module through the starter kit
 * for `renderTokenCss`, and `components/workspace/BrowserPreview.tsx` is a
 * `'use client'` file that calls `assemblePreview` — so all 2,020 characters of
 * model instructions were downloaded and parsed by every visitor to a project
 * page, at byte 115 of the minified bundle, with no code path reading them. A
 * plain literal is droppable, and `tests/unit/preview-client-graph.test.ts`
 * bundles the real entry and fails if this text comes back.
 */
export const INTERFACE_QUALITY_BAR = `INTERFACE QUALITY FLOOR (do not drop any of these)
- Keyboard operates every flow. Focus is visible via :focus-visible; grouped controls use :focus-within. Never let a sticky header/banner cover the focused element.
- Hit targets >= 44px on touch (Vercel: expand <24px visual targets). Inputs are >= 16px on mobile so iOS Safari does not autozoom.
- Motion: honor prefers-reduced-motion. Prefer CSS (compositor-friendly transform/opacity) over JS. Never 'transition: all' - list properties explicitly. Set a correct transform-origin and let input interrupt any animation. Only animate what explains cause/effect or adds deliberate delight, not decoration.
- No placeholders, no fake div-based screenshots, no hand-rolled SVG illustrations where a real image belongs. 'Bento grid: N items equals N cells'.
- Typography: import the named Google Fonts once in the root layout. Tight heading tracking; readable body 16px+, line-height 1.5-1.7. Use tabular numbers (font-variant-numeric: tabular-nums) for any column of figures. Prefer curly quotes. Avoid widows/orphans.
- Contrast >= 4.5:1 (7:1 preferred). Never convey meaning by color alone - pair it with text or an icon label. Status gets a text label.
- Iconography: Lucide or Heroicons only. Never emoji as icons. An icon that conveys meaning has a text label for non-sighted users.
- Spacing: consistent 8px rhythm, deliberate alignment (every element aligns to a grid, baseline, edge, or optical centre). Match visual and hit targets.
- No dead zones: if part of a control looks interactive, it is. A link is an <a>/<Link>, never a button/div.
- One primary CTA per view. Hero headline max 2 lines; subtext max 20 words; the CTA is visible without scrolling. Nav max 80px tall, one line at desktop.
- Zero em-dashes (U+2014) or en-dashes (U+2013) anywhere. Hyphen only.
- Real content, never lorem. Sentence case copy in the interface's own voice; plain verbs; every element does exactly one job.
- Empty, sparse, dense and error states are designed, not defaulted.`;

/**
 * One binding per palette, so a caller that wants numbers does not drag the
 * prose along.
 *
 * Tree shaking works on bindings, not on object properties. While every token
 * block lived inside `DESIGN_DIRECTIONS` the only way to read nine HSL triplets
 * was to reach the record that also holds `fontPairing`, `colorGuidance`,
 * `signature` and `avoidTraps` for all six directions — model instructions, in a
 * record no bundler can partially retain. That is how "Minimal is precision, not
 * absence" reached the browser: `lib/preview/assemble.ts` is on the `'use client'`
 * graph of `components/workspace/BrowserPreview.tsx`, and it needs exactly the
 * numbers. `getDirectionTokens` below is the tokens-only door; `getDirection`
 * stays for the callers that read the brief itself.
 *
 * Six named consts rather than the nested record they are collected into below,
 * because both records have to name them by *identifier*. `tokens:
 * DIRECTION_TOKENS.minimal` inside `DESIGN_DIRECTIONS` is a property access, and
 * a property access can run a getter, so esbuild will not treat the initializer
 * as pure and emits the whole record even with nothing referencing it — measured:
 * the direction prose stayed in the preview bundle until these became plain
 * identifier references. Neither record restates a value, so the palette a
 * project previews in cannot drift from the one it exports with.
 */
const MINIMAL_TOKENS: DirectionTokens = {
  background: '60 9% 98%',
  surface: '0 0% 100%',
  surfaceAlt: '60 5% 96%',
  foreground: '0 0% 7%',
  mutedForeground: '0 0% 40%',
  primary: '221 83% 53%',
  primaryForeground: '0 0% 100%',
  primaryGlow: '221 83% 66%',
  border: '220 13% 91%',
  radius: '0.375rem',
  // "None. 1px borders only. Depth via spacing, not shadows."
  shadow: 'none',
};

const BOLD_TOKENS: DirectionTokens = {
  background: '0 0% 100%',
  surface: '0 0% 100%',
  surfaceAlt: '0 0% 96%',
  foreground: '0 0% 4%',
  mutedForeground: '0 0% 32%',
  primary: '0 84% 60%',
  primaryForeground: '0 0% 100%',
  primaryGlow: '0 84% 72%',
  border: '0 0% 7%',
  radius: '0rem',
  // "Hard offset 4px 4px 0 #111111. No blur. Flat, assertive."
  shadow: '4px 4px 0 hsl(var(--foreground))',
};

const PREMIUM_TOKENS: DirectionTokens = {
  background: '39 44% 94%',
  surface: '40 33% 97%',
  surfaceAlt: '39 30% 90%',
  foreground: '240 15% 5%',
  mutedForeground: '240 6% 35%',
  primary: '41 47% 56%',
  primaryForeground: '240 15% 5%',
  primaryGlow: '41 60% 70%',
  border: '39 24% 84%',
  radius: '1rem',
  // "Layered depth: 0 1px 2px rgba(0,0,0,0.06), 0 8px 24px rgba(0,0,0,0.08)."
  shadow: '0 1px 2px hsl(var(--foreground) / 0.06), 0 8px 24px hsl(var(--foreground) / 0.08)',
};

const PLAYFUL_TOKENS: DirectionTokens = {
  background: '204 100% 97%',
  surface: '0 0% 100%',
  surfaceAlt: '204 60% 93%',
  foreground: '244 47% 20%',
  mutedForeground: '244 20% 40%',
  primary: '239 84% 67%',
  primaryForeground: '0 0% 100%',
  primaryGlow: '239 84% 78%',
  border: '210 40% 88%',
  radius: '1.25rem',
  // "Soft colored 0 8px 20px rgba(99,102,241,0.18)."
  shadow: '0 8px 20px hsl(var(--primary) / 0.18)',
};

const EDITORIAL_TOKENS: DirectionTokens = {
  background: '39 39% 93%',
  surface: '40 33% 97%',
  surfaceAlt: '39 26% 88%',
  foreground: '20 14% 10%',
  mutedForeground: '20 8% 35%',
  primary: '342 79% 35%',
  primaryForeground: '0 0% 100%',
  primaryGlow: '342 70% 50%',
  border: '24 6% 83%',
  radius: '0.125rem',
  // "None. 1px hairline rules."
  shadow: 'none',
};

const TECHNICAL_TOKENS: DirectionTokens = {
  background: '210 40% 98%',
  surface: '0 0% 100%',
  surfaceAlt: '210 40% 96%',
  foreground: '222 47% 11%',
  mutedForeground: '215 16% 40%',
  primary: '192 91% 36%',
  primaryForeground: '0 0% 100%',
  primaryGlow: '192 85% 50%',
  border: '213 27% 84%',
  radius: '0.25rem',
  // "None. 1px slate borders. Tabular figures for numbers."
  shadow: 'none',
};

const DIRECTION_TOKENS: Record<DesignDirectionId, DirectionTokens> = {
  minimal: MINIMAL_TOKENS,
  bold: BOLD_TOKENS,
  premium: PREMIUM_TOKENS,
  playful: PLAYFUL_TOKENS,
  editorial: EDITORIAL_TOKENS,
  technical: TECHNICAL_TOKENS,
};

export const DESIGN_DIRECTIONS: Record<DesignDirectionId, DesignDirection> = {
  minimal: {
    id: 'minimal',
    label: 'Minimal',
    fontPairing:
      'Inter 600 display + Inter 400 body. 16px base, 1.25 type ratio (16 / 20 / 25 / 31 / 39). Humanist, quiet, precise.',
    radiusScale: '4px controls, 6px cards, 999px pills.',
    spacingScale: '8 / 16 / 24 / 40 / 64. Section padding 64px desktop, 32px at 375px. Lots of air.',
    shadowStyle: 'None. 1px borders only (border-gray-200). Depth via spacing, not shadows.',
    colorGuidance:
      'Off-white #FAFAF9 background, ink #111111 text, one accent #2563EB. No gradients. Body contrast >= 4.5:1.',
    toneWords: ['spare', 'precise', 'quiet'],
    signature:
      'A single unmistakable focal point - the hero headline, set large in Inter with tight tracking, on generous whitespace. Everything else recedes.',
    avoidTraps: [
      'Do not add decorative cards or gradients to fill space.',
      'Do not use numbered eyebrow labels or pattern-only section markers.',
      'Minimal is precision, not absence: spacing and type detail must be exact.',
    ],
    tokens: MINIMAL_TOKENS,
  },
  bold: {
    id: 'bold',
    label: 'Bold',
    fontPairing:
      'Space Grotesk 700 display + Inter 400 body. 18px base, 1.333 type ratio (18 / 24 / 32 / 43 / 57). Graphic, confident.',
    radiusScale: '0px cards, 2px controls, no pills.',
    spacingScale: '8 / 16 / 32 / 48 / 80. Tight clusters, large section breaks.',
    shadowStyle: 'Hard offset 4px 4px 0 #111111. No blur. Flat, assertive.',
    colorGuidance:
      'White #FFFFFF or black #0A0A0A fields, saturated accent #EF4444 or #2563EB, 3px black borders. No pastels.',
    toneWords: ['loud', 'graphic', 'direct'],
    signature:
      'A giant typographic statement (display type 5-7xl, single line, high contrast) with one hard-offset shadow. The hero is unmistakably loud.',
    avoidTraps: [
      'Loud everywhere: use exactly one loud element; the rest stays disciplined.',
      'Do not let boldness become chaos - scale, alignment and hierarchy still hold.',
    ],
    tokens: BOLD_TOKENS,
  },
  premium: {
    id: 'premium',
    label: 'Premium',
    fontPairing:
      'Fraunces 600 display + Inter 400/500 body. 16px base, 1.25 type ratio (16 / 20 / 25 / 31 / 39). Editorial, layered.',
    radiusScale: '16px cards, 12px controls, 999px pills.',
    spacingScale: '8 / 16 / 24 / 40 / 64. Generous section padding 80px desktop, 40px at 375px.',
    shadowStyle:
      'Layered depth: 0 1px 2px rgba(0,0,0,0.06), 0 8px 24px rgba(0,0,0,0.08). Translucent surfaces bg-white/80 backdrop-blur-md.',
    colorGuidance:
      'Dramatic contrast - near-black #0B0B0F on warm cream #F6F1E8; gold accent #C4A35A. Hero may invert (cream type on #0B0B0F). Surfaces white/10-16% over dark.',
    toneWords: ['cinematic', 'layered', 'refined'],
    signature:
      'An inverted hero (light type on near-black, with a subtle gold accent and a backdrop-blurred card) that reads as a considered, costly choice.',
    avoidTraps: [
      'Do not apply glass to every surface - one layered moment, quiet elsewhere.',
      'Do not add gratuitous animation; any motion should be slow and intentional.',
    ],
    tokens: PREMIUM_TOKENS,
  },
  playful: {
    id: 'playful',
    label: 'Playful',
    fontPairing:
      'Nunito 700 display + Nunito Sans 400 body. 16px base, 1.2 type ratio (16 / 19 / 23 / 28 / 33). Rounded, friendly.',
    radiusScale: '20px cards, 14px controls, 999px pills and buttons.',
    spacingScale: '8 / 16 / 24 / 32 / 48. Airy cards, 24px gaps.',
    shadowStyle: 'Soft colored 0 8px 20px rgba(99,102,241,0.18). Hover lift -2px (transform only).',
    colorGuidance:
      'Sky #F0F9FF background, ink #1E1B4B, accents #6366F1 and #F59E0B. Avoid grey-only palettes.',
    toneWords: ['friendly', 'bouncy', 'warm'],
    signature:
      'One playful interactive moment - a hover lift, a fun empty state, a wobble on a primary button - that makes the page feel human without being noisy.',
    avoidTraps: [
      'Do not animate everything; pick 1-2 moments (emilkowal: less is more).',
      'Do not let cuteness compromise legibility or tap targets.',
    ],
    tokens: PLAYFUL_TOKENS,
  },
  editorial: {
    id: 'editorial',
    label: 'Editorial',
    fontPairing:
      'Playfair Display 600 display + Source Serif 4 400 body. 18px body, 1.333 type ratio, max 65ch measure. Literary, print-like.',
    radiusScale: '2px images, 0px text blocks, 4px buttons.',
    spacingScale: '8 / 16 / 28 / 48 / 72. Print-like column gutters 24px.',
    shadowStyle: 'None. 1px hairline rules (border-stone-300). Optional 1px inset image keyline.',
    colorGuidance:
      'Paper #F4EFE6, ink #1C1917, spot color #9F1239. No neon, no heavy gradients.',
    toneWords: ['literary', 'measured', 'print'],
    signature:
      'A magazine hero: a large serif headline over a wide-rule image with a drop-cap or pull-quote, set in a true print grid.',
    avoidTraps: [
      'Do not use numbered section markers unless the content is genuinely sequential.',
      'Do not convert this to a generic modern SaaS layout - keep the editorial measure and rhythm.',
    ],
    tokens: EDITORIAL_TOKENS,
  },
  technical: {
    id: 'technical',
    label: 'Technical',
    fontPairing:
      'IBM Plex Sans 600 display + IBM Plex Sans 400 body + IBM Plex Mono 400 for code/data. 14px base, 1.2 type ratio. Dense, exact.',
    radiusScale: '4px cards and controls, 2px chips.',
    spacingScale: '4 / 8 / 12 / 20 / 32. Dense dashboard rhythm.',
    shadowStyle: 'None. 1px slate borders (border-slate-300). Tabular figures for numbers.',
    colorGuidance:
      'Slate #F8FAFC background, #0F172A text, signal cyan #0891B2. Status via text + icon, not color alone.',
    toneWords: ['exact', 'tabular', 'utilitarian'],
    signature:
      'A data-first hero: a tabular figure or a live-ish stat cluster in IBM Plex Mono, with the label and unit set clearly. The page reads as precise and credible.',
    avoidTraps: [
      'Do not over-decorate a technical surface - status changes use text + icon, never color alone.',
      'Do not introduce rounded marketing cards that contradict the exact, tabular feel.',
    ],
    tokens: TECHNICAL_TOKENS,
  },
};

export function isDesignDirectionId(value: unknown): value is DesignDirectionId {
  return typeof value === 'string' && (DESIGN_DIRECTION_IDS as readonly string[]).includes(value);
}

export function resolveDirectionId(value: unknown): DesignDirectionId {
  return isDesignDirectionId(value) ? value : DEFAULT_DESIGN_DIRECTION;
}

export function getDirection(id?: string | null): DesignDirection {
  return DESIGN_DIRECTIONS[resolveDirectionId(id)];
}

/**
 * The same lookup, for a caller that only needs the palette.
 *
 * `getDirection(id).tokens` reads the same nine values, but the property access
 * happens at runtime and the value edge is to `DESIGN_DIRECTIONS` — so a caller
 * written that way ships all six directions' model instructions to whatever
 * bundle it lands in, and the browser preview is one of those bundles. Use this
 * one wherever the answer is fed to `renderTokenCss` or a scaffold builder; use
 * `getDirection` only where the prose is genuinely being read, which today means
 * `toPromptBlock` on the server. `tests/unit/preview-client-graph.test.ts`
 * bundles the preview entry and is what notices when that slips.
 */
export function getDirectionTokens(id?: string | null): DirectionTokens {
  return DIRECTION_TOKENS[resolveDirectionId(id)];
}

/** Every direction shares one destructive pair; only the palette varies. */
const DESTRUCTIVE = '0 72% 51%';
const DESTRUCTIVE_FOREGROUND = '0 0% 100%';

/**
 * The `:root` declarations a generated project's global stylesheet carries.
 *
 * One function decides the variable names, because three things have to agree
 * on them or the whole locked stack silently degrades: this stylesheet, the
 * Tailwind theme extension that maps `bg-primary` onto `var(--primary)`, and
 * the inline `tailwind.config` the preview frame gets. A name that exists in
 * two of the three produces a class that compiles to a colour of `hsl()` with
 * nothing in it — which renders as transparent, not as an error.
 *
 * The direction tokens fan out to the shadcn/ui variables: `card` and `popover`
 * are the direction's surface, `secondary` / `muted` / `accent` its alternate
 * surface, `input` its border and `ring` its primary.
 *
 * The gradient and shadow variables are derived here rather than authored per
 * direction, so a gradient cannot disagree with the palette it is built from.
 * They exist because "make this hero look designed" otherwise becomes an inline
 * style or an arbitrary value — the two things the token rules forbid — and a
 * rule that forbids something without offering the alternative is a rule the
 * model routes around.
 */
export function renderTokenCss(tokens: DirectionTokens): string {
  const rows: Array<[string, string]> = [
    ['background', tokens.background],
    ['foreground', tokens.foreground],
    ['card', tokens.surface],
    ['card-foreground', tokens.foreground],
    ['popover', tokens.surface],
    ['popover-foreground', tokens.foreground],
    ['primary', tokens.primary],
    ['primary-foreground', tokens.primaryForeground],
    ['primary-glow', tokens.primaryGlow],
    ['secondary', tokens.surfaceAlt],
    ['secondary-foreground', tokens.foreground],
    ['muted', tokens.surfaceAlt],
    ['muted-foreground', tokens.mutedForeground],
    ['accent', tokens.surfaceAlt],
    ['accent-foreground', tokens.foreground],
    ['destructive', DESTRUCTIVE],
    ['destructive-foreground', DESTRUCTIVE_FOREGROUND],
    ['border', tokens.border],
    ['input', tokens.border],
    ['ring', tokens.primary],
    ['radius', tokens.radius],
    ['gradient-primary', `linear-gradient(135deg, hsl(${tokens.primary}), hsl(${tokens.primaryGlow}))`],
    ['gradient-subtle', `linear-gradient(180deg, hsl(${tokens.background}), hsl(${tokens.surfaceAlt}))`],
    ['shadow-elegant', tokens.shadow],
    // Derived from the glow so it always belongs to the palette. `none` for a
    // direction whose shadow is `none` would be wrong here: a glow is opt-in
    // through `shadow-glow`, so a direction that never uses the class pays
    // nothing, and one that does gets a colour that matches.
    ['shadow-glow', `0 0 40px hsl(${tokens.primaryGlow} / 0.4)`],
  ];
  return rows.map(([name, value]) => `    --${name}: ${value};`).join('\n');
}

/**
 * Concrete, implementable instructions - not mood adjectives. Composes the
 * direction's own spec with the shared interface quality floor so the model
 * has one authoritative block: the visual system AND the non-negotiable
 * quality bar that separates a finished product from a template.
 */
export function toPromptBlock(direction: DesignDirection): string {
  const signature = direction.signature
    ? `\nSignature element (build the page around this, keep everything else quiet):\n${direction.signature}`
    : '';
  const traps =
    direction.avoidTraps.length > 0
      ? `\nAvoid:\n${direction.avoidTraps.map((trap) => `- ${trap}`).join('\n')}`
      : '';
  return `DESIGN DIRECTION - ${direction.id}
Typography: ${direction.fontPairing}
Radius: ${direction.radiusScale}
Spacing: ${direction.spacingScale}
Shadow/depth: ${direction.shadowStyle}
Color: ${direction.colorGuidance}
Tone (keep copy and motion in this register): ${direction.toneWords.join(', ')}.
${signature}
${traps}
Load the named Google Fonts in the root layout/head. Use these exact sizes, radii, and colors (as CSS variables once). Do not swap the type pairing or invent a different palette.${INTERFACE_QUALITY_BAR}`;
}
