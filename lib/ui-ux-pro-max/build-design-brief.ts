import { resolveDirectionId, type DesignDirectionId } from '@/lib/design/directions';
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
  keywords: string[];
  mode: 'light' | 'dark';
  primary: string;
  accent: string;
  background: string;
  foreground: string;
  notes: string;
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
    aliases: [
      style.name.toLowerCase(),
      ...style.keywords.map((keyword) => keyword.toLowerCase()),
    ],
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
    keywords: ['saas', 'software', 'platform', 'b2b', 'tool'],
    mode: 'light',
    primary: '#2563EB',
    accent: '#EA580C',
    background: '#F8FAFC',
    foreground: '#1E293B',
    notes: 'Trust blue + orange CTA',
  },
  {
    name: 'E-commerce',
    keywords: ['shop', 'store', 'ecommerce', 'product', 'cart'],
    mode: 'light',
    primary: '#059669',
    accent: '#EA580C',
    background: '#ECFDF5',
    foreground: '#064E3B',
    notes: 'Success green + urgency orange',
  },
  {
    name: 'Luxury',
    keywords: ['luxury', 'fashion', 'spa', 'hotel', 'premium', 'beauty'],
    mode: 'light',
    primary: '#1C1917',
    accent: '#A16207',
    background: '#FAFAF9',
    foreground: '#0C0A09',
    notes: 'Stone + gold',
  },
  {
    name: 'Healthcare',
    keywords: ['health', 'clinic', 'medical', 'wellness', 'hospital'],
    mode: 'light',
    primary: '#0891B2',
    accent: '#059669',
    background: '#ECFEFF',
    foreground: '#164E63',
    notes: 'Calm cyan + health green',
  },
  {
    name: 'Creative',
    keywords: ['agency', 'studio', 'creative', 'portfolio', 'design'],
    mode: 'light',
    primary: '#EC4899',
    accent: '#0891B2',
    background: '#FDF2F8',
    foreground: '#831843',
    notes: 'Bold pink + cyan',
  },
  {
    name: 'Fintech',
    keywords: ['bank', 'finance', 'fintech', 'crypto', 'trading'],
    mode: 'dark',
    primary: '#0F172A',
    accent: '#22C55E',
    background: '#020617',
    foreground: '#F8FAFC',
    notes: 'Dark navy + positive green',
  },
  {
    name: 'Education',
    keywords: ['school', 'learn', 'course', 'education', 'kids'],
    mode: 'light',
    primary: '#4F46E5',
    accent: '#EA580C',
    background: '#EEF2FF',
    foreground: '#1E1B4B',
    notes: 'Indigo + energetic orange',
  },
  {
    name: 'Restaurant',
    keywords: ['food', 'restaurant', 'cafe', 'menu', 'kitchen'],
    mode: 'light',
    primary: '#C2410C',
    accent: '#CA8A04',
    background: '#FFF7ED',
    foreground: '#431407',
    notes: 'Warm terracotta',
  },
  {
    name: 'Real Estate',
    keywords: ['real estate', 'property', 'home', 'architect'],
    mode: 'light',
    primary: '#1E3A8A',
    accent: '#D97706',
    background: '#F8FAFC',
    foreground: '#1E3A8A',
    notes: 'Navy + amber',
  },
  {
    name: 'Gaming',
    keywords: ['game', 'esport', 'gaming', 'stream'],
    mode: 'dark',
    primary: '#7C3AED',
    accent: '#F43F5E',
    background: '#0F0F23',
    foreground: '#E2E8F0',
    notes: 'Neon purple + rose',
  },
];

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
) {
  let best = 0;
  const winners: T[] = [];
  for (const item of items) {
    const score = scoreKeywords(tokens, text, item.keywords);
    if (score > best) {
      best = score;
      winners.length = 0;
    }
    if (score === best) winners.push(item);
  }
  return { winners, score: best };
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
) {
  const { winners, score } = topScoring(items, tokens, text);
  return score === 0 ? pickByName(items, defaultName) : winners[0];
}

function pickStyle(
  tokens: readonly string[],
  text: string,
  styleHint: string | undefined,
  direction: DesignDirectionId,
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

  const preferred = pickByName(STYLES, STYLE_FOR_DIRECTION[direction]);
  const { winners, score } = topScoring(STYLES, tokens, text);
  if (score === 0) return preferred;
  // Keyword hits refine the direction; the direction breaks their ties.
  return winners.includes(preferred) ? preferred : winners[0];
}

export type UiUxProfiles = {
  style: StyleProfile;
  colors: ColorProfile;
  type: TypeProfile;
  landing: LandingProfile;
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

  const style = pickStyle(tokens, text, input.styleHint, direction);
  const scored = pickScored(COLORS, tokens, text, DEFAULT_COLOR);
  // A light style with a dark palette (or the reverse) puts two backgrounds and a
  // card rule that fights both into one "MANDATORY" block (F-831).
  const colors: ColorProfile =
    style.surface === 'either' || style.surface === scored.mode
      ? scored
      : { ...scored, mode: style.surface, ...SURFACES[style.surface] };

  return {
    style,
    colors,
    type: pickScored(TYPEFACES, tokens, text, DEFAULT_TYPEFACE),
    landing: pickScored(LANDINGS, tokens, text, DEFAULT_LANDING),
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
  const { style, colors, type, landing } = selectUiUxProfiles(input);

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
- Accent / CTA: ${colors.accent}
- Background: ${colors.background}
- Foreground: ${colors.foreground}
- ${cards}
Notes: ${colors.notes}
These hex values belong in the project's token block in the global stylesheet, as the CSS variables the semantic classes read. Do not write them as arbitrary-value classes (bg-[#2563EB]) in components. Keep CTA contrast high.
This is a ${colors.mode} interface: every surface, card, and text color derives from the background above.

### Typography: ${type.name}
- Headings: ${type.heading}
- Body: ${type.body}
- Import once: ${type.importUrl}
- Tight heading tracking, readable body 16px+, line-height 1.5-1.7
${type.notes ? `- ${type.notes}` : ''}

### Page structure: ${landing.name}
${landing.sections}
CTA: ${landing.cta}

### UX quality bar
${UX_RULES}

### Implementation checklist
- Header + nav, hero, 3-5 content sections, footer
- Responsive grid, consistent 8px spacing rhythm
- Hover, focus, and disabled states on interactive elements
- No placeholder grey boxes where real UI should exist
`.trim();

  return { brief, styleHint };
}
