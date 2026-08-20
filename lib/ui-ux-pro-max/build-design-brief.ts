import { resolveDirectionId, type DesignDirectionId } from '@/lib/design/directions';

/**
 * Whether a style can sit on a light background, a dark one, or either. Used to
 * reject a style/palette pair that would contradict itself (F-831): the brief is
 * labelled "MANDATORY FOR THIS CREATION", so two incompatible backgrounds in it
 * leave the model to pick one and violate the other.
 */
type Surface = 'light' | 'dark' | 'either';

type StyleProfile = {
  name: string;
  aliases: string[];
  keywords: string[];
  surface: Surface;
  prompt: string;
  tokens: string;
  avoid: string;
};

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

type TypeProfile = {
  name: string;
  keywords: string[];
  heading: string;
  body: string;
  importUrl: string;
};

type LandingProfile = {
  name: string;
  keywords: string[];
  sections: string;
  cta: string;
};

const STYLES: StyleProfile[] = [
  {
    name: 'Glassmorphism',
    aliases: ['1', 'glass', 'frosted'],
    keywords: ['glass', 'frosted', 'blur', 'translucent', 'saas', 'modern'],
    surface: 'either',
    prompt:
      'Frosted glass cards, backdrop-blur 12-20px, translucent overlays (10-30% opacity), subtle 1px light borders, layered depth, vibrant background.',
    tokens: '--blur: 16px; --glass: rgba(255,255,255,0.14); --radius: 16px;',
    avoid:
      'Low-contrast text on glass, heavy blur on every surface, missing fallback without backdrop-filter.',
  },
  {
    name: 'Neumorphism',
    aliases: ['2', 'soft ui', 'embossed'],
    keywords: ['soft', 'wellness', 'health', 'meditation', 'pastel'],
    surface: 'light',
    prompt:
      'Soft 3D surfaces, pastel monochrome, 12-16px radius, dual light/dark shadows, press-in states at 150ms.',
    tokens:
      '--radius: 14px; --shadow-light: -6px -6px 16px rgba(255,255,255,0.7); --shadow-dark: 6px 6px 16px rgba(0,0,0,0.08);',
    avoid: 'Low-contrast text, complex dashboards, tiny controls.',
  },
  {
    name: 'Brutalism',
    aliases: ['3', 'raw', 'anti-design'],
    keywords: ['brutal', 'raw', 'stark', 'editorial', 'bold', 'asymmetric'],
    surface: 'light',
    prompt:
      'Raw high-contrast blocks, 0 radius, visible 2-4px borders, bold type 700+, instant transitions, primary red/blue/yellow + black/white.',
    tokens: '--radius: 0px; --border: 3px solid #000; --weight: 800;',
    avoid: 'Soft shadows, rounded corporate cards, timid greys.',
  },
  {
    name: 'Minimalist',
    aliases: ['4', 'minimal', 'swiss', 'clean'],
    keywords: ['minimal', 'clean', 'simple', 'swiss', 'enterprise', 'docs'],
    surface: 'light',
    prompt:
      'Swiss grid, generous whitespace, geometric sans, high contrast, essential elements only, almost no shadows or gradients.',
    tokens: '--radius: 0px; --space: 2rem; --shadow: none;',
    avoid: 'Decorative blobs, extra cards, cluttered nav.',
  },
  {
    name: 'Dark Mode',
    aliases: ['5', 'oled', 'dark'],
    keywords: ['dark', 'night', 'oled', 'coding', 'cinema', 'premium'],
    surface: 'dark',
    prompt:
      'OLED dark (#000/#121212/#0A0E27), neon accents used sparingly, 7:1 text contrast, minimal glow, no large white surfaces.',
    tokens: '--bg: #0A0E17; --surface: #121826; --text: #F8FAFC; --accent: #38BDF8;',
    avoid: 'Pure white cards, faint grey body text, glow on every element.',
  },
  {
    name: 'Gradient Rich',
    aliases: ['6', 'aurora', 'mesh'],
    keywords: ['gradient', 'aurora', 'colorful', 'vibrant', 'music', 'lifestyle'],
    surface: 'either',
    prompt:
      'Mesh/aurora backgrounds, complementary blends, 8-12s slow motion, high-contrast type over darkened overlays.',
    tokens:
      '--grad: radial-gradient(at 20% 20%, #6366F1, transparent 40%), radial-gradient(at 80% 0%, #F43F5E, transparent 35%);',
    avoid: 'Text sitting on busy gradients without overlay, rainbow overload.',
  },
  {
    name: '3D Depth',
    aliases: ['7', '3d', 'dimensional'],
    keywords: ['3d', 'depth', 'product', 'showcase', 'immersive'],
    surface: 'either',
    prompt:
      'Layered depth, perspective, soft multi-shadows, parallax on 1-2 hero elements only, tactile cards. Prefer CSS 3D over WebGL unless asked.',
    tokens: '--perspective: 1000px; --elev-1: 0 8px 24px rgba(0,0,0,0.12);',
    avoid: 'WebGL on every section, animating layout properties.',
  },
  {
    name: 'Retro Wave',
    aliases: ['8', 'synthwave', 'cyberpunk', 'retro'],
    keywords: ['retro', '80s', 'neon', 'cyber', 'synth', 'game'],
    surface: 'dark',
    prompt:
      'Synthwave/cyber look: deep navy/black, neon pink/cyan, glow text, geometric grids, optional scanlines, monospace accents.',
    tokens: '--bg: #0B0618; --neon: #FF2BD6; --cyan: #22D3EE;',
    avoid: 'Low-contrast neon on neon, endless glitch loops.',
  },
  {
    name: 'Flat Design',
    aliases: ['flat'],
    keywords: ['flat', 'startup', 'saas', 'dashboard', 'mvp'],
    surface: 'light',
    prompt:
      '2D flat UI, 4-6 solid colors, no shadows/gradients, simple shapes, icon-led hierarchy, 150-200ms color/opacity hovers.',
    tokens: '--shadow: none; --radius: 8px;',
    avoid: 'Skeuomorphic textures, heavy glass.',
  },
];

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

const TYPEFACES: TypeProfile[] = [
  {
    name: 'Modern Professional',
    keywords: ['saas', 'business', 'corporate', 'startup'],
    heading: 'Poppins',
    body: 'Open Sans',
    importUrl:
      'https://fonts.googleapis.com/css2?family=Open+Sans:wght@400;600;700&family=Poppins:wght@500;600;700&display=swap',
  },
  {
    name: 'Tech Startup',
    keywords: ['tech', 'ai', 'developer', 'software'],
    heading: 'Space Grotesk',
    body: 'DM Sans',
    importUrl:
      'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&family=Space+Grotesk:wght@500;600;700&display=swap',
  },
  {
    name: 'Classic Elegant',
    keywords: ['luxury', 'fashion', 'spa', 'editorial', 'beauty'],
    heading: 'Playfair Display',
    body: 'Inter',
    importUrl:
      'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Playfair+Display:wght@500;600;700&display=swap',
  },
  {
    name: 'Playful Creative',
    keywords: ['kids', 'play', 'fun', 'game', 'education'],
    heading: 'Fredoka',
    body: 'Nunito',
    importUrl:
      'https://fonts.googleapis.com/css2?family=Fredoka:wght@500;600;700&family=Nunito:wght@400;600;700&display=swap',
  },
  {
    name: 'Minimal Swiss',
    keywords: ['minimal', 'dashboard', 'docs', 'clean'],
    heading: 'Inter',
    body: 'Inter',
    importUrl: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap',
  },
  {
    name: 'Wellness Calm',
    keywords: ['health', 'wellness', 'yoga', 'organic'],
    heading: 'Lora',
    body: 'Raleway',
    importUrl:
      'https://fonts.googleapis.com/css2?family=Lora:wght@500;600;700&family=Raleway:wght@400;500;600&display=swap',
  },
];

const LANDINGS: LandingProfile[] = [
  {
    name: 'Hero + Features + CTA',
    keywords: ['saas', 'startup', 'product', 'tool'],
    sections: '1. Hero 2. Value prop 3. 3-5 features 4. CTA 5. Footer',
    cta: 'Primary CTA in hero and again after features',
  },
  {
    name: 'Social Proof',
    keywords: ['agency', 'service', 'consult', 'clinic'],
    sections: '1. Hero 2. Problem 3. Solution 4. Testimonials 5. CTA',
    cta: 'CTA after 3-5 named testimonials',
  },
  {
    name: 'Menu / Catalog',
    keywords: ['restaurant', 'food', 'shop', 'store', 'menu'],
    sections: '1. Hero 2. Categories 3. Featured items 4. About 5. Contact/CTA',
    cta: 'Reserve / Shop CTA sticky on mobile',
  },
  {
    name: 'Portfolio',
    keywords: ['portfolio', 'studio', 'architect', 'photographer'],
    sections: '1. Name/hero 2. Selected work grid 3. About 4. Contact',
    cta: 'Contact after work, not before',
  },
  {
    name: 'Local Business',
    keywords: ['dentist', 'lawyer', 'salon', 'gym', 'hotel'],
    sections: '1. Hero 2. Services 3. Proof 4. Hours/map 5. Book CTA',
    cta: 'Book/call visible in header and footer',
  },
];

/**
 * The style each design direction resolves to when the prompt carries no style
 * keyword of its own. Before this existed the winner was `STYLES[0]`
 * (Glassmorphism) for any prompt that did not literally name a style — which is
 * most of them — so a bakery and a law firm both got frosted glass while the
 * PromptHero picker said `minimal` (F-829). Two directions may share a style:
 * `editorial` has no dedicated STYLES row and its tokens (no shadows, hairline
 * rules, print gutters) are Minimalist's.
 */
const STYLE_FOR_DIRECTION: Record<DesignDirectionId, string> = {
  minimal: 'Minimalist',
  bold: 'Brutalism',
  premium: 'Glassmorphism',
  playful: 'Neumorphism',
  editorial: 'Minimalist',
  technical: 'Flat Design',
};

/**
 * Defaults for the tables a design direction says nothing about. Named
 * explicitly so "no keyword matched" is a decision rather than array position.
 * The typeface default is Inter, which is what `DEFAULT_DESIGN_DIRECTION`
 * (`minimal`) prescribes — the old fall-through picked Poppins/Open Sans.
 */
const DEFAULT_COLOR = 'SaaS';
const DEFAULT_TYPEFACE = 'Minimal Swiss';
const DEFAULT_LANDING = 'Hero + Features + CTA';

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

const UX_RULES = `
- Use Lucide or Heroicons only. Never use emoji as icons.
- cursor-pointer on every clickable control. Hover/focus in 150-300ms (opacity/color/transform, never width/height/top).
- Touch targets >= 44px. Visible :focus-visible rings. Labels on every input.
- Text contrast >= 4.5:1 (7:1 preferred). Do not rely on color alone.
- Respect prefers-reduced-motion. Max 1-2 motion moments per view.
- Mobile-first: 375 / 768 / 1024 / 1440. Sticky nav must not cover content (compensate padding).
- Smooth scroll. Active nav state. Skeleton/spinner for async work.
- No shadcn semantic token classes (bg-background / text-foreground / bg-primary / border-border): generated projects ship no CSS variables to back them, so they render as nothing. Stock Tailwind (bg-white, text-gray-900, bg-blue-600) and arbitrary-value classes carrying the hex values from the color system above (bg-[#2563EB], text-[#0F172A]) are both correct.
- Import Google Fonts in index.html or index.css. Apply heading/body fonts consistently.
- Real content, not lorem. Distinct visual hierarchy. One primary CTA per section.
`.trim();

/**
 * Word-boundary keyword scoring. The previous implementation used
 * `text.includes(keyword)`, so "hair" matched `'ai'` and "homepage" matched
 * `'home'` — fonts and palettes were assigned from letter coincidences (F-830).
 * A multi-word keyword scores proportionally to its length: "real estate" is a
 * far more specific signal than "agency", and the two used to tie.
 *
 * `text` is space-padded and stripped of punctuation by the caller, so a phrase
 * match on `' real estate '` is a whole-word match.
 */
function scoreKeywords(tokens: readonly string[], text: string, keywords: readonly string[]) {
  let score = 0;
  for (const keyword of keywords) {
    const words = keyword.split(' ');
    const hit = words.length === 1 ? tokens.includes(keyword) : text.includes(` ${keyword} `);
    if (hit) score += 2 * words.length;
  }
  return score;
}

/**
 * Every candidate sharing the top score, in table order, plus that score. The
 * old `pickBest` seeded `-1` and advanced on strict `>`, so it resolved ties
 * silently by array position and reported "nothing matched" as "row 0 matched".
 */
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

/**
 * Scored pick with an explicit, named default: a zero score means "the prompt
 * said nothing about this", which must not be answered with the first row.
 */
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

export function buildUiUxProMaxBrief(input: {
  prompt: string;
  styleHint?: string;
  designDirection?: string | null;
  isEdit?: boolean;
}) {
  if (input.isEdit) {
    return `
## UI/UX PRO MAX (PRESERVE DESIGN)
Keep the established visual system. Do not restyle the whole app.
- Preserve colors, type, radius, and spacing already in the files
- Only change what the user asked
- Still follow: Lucide/Heroicons (no emoji icons), 44px targets, 150-300ms hovers, 4.5:1 contrast, standard Tailwind classes
`.trim();
  }

  const { style, colors, type, landing } = selectUiUxProfiles(input);
  const cards =
    colors.mode === 'dark'
      ? `Cards: a 6-10% white tint over ${colors.background} with a 1px rgba(255,255,255,0.12) border. Never a pure white card.`
      : `Cards: white or a 6-8% tint of ${colors.background}, clear 1px border`;

  return `
## UI/UX PRO MAX DESIGN SYSTEM (MANDATORY FOR THIS CREATION)
This brief is generated at creation time from the user's request. Follow it as the source of truth.

### Style: ${style.name}
${style.prompt}
Tokens: ${style.tokens}
Do not: ${style.avoid}

### Color system: ${colors.name}
- Primary: ${colors.primary}
- Accent / CTA: ${colors.accent}
- Background: ${colors.background}
- Foreground: ${colors.foreground}
- ${cards}
Notes: ${colors.notes}
Use these hex values in Tailwind arbitrary colors when needed (e.g. bg-[#2563EB]). Keep CTA contrast high.
This is a ${colors.mode} interface: every surface, card, and text color derives from the background above.

### Typography: ${type.name}
- Headings: ${type.heading}
- Body: ${type.body}
- Import once: ${type.importUrl}
- Tight heading tracking, readable body 16px+, line-height 1.5-1.7

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
}
