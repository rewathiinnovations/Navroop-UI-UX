import { DEFAULT_DESIGN_DIRECTION, type DesignDirectionId } from '@/lib/design/directions';

/**
 * Pick a design direction from the user's own words.
 *
 * The direction used to be a dropdown on the prompt hero, defaulted to
 * `minimal`, and almost nobody changed it — so every project entered generation
 * claiming "minimal" while the prompt described a luxury clinic or a data
 * console. Worse, the UI/UX PRO MAX brief scored its own style from the same
 * prompt and disagreed, and the model was handed two blocks both marked
 * mandatory. Removing the control and reading the direction out of the brief is
 * what makes one design system possible: `lib/design/directions.ts` owns colour,
 * type, radius and depth, and nothing downstream contradicts it.
 *
 * Type-only import from `directions.ts` on purpose: this module must not pull
 * `DESIGN_DIRECTIONS` (2 KB of model prose per direction) into any bundle that
 * only needs the id. `DEFAULT_DESIGN_DIRECTION` is a plain string literal, so it
 * is droppable on its own.
 */

/**
 * Keywords are matched on word boundaries against the prompt, never with
 * `includes`. A multi-word phrase scores proportionally to its length, so
 * "fine dining" outranks a bare "dining" and "real estate" is not two weak
 * hits.
 */
type DirectionSignal = {
  id: DesignDirectionId;
  /**
   * Words that name the *feel* the user asked for. These decide outright.
   *
   * A mood word beats an industry word because the industry is already carried
   * elsewhere: `lib/ui-ux-pro-max/build-design-brief.ts` picks the palette from
   * the sector, so "a premium dental clinic" gets the Healthcare palette either
   * way, and "premium" is the only thing in that sentence saying how it should
   * feel. Ranked by `TIE_ORDER` when a prompt names two.
   */
  mood: string[];
  /**
   * What the site is. Used only when the prompt asks for no particular feel, and
   * scored normally, so "dental clinic" outranks a single stray "clean".
   */
  keywords: string[];
};

/**
 * Order matters only as documentation — ties are broken by the explicit
 * `TIE_ORDER` below, never by array position, because array position is how the
 * palette picker used to hand a dental clinic a luxury palette.
 */
const SIGNALS: DirectionSignal[] = [
  {
    id: 'premium',
    mood: [
      'luxury',
      'luxurious',
      'premium',
      'high end',
      'upscale',
      'exclusive',
      'bespoke',
      'elegant',
      'sophisticated',
      'refined',
      'opulent',
      'cinematic',
    ],
    keywords: [
      'boutique',
      'concierge',
      'spa',
      'resort',
      'hotel',
      'villa',
      'jewellery',
      'jewelry',
      'watch',
      'fashion',
      'couture',
      'salon',
      'aesthetic',
      'cosmetic',
      'fine dining',
      'wedding',
      'interior design',
      'private client',
    ],
  },
  {
    id: 'editorial',
    mood: ['editorial', 'magazine style', 'print like', 'literary', 'longform'],
    keywords: [
      'magazine',
      'blog',
      'publication',
      'journal',
      'newsletter',
      'essay',
      'writer',
      'author',
      'book',
      'publisher',
      'photography',
      'photographer',
      'museum',
      'gallery',
      'archive',
      'culture',
      'documentary',
      'news site',
      'storytelling',
    ],
  },
  {
    id: 'technical',
    mood: ['technical', 'data dense', 'utilitarian', 'developer focused', 'dashboard style'],
    keywords: [
      'saas',
      'dashboard',
      'api',
      'developer',
      'developers',
      'devtools',
      'sdk',
      'cli',
      'analytics',
      'observability',
      'monitoring',
      'infrastructure',
      'database',
      'devops',
      'kubernetes',
      'open source',
      'engineering',
      'console',
      'admin panel',
      'metrics',
      'logs',
      'telemetry',
      'data platform',
      'integration',
      'webhook',
    ],
  },
  {
    id: 'playful',
    mood: ['playful', 'quirky', 'fun', 'cheerful', 'friendly', 'whimsical', 'bouncy'],
    keywords: [
      'kids',
      'children',
      'child',
      'toy',
      'toys',
      'nursery',
      'daycare',
      'preschool',
      'kindergarten',
      'playgroup',
      'cartoon',
      'comic',
      'candy',
      'ice cream',
      'bakery',
      'party',
      'birthday',
      'summer camp',
      'pet',
      'pets',
      'puppy',
    ],
  },
  {
    id: 'bold',
    mood: ['bold', 'loud', 'edgy', 'punchy', 'brutalist', 'graphic', 'high impact'],
    keywords: [
      'streetwear',
      'sneaker',
      'sneakers',
      'skate',
      'gym',
      'fitness',
      'crossfit',
      'bootcamp',
      'esports',
      'esport',
      'gaming',
      'festival',
      'nightclub',
      'nightlife',
      'concert',
      'band',
      'record label',
      'energy drink',
      'hackathon',
      'crypto',
      'web3',
      'nft',
    ],
  },
  {
    id: 'minimal',
    mood: ['minimal', 'minimalist', 'clean', 'simple', 'understated', 'spare', 'quiet'],
    keywords: [
      'clinic',
      'dental',
      'dentist',
      'doctor',
      'medical',
      'hospital',
      'healthcare',
      'physiotherapy',
      'pharmacy',
      'diagnostic',
      'law firm',
      'lawyer',
      'legal',
      'advocate',
      'accounting',
      'accountant',
      'audit',
      'insurance',
      'bank',
      'banking',
      'consultancy',
      'consulting',
      'portfolio',
      'resume',
      'logistics',
      'manufacturing',
    ],
  },
];

/**
 * Which direction wins when two score equally. Read left to right: a prompt that
 * says both "premium" and "clinic" is a premium clinic, not a generic one — the
 * mood word is the differentiator once the industry is already covered by the
 * UI/UX brief's own industry profile.
 */
const TIE_ORDER: DesignDirectionId[] = [
  'premium',
  'editorial',
  'technical',
  'playful',
  'bold',
  'minimal',
];

function normalize(prompt: string) {
  const words = (prompt || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return { text: ` ${words} `, tokens: words.split(' ').filter(Boolean) };
}

function scoreSignal(tokens: readonly string[], text: string, keywords: readonly string[]) {
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

/**
 * The direction a prompt describes, or {@link DEFAULT_DESIGN_DIRECTION} when it
 * describes none. Never throws and never returns anything but a valid id, so it
 * is safe as the last step of request parsing.
 */
export function inferDesignDirection(prompt: string): DesignDirectionId {
  const { text, tokens } = normalize(prompt);
  if (tokens.length === 0) return DEFAULT_DESIGN_DIRECTION;

  const winner = (pick: (signal: DirectionSignal) => readonly string[]) => {
    let best = 0;
    const winners: DesignDirectionId[] = [];
    for (const signal of SIGNALS) {
      const score = scoreSignal(tokens, text, pick(signal));
      if (score > best) {
        best = score;
        winners.length = 0;
      }
      if (score === best && score > 0) winners.push(signal.id);
    }
    if (winners.length === 0) return null;
    return TIE_ORDER.find((id) => winners.includes(id)) ?? null;
  };

  // Two passes, not one score. A prompt that says how it should feel has already
  // answered the question: "a premium dental clinic" is a premium clinic, and
  // summing mood and industry together let two industry words ("dental",
  // "clinic") outvote the one word the user chose deliberately.
  return (
    winner((signal) => signal.mood) ??
    winner((signal) => signal.keywords) ??
    DEFAULT_DESIGN_DIRECTION
  );
}
