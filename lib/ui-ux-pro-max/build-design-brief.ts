import {
  getDirectionTokens,
  renderTokenCss,
  resolveDirectionId,
  type DesignDirectionId,
  type DirectionTokens,
} from '@/lib/design/directions';
import { resolveProjectTokens } from '@/lib/design/palette-tokens';
import {
  STYLE_PROFILES,
  TYPEFACE_PROFILES,
  LANDING_PROFILES,
  type StyleProfile as VendoredStyle,
  type TypeProfile as VendoredType,
  type LandingProfile as VendoredLanding,
} from './profiles';

type ColorProfile = {
  name: string;
  /**
   * Mood and adjacent words. Worth a normal hit.
   *
   * These used to be the only list, and that is how "a premium dental clinic"
   * got the Luxury palette: `premium` (Luxury) and `clinic` (Healthcare) both
   * scored 2, the tie was broken by array position, and Luxury is declared
   * first. An adjective outranked the industry the site is actually in.
   */
  keywords: string[];
  /**
   * The nouns that name the industry outright. Worth three times a mood word, so
   * "clinic" beats "premium" and the direction — which is where a mood word
   * belongs — is what carries "premium" into the design.
   */
  industry: string[];
  mode: 'light' | 'dark';
  primary: string;
  accent: string;
  background: string;
  foreground: string;
  notes: string;
  /**
   * Domain tags for this palette, matched against a style's `avoid:` prose so a
   * style that declares itself wrong for the sector is excluded outright rather
   * than merely outscored. Glassmorphism's own row says it is wrong for
   * "serious/medical" — and it shipped a dental clinic anyway.
   */
  tags: string[];
};

type StyleProfile = VendoredStyle & {
  aliases: string[];
};

type TypeProfile = VendoredType;
type LandingProfile = VendoredLanding;

/**
 * The vendored pool is the full skill breadth (49 General website styles, 74
 * typefaces, 34 landing patterns). Only `General`-type styles are landing-page
 * candidates — the `BI/Analytics`, `Landing Page` and `Mobile` rows are either
 * dashboard-specific or an explicitly narrower sub-variant ("Neumorphism (Mobile)"),
 * and offering a dashboard look for a marketing site or a mobile variant for a
 * desktop build is a worse match than the closest general style.
 */
const STYLES: StyleProfile[] = STYLE_PROFILES.filter((style) => style.type === 'General').map(
  (style) => ({
    ...style,
    aliases: [style.name.toLowerCase(), ...style.keywords.map((keyword) => keyword.toLowerCase())],
  }),
);

const TYPEFACES: TypeProfile[] = TYPEFACE_PROFILES;
const LANDINGS: LandingProfile[] = LANDING_PROFILES;

/**
 * The color palettes remain a curated, industry-keyed table rather than being
 * derived from the skill CSVs: the CSVs carry primary/secondary *hexes per style*
 * and product color hints, but not a separate profile whose `mode + primary +
 * accent + surfaces` all agree. Ten curated industries give a stable, tested
 * color story; style expansion and typography breadth are where the vendored data
 * lifts quality, and those are already sourced from it.
 *
 * `products.csv` is left out for the same kind of reason. Its rows recommend a
 * style, a landing pattern and a colour focus per product type — the same three
 * slots the keyword scorer below already fills, with the design direction breaking
 * ties. Vendoring it a second time would give the brief two selectors for one slot
 * and no rule for which wins, which is why the generated `PRODUCT_PROFILES` export
 * sat unimported for its whole life. A product-type selector is a real feature; it
 * arrives with the code that resolves that conflict, not before it.
 */
const COLORS: ColorProfile[] = [
  {
    name: 'SaaS',
    keywords: ['software', 'b2b', 'tool', 'workspace', 'subscription'],
    industry: ['saas', 'platform', 'dashboard', 'crm', 'api'],
    mode: 'light',
    primary: '#2563EB',
    accent: '#EA580C',
    background: '#F8FAFC',
    foreground: '#1E293B',
    notes: 'Trust blue on a cool near-white',
    tags: ['saas', 'corporate', 'data'],
  },
  {
    name: 'E-commerce',
    keywords: ['product', 'cart', 'checkout', 'catalog', 'brand'],
    industry: ['shop', 'store', 'ecommerce', 'boutique', 'marketplace'],
    mode: 'light',
    primary: '#059669',
    accent: '#EA580C',
    background: '#ECFDF5',
    foreground: '#064E3B',
    notes: 'Confident green, high-contrast CTA',
    tags: ['ecommerce', 'retail'],
  },
  {
    name: 'Luxury',
    keywords: ['luxury', 'premium', 'bespoke', 'exclusive', 'couture', 'upscale'],
    industry: ['fashion', 'spa', 'hotel', 'resort', 'jewellery', 'jewelry', 'salon'],
    mode: 'light',
    primary: '#1C1917',
    accent: '#A16207',
    background: '#FAFAF9',
    foreground: '#0C0A09',
    notes: 'Stone and near-black, gold reserved for one accent',
    tags: ['luxury', 'hospitality'],
  },
  {
    name: 'Healthcare',
    keywords: ['health', 'wellness', 'patient', 'care', 'treatment', 'therapy'],
    industry: [
      'clinic',
      'medical',
      'hospital',
      'dental',
      'dentist',
      'doctor',
      'physiotherapy',
      'pharmacy',
      'diagnostic',
      'veterinary',
    ],
    mode: 'light',
    primary: '#0891B2',
    accent: '#059669',
    background: '#ECFEFF',
    foreground: '#164E63',
    notes: 'Calm clinical cyan, nothing that reads as a hard sell',
    tags: ['medical', 'serious', 'accessibility'],
  },
  {
    name: 'Creative',
    keywords: ['creative', 'design', 'brand', 'art', 'director'],
    industry: ['agency', 'studio', 'portfolio', 'illustrator', 'photographer'],
    mode: 'light',
    primary: '#EC4899',
    accent: '#0891B2',
    background: '#FDF2F8',
    foreground: '#831843',
    notes: 'Expressive pink, used sparingly against near-white',
    tags: ['creative', 'portfolio'],
  },
  {
    name: 'Fintech',
    keywords: ['finance', 'trading', 'invest', 'portfolio value', 'ledger'],
    industry: ['bank', 'banking', 'fintech', 'crypto', 'insurance', 'accounting'],
    mode: 'dark',
    primary: '#0F172A',
    accent: '#22C55E',
    background: '#020617',
    foreground: '#F8FAFC',
    notes: 'Dark navy, green reserved for positive figures only',
    tags: ['finance', 'serious', 'data', 'corporate'],
  },
  {
    name: 'Education',
    keywords: ['learn', 'course', 'student', 'curriculum', 'tuition'],
    industry: ['school', 'education', 'academy', 'college', 'university', 'coaching'],
    mode: 'light',
    primary: '#4F46E5',
    accent: '#EA580C',
    background: '#EEF2FF',
    foreground: '#1E1B4B',
    notes: 'Indigo, warm and legible at long reading lengths',
    tags: ['education', 'accessibility'],
  },
  {
    name: 'Restaurant',
    keywords: ['food', 'menu', 'kitchen', 'dining', 'chef', 'tasting'],
    industry: ['restaurant', 'cafe', 'bakery', 'bistro', 'catering', 'brewery'],
    mode: 'light',
    primary: '#C2410C',
    accent: '#CA8A04',
    background: '#FFF7ED',
    foreground: '#431407',
    notes: 'Warm terracotta on cream',
    tags: ['food', 'hospitality'],
  },
  {
    name: 'Real Estate',
    keywords: ['property', 'listing', 'architect', 'interior', 'apartment'],
    industry: ['real estate', 'realty', 'builder', 'developer property', 'brokerage'],
    mode: 'light',
    primary: '#1E3A8A',
    accent: '#D97706',
    background: '#F8FAFC',
    foreground: '#1E3A8A',
    notes: 'Navy with an amber highlight',
    tags: ['realestate', 'corporate'],
  },
  {
    name: 'Gaming',
    keywords: ['game', 'stream', 'clan', 'tournament', 'arcade'],
    industry: ['esport', 'esports', 'gaming', 'games studio'],
    mode: 'dark',
    primary: '#7C3AED',
    accent: '#F43F5E',
    background: '#0F0F23',
    foreground: '#E2E8F0',
    notes: 'Neon violet on near-black',
    tags: ['gaming', 'entertainment'],
  },
];

/**
 * Domain tag -> the words a style's `avoid:` prose uses for it.
 *
 * The vendored profiles already carry an honest `avoid` line per style; nothing
 * read it. Matching it against the selected palette's tags turns that prose into
 * an exclusion, which is the difference between "Glassmorphism scored highest"
 * and "Glassmorphism says it is wrong for medical, so it is not a candidate".
 */
const AVOID_TERMS: Record<string, string[]> = {
  medical: ['medical', 'healthcare', 'health care', 'clinical'],
  serious: ['serious', 'data-critical', 'critical accessibility', 'conservative'],
  finance: ['finance', 'financial', 'accounting', 'legal'],
  corporate: ['corporate', 'professional services', 'enterprise'],
  accessibility: ['critical accessibility', 'accessible public services', 'elderly'],
  data: ['data grids', 'data-critical', 'data-heavy'],
  education: ["children's apps"],
  entertainment: ['entertainment'],
};

/**
 * The style each design direction resolves to when the prompt carries no style
 * keyword of its own. These names exist in the vendored `General` pool.
 */
const STYLE_FOR_DIRECTION: Record<DesignDirectionId, string> = {
  minimal: 'Minimalism & Swiss Style',
  bold: 'Brutalism',
  premium: 'Glassmorphism',
  playful: 'Neumorphism',
  editorial: 'Editorial Grid / Magazine',
  technical: 'Flat Design',
};

const DEFAULT_COLOR = 'SaaS';
const DEFAULT_TYPEFACE = 'Minimal Swiss';
const DEFAULT_LANDING = 'Hero-Centric Design';

/**
 * Surfaces used when the scored palette's mode contradicts the style. The hues
 * (primary, accent, notes) of the scored palette are kept — they carry the
 * industry signal — and only the background/foreground pair is replaced, so
 * "luxury" still means stone and gold when the style demands a dark surface.
 */
const SURFACES = {
  light: { background: '#F8FAFC', foreground: '#0F172A' },
  dark: { background: '#0A0E17', foreground: '#F8FAFC' },
} as const;

/**
 * The hard UX quality bar, distilled from the skill's ux-guidelines and the
 * curated rules the old brief carried. These are non-negotiable output rules,
 * not suggestions — they are what separate "looks like a template" from a
 * finished product.
 *
 * This prose is the whole bar, and it is deliberately not derived from the
 * vendored pool. `scripts/generate-ui-ux-profiles.ts` used to also emit the 99
 * `ux-guidelines.csv` rows as a `UX_RULES: UxRule[]` export — same name, never
 * imported, and rendering them would put 99 category/issue/do/don't records into
 * every creation prompt in place of these eleven lines. Two exports named
 * `UX_RULES`, one of them dead, is how a later reader concludes the brief prints
 * the CSV rows; only one now exists, and it is this one.
 */
const UX_RULES = `
- Use Lucide or Heroicons only. Never use emoji as icons.
- cursor-pointer on every clickable control. Hover/focus in 150-300ms (opacity/color/transform, never width/height/top).
- Touch targets >= 44px. Visible :focus-visible rings. Labels on every input.
- Text contrast >= 4.5:1 (7:1 preferred). Do not rely on color alone.
- Respect prefers-reduced-motion. Max 1-2 motion moments per view.
- Mobile-first: 375 / 768 / 1024 / 1440. Sticky nav must not cover content (compensate padding).
- Smooth scroll. Active nav state. Skeleton/spinner for async work.
- Use the project's semantic token classes (bg-background, text-foreground, bg-primary, text-primary-foreground, bg-card, text-muted-foreground, border-border): the global stylesheet defines them as CSS variables from the color system above, and the Tailwind config maps them. Never a raw colour (text-white, bg-black, bg-gray-900), never an arbitrary hex (bg-[#2563EB]), never style={{}}. A colour the tokens do not cover goes into the token block in the global stylesheet first.
- Depth and gradients are tokens: bg-gradient-primary, bg-gradient-subtle, shadow-elegant, shadow-glow, ease-smooth, duration-smooth. Never hand-write a linear-gradient or a box-shadow in a component.
- A primitive that needs a new look gets a cva variant in its own components/ui file, used by name. Never override one with a stack of ad-hoc classes at the call site, and remember a shadcn outline variant is transparent, so light text on it disappears.
- Import Google Fonts in index.html or index.css. Apply heading/body fonts consistently.
- Real content, not lorem. Distinct visual hierarchy. One primary CTA per section.
`.trim();

/**
 * Word-boundary keyword scoring. The previous implementation used
 * `text.includes(keyword)`, so "hair" matched `'ai'` and "homepage" matched
 * `'home'` — fonts and palettes were assigned from letter coincidences (F-830).
 * A multi-word keyword scores proportionally to its length: "real estate" is a
 * far more specific signal than "agency", and the two used to tie.
 */
function scoreKeywords(tokens: readonly string[], text: string, keywords: readonly string[]) {
  let score = 0;
  for (const keyword of keywords) {
    const words = keyword.split(' ');
    if (words.length === 1) {
      if (tokens.includes(keyword)) score += 2;
    } else if (text.includes(` ${keyword} `)) {
      score += 2 * words.length;
    }
  }
  return score;
}

function topScoring<T extends { keywords: string[] }>(
  items: readonly T[],
  tokens: readonly string[],
  text: string,
  weigh: (item: T) => number = () => 0,
) {
  let best = 0;
  const winners: T[] = [];
  for (const item of items) {
    const score = scoreKeywords(tokens, text, item.keywords) + weigh(item);
    if (score > best) {
      best = score;
      winners.length = 0;
    }
    if (score === best) winners.push(item);
  }
  return { winners, score: best };
}

/**
 * An industry noun is worth three ordinary keyword hits.
 *
 * "a premium dental clinic" used to resolve to the Luxury palette: `premium`
 * and `clinic` both scored 2 and Luxury is declared first in the array. The
 * industry the site is in is not a tie with an adjective about how it should
 * feel — the adjective is what the design *direction* is for.
 */
function weighIndustry(tokens: readonly string[], text: string) {
  return (palette: ColorProfile) => scoreKeywords(tokens, text, palette.industry) * 3;
}

function pickByName<T extends { name: string }>(items: readonly T[], name: string) {
  const found = items.find((item) => item.name === name);
  if (!found) throw new Error(`build-design-brief: no profile named ${name}`);
  return found;
}

function pickScored<T extends { name: string; keywords: string[] }>(
  items: readonly T[],
  tokens: readonly string[],
  text: string,
  defaultName: string,
  weigh?: (item: T) => number,
) {
  const { winners, score } = topScoring(items, tokens, text, weigh);
  return score === 0 ? pickByName(items, defaultName) : winners[0];
}

/**
 * Styles whose own `avoid:` prose rules them out for this palette's sector.
 *
 * Returns the full pool when the filter would empty it: a brief with no style is
 * worse than a style the data mildly disapproves of, and an empty candidate list
 * is the one outcome that would make generation fail outright.
 */
function compatibleStyles(palette: ColorProfile) {
  const terms = palette.tags.flatMap((tag) => AVOID_TERMS[tag] ?? []);
  if (terms.length === 0) return STYLES;
  const survivors = STYLES.filter((style) => {
    const avoid = style.avoid.toLowerCase();
    return !terms.some((term) => avoid.includes(term));
  });
  return survivors.length > 0 ? survivors : STYLES;
}

function pickStyle(
  tokens: readonly string[],
  text: string,
  styleHint: string | undefined,
  direction: DesignDirectionId,
  palette: ColorProfile,
) {
  const hint = (styleHint || '').toLowerCase().trim();
  if (hint) {
    const exact = STYLES.find(
      (style) =>
        style.aliases.includes(hint) ||
        style.name.toLowerCase() === hint ||
        style.name.toLowerCase().includes(hint) ||
        hint.includes(style.name.toLowerCase()),
    );
    // The user named a style outright; that beats both the picker and the prompt.
    if (exact) return exact;
  }

  // The sector filter runs before anything is scored, so a style the data
  // declares wrong for this industry can never win on keyword count.
  const pool = compatibleStyles(palette);
  const directionStyle = pickByName(STYLES, STYLE_FOR_DIRECTION[direction]);
  const preferred = pool.includes(directionStyle) ? directionStyle : pool[0];
  const { winners, score } = topScoring(pool, tokens, text);
  if (score === 0) return preferred;
  // Keyword hits refine the direction; the direction breaks their ties.
  return winners.includes(preferred) ? preferred : winners[0];
}

export type UiUxProfiles = {
  /** The direction the palette and style were reconciled against. */
  direction: DesignDirectionId;
  style: StyleProfile;
  colors: ColorProfile;
  type: TypeProfile;
  landing: LandingProfile;
  /**
   * The project's real CSS variables: the direction's radius and depth, the
   * palette's colour. One set of numbers, so the DESIGN DIRECTION block and this
   * brief cannot describe two different sites.
   */
  tokens: DirectionTokens;
};

/**
 * Exported so the selection can be asserted directly: parsing the rendered brief
 * cannot see the light/dark reconciliation that F-831 is about.
 */
export function selectUiUxProfiles(input: {
  prompt: string;
  styleHint?: string;
  designDirection?: string | null;
}): UiUxProfiles {
  const words = `${input.styleHint || ''} ${input.prompt || ''}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  const text = ` ${words} `;
  const tokens = words.split(' ').filter(Boolean);
  const direction = resolveDirectionId(input.designDirection);

  // The palette is chosen first, because it carries the sector and the sector is
  // what decides which styles are even candidates. Choosing the style first is
  // how a medical site got a style whose own row says "avoid: serious/medical".
  const scored = pickScored(COLORS, tokens, text, DEFAULT_COLOR, weighIndustry(tokens, text));
  const style = pickStyle(tokens, text, input.styleHint, direction, scored);
  // A light style with a dark palette (or the reverse) puts two backgrounds and a
  // card rule that fights both into one "MANDATORY" block (F-831).
  const colors: ColorProfile =
    style.surface === 'either' || style.surface === scored.mode
      ? scored
      : { ...scored, mode: style.surface, ...SURFACES[style.surface] };

  return {
    direction,
    style,
    colors,
    type: pickScored(TYPEFACES, tokens, text, DEFAULT_TYPEFACE),
    landing: pickScored(LANDINGS, tokens, text, DEFAULT_LANDING),
    tokens: resolveProjectTokens(getDirectionTokens(direction), colors),
  };
}

/**
 * The styleHint is the echo the *next* call can use to keep the design stable
 * across a follow-up edit. It is returned separately from the rendered brief so
 * a caller that did not pass a hint — a first build — learns which style was
 * chosen from the prompt alone and can carry it forward.
 */
export type UiUxBriefResult = { brief: string; styleHint: string };

export function buildUiUxProMaxBrief(input: {
  prompt: string;
  styleHint?: string;
  designDirection?: string | null;
  isEdit?: boolean;
}): UiUxBriefResult {
  const { style, colors, landing, tokens } = selectUiUxProfiles(input);

  // The chosen style is the contract for later turns. Emitting it here means a
  // follow-up edit (where the user did not name a style again) re-selects the same
  // one instead of re-falling through to a direction default or keyword tie.
  const styleHint = style.name;

  if (input.isEdit) {
    // An edit keeps the established design — but "preserve design" must still name
    // the system it is preserving, or a long session drifts. styleHint carries the
    // chosen style; if a previous turn stored it, echo it back explicitly.
    const preserved = input.styleHint
      ? `- Preserve the selected visual system: ${input.styleHint}\n`
      : '';
    return {
      styleHint,
      brief: `
## UI/UX PRO MAX (PRESERVE DESIGN)
Keep the established visual system. Do not restyle the whole app.
${preserved}- Preserve colors, type, radius, and spacing already in the files
- Only change what the user asked
- Still follow: Lucide/Heroicons (no emoji icons), 44px targets, 150-300ms hovers, 4.5:1 contrast, standard Tailwind classes
`.trim(),
    };
  }

  const cards =
    colors.mode === 'dark'
      ? `Cards: a 6-10% white tint over ${colors.background} with a 1px rgba(255,255,255,0.12) border. Never a pure white card.`
      : `Cards: white or a 6-8% tint of ${colors.background}, clear 1px border`;

  const brief = `
## UI/UX PRO MAX DESIGN SYSTEM (MANDATORY FOR THIS CREATION)
This brief is generated at creation time from the user's request. It is the source of truth for the design: follow it exactly, and do not substitute a generic framework default when the brief names a specific choice.

### Style: ${style.name}
${style.prompt}
Tokens: ${style.tokens}
Do not: ${style.avoid}
Best for: ${style.bestFor}
Accessibility: ${style.accessibility}
Mobile-friendly: ${style.mobile}

### Color system: ${colors.name}
- Primary: ${colors.primary}
- Background: ${colors.background}
- Foreground: ${colors.foreground}
- ${cards}
Notes: ${colors.notes}
These hex values belong in the project's token block in the global stylesheet, as the CSS variables the semantic classes read. Do not write them as arbitrary-value classes (bg-[#2563EB]) in components. Keep CTA contrast high.
This is a ${colors.mode} interface: every surface, card, and text color derives from the background above.

### Token block (write these values, exactly, into the :root of the global stylesheet)
The colours below are this palette; the radius and the shadow are the design direction's. This is the only palette in this prompt — the DESIGN DIRECTION block above describes type, spacing, radius and depth, and defers colour to here. Copy the block verbatim; do not round, re-derive, or "improve" a value.
\`\`\`css
:root {
${renderTokenCss(tokens)}
}
\`\`\`
Every colour a component needs is one of these variables through its semantic class (bg-background, text-foreground, bg-primary, text-primary-foreground, bg-card, text-muted-foreground, border-border). --primary-foreground is already the readable pair for --primary: never override a CTA's text colour by hand.

### Typography
The DESIGN DIRECTION block above names the type pairing. Use it, load those Google Fonts once in the root layout, and do not substitute another pairing here.

### Page structure: ${landing.name}
${landing.sections}
CTA: ${landing.cta}

### UX quality bar
${UX_RULES}

### Implementation checklist
- Header + nav, hero, 3-5 content sections, footer
- Every page named in the plan is a real route with real content. A nav link must never point at a route that does not exist, and never at "#" as a placeholder.
- Shared header and footer live in one component each and are used by every page, so navigation is consistent everywhere.
- Responsive grid, consistent 8px spacing rhythm
- Hover, focus, and disabled states on interactive elements
- No placeholder grey boxes where real UI should exist
`.trim();

  return { brief, styleHint };
}
