import { isLucideIcon, lucideIconNames } from './lucide-icon-names';

/**
 * Rewrite `lucide-react` imports that name an icon the library does not have.
 *
 * ## The incident
 *
 * A generated dental clinic imported `{ Implant } from "lucide-react"`. The
 * pipeline reported "imports resolve and the build compiles" — because
 * `lib/generation/validate-imports.ts` skips bare specifiers by design and the
 * esbuild check treats `lucide-react` as external — and the first thing the user
 * saw was the preview dying with
 *
 *   SyntaxError: The requested module 'lucide-react' does not provide an export
 *   named 'Implant'
 *
 * A model that has decided a page needs a tooth icon will keep deciding that;
 * `Tooth`, `Implant`, `Dental` and `Molar` are all things lucide has never
 * shipped. So this does not report the problem for a repair turn to fix — a
 * repair turn is a second model call, more latency and another chance to fail.
 * It repairs it in place, deterministically, before the files are written.
 *
 * ## Why aliasing rather than renaming
 *
 * The fix rewrites `{ Implant }` to `{ Smile as Implant }`. The local name the
 * rest of the file uses is untouched, so no JSX, no prop, no array of icon
 * references has to be found and rewritten — which is exactly where a
 * regex-based fixer would introduce the next bug. One edit per bad specifier,
 * inside the import statement, and nothing else in the file moves.
 */

/**
 * Icons the model invents, and the real icon that carries the same meaning.
 *
 * Keyed by the lowercased invalid name. Ordinary near-misses (a plural, a
 * casing slip, a dropped suffix) are handled by {@link nearestIconName} and do
 * not need an entry; this table is for names with no textual relationship to
 * their answer, which is most domain vocabulary.
 */
const SYNONYMS: Record<string, string> = {
  // Dental and medical — the sector that produced the original incident.
  tooth: 'Smile',
  teeth: 'Smile',
  dental: 'Smile',
  dentist: 'Smile',
  implant: 'Smile',
  molar: 'Smile',
  braces: 'Smile',
  aligner: 'Smile',
  toothbrush: 'Smile',
  whitening: 'Sparkles',
  cavity: 'Smile',
  medical: 'Stethoscope',
  doctor: 'Stethoscope',
  nurse: 'Stethoscope',
  patient: 'User',
  clinic: 'Building2',
  hospital: 'Building2',
  ambulance: 'Truck',
  xray: 'ScanLine',
  scan: 'ScanLine',
  surgery: 'Scissors',
  vaccine: 'Syringe',
  medicine: 'Pill',
  prescription: 'ClipboardList',
  appointment: 'CalendarCheck',
  booking: 'CalendarCheck',
  // Commerce.
  cart: 'ShoppingCart',
  basket: 'ShoppingBasket',
  checkout: 'CreditCard',
  payment: 'CreditCard',
  invoice: 'FileText',
  order: 'Package',
  orders: 'Package',
  shipping: 'Truck',
  delivery: 'Truck',
  discount: 'Tag',
  coupon: 'Ticket',
  wishlist: 'Heart',
  review: 'Star',
  reviews: 'Star',
  rating: 'Star',
  // Dashboards and admin.
  dashboard: 'LayoutDashboard',
  analytics: 'ChartLine',
  metrics: 'ChartLine',
  revenue: 'TrendingUp',
  customers: 'Users',
  inventory: 'Boxes',
  products: 'Package',
  settings: 'Settings',
  logout: 'LogOut',
  login: 'LogIn',
  profile: 'User',
  notification: 'Bell',
  notifications: 'Bell',
  report: 'FileBarChart',
  reports: 'FileBarChart',
  // Food, fitness, property, misc verticals.
  restaurant: 'UtensilsCrossed',
  menu: 'BookOpen',
  chef: 'ChefHat',
  cuisine: 'UtensilsCrossed',
  reservation: 'CalendarCheck',
  gym: 'Dumbbell',
  workout: 'Dumbbell',
  fitness: 'Dumbbell',
  yoga: 'Flower2',
  property: 'Home',
  realestate: 'Home',
  apartment: 'Building',
  mortgage: 'Landmark',
  lawyer: 'Scale',
  legal: 'Scale',
  course: 'GraduationCap',
  student: 'GraduationCap',
  lesson: 'BookOpen',
  certificate: 'Award',
  // Generic UI words that are not icons.
  security: 'ShieldCheck',
  privacy: 'Lock',
  support: 'LifeBuoy',
  whatsapp: 'MessageCircle',
  chat: 'MessageCircle',
  social: 'Share2',
  location: 'MapPin',
  address: 'MapPin',
  hours: 'Clock',
  timing: 'Clock',
  gallery: 'Images',
  photo: 'Image',
  testimonial: 'Quote',
  faq: 'CircleHelp',
  question: 'CircleHelp',
};

/** The icon used when nothing else matches. Neutral, always present, never wrong. */
const FALLBACK_ICON = 'Circle';

function splitWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

function levenshtein(a: string, b: string, cutoff: number): number {
  if (Math.abs(a.length - b.length) > cutoff) return cutoff + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowBest = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
      current.push(value);
      if (value < rowBest) rowBest = value;
    }
    // Nothing in the rest of the matrix can come back under the cutoff.
    if (rowBest > cutoff) return cutoff + 1;
    previous = current;
  }
  return previous[b.length];
}

/**
 * The best real icon for a name lucide does not export.
 *
 * Order matters: a curated synonym for any word in the name beats a spelling
 * guess, because "SmileIcon" and "ToothIcon" are one edit apart from different
 * answers and only one of them is about teeth.
 */
export function nearestIconName(invalid: string): string {
  const words = splitWords(invalid);

  // 1. A curated synonym for the whole name, then for any word in it. A trailing
  //    plural is stripped, so `Dashboards` reaches the `dashboard` entry rather
  //    than falling through to a spelling guess.
  const forms = (word: string) => (word.endsWith('s') ? [word, word.slice(0, -1)] : [word]);
  for (const form of forms(words.join(''))) {
    if (SYNONYMS[form]) return SYNONYMS[form];
  }
  for (const word of words) {
    for (const form of forms(word)) {
      if (SYNONYMS[form]) return SYNONYMS[form];
    }
  }

  const known = lucideIconNames();

  // 2. Obvious morphological misses: a plural, a stray `Icon` suffix, a dropped
  //    or added word.
  const candidates = [
    invalid.replace(/Icon$/, ''),
    `${invalid}Icon`,
    invalid.replace(/s$/, ''),
    `${invalid}s`,
  ];
  for (const candidate of candidates) {
    if (candidate && candidate !== invalid && known.has(candidate)) return candidate;
  }
  // A compound where one half is real: `DentalShield` -> `Shield`.
  for (const word of [...words].reverse()) {
    const capitalized = word.charAt(0).toUpperCase() + word.slice(1);
    if (known.has(capitalized)) return capitalized;
  }

  // 3. A spelling slip. Bounded to two edits: past that the "nearest" name is a
  //    coincidence, and a coincidental icon is worse than a neutral one.
  const target = invalid.toLowerCase();
  let best: string | null = null;
  let bestScore = 3;
  for (const name of known) {
    if (Math.abs(name.length - invalid.length) > 2) continue;
    const score = levenshtein(target, name.toLowerCase(), 2);
    if (score < bestScore) {
      bestScore = score;
      best = name;
      if (score === 1) break;
    }
  }
  if (best) return best;

  return FALLBACK_ICON;
}

export type IconSubstitution = {
  file: string;
  from: string;
  to: string;
};

/**
 * One chat line naming what was swapped, or null when nothing was.
 *
 * Silence would be worse than the original bug in one specific way: the page
 * renders, so nobody investigates, and the icon beside "Dental implants" is
 * whatever the fallback chose. Saying it lets the user ask for a better one.
 */
export function describeIconSubstitutions(
  substitutions: readonly IconSubstitution[],
): string | null {
  if (substitutions.length === 0) return null;
  const unique = new Map<string, string>();
  for (const swap of substitutions) unique.set(swap.from, swap.to);
  const pairs = [...unique].map(([from, to]) => `${from} to ${to}`);
  const listed = pairs.slice(0, 6).join(', ');
  const rest = pairs.length > 6 ? `, and ${pairs.length - 6} more` : '';
  return `lucide-react has no icon by ${unique.size === 1 ? 'that name' : 'those names'}, so the import was corrected: ${listed}${rest}. Ask for a different icon if one of these does not fit.`;
}

const LUCIDE_IMPORT = /import\s+(type\s+)?\{([^}]*)\}\s*from\s*(['"])lucide-react\3/g;

/**
 * Repair every `lucide-react` named import across a generated file map.
 *
 * Returns a new map — only files that changed are rewritten — plus the list of
 * substitutions, so the chat can say what was swapped instead of silently
 * shipping a different icon.
 */
export function fixLucideImports(files: Record<string, string>): {
  files: Record<string, string>;
  substitutions: IconSubstitution[];
} {
  const substitutions: IconSubstitution[] = [];
  const next: Record<string, string> = { ...files };

  for (const [path, source] of Object.entries(files)) {
    if (typeof source !== 'string' || !source.includes('lucide-react')) continue;

    const updated = source.replace(LUCIDE_IMPORT, (statement, typeOnly, body, quote) => {
      // A `import type { … }` never reaches the runtime, so an unknown name
      // there is a tsc problem, not a preview crash. Leave it alone.
      if (typeOnly) return statement;

      let changed = false;
      const specifiers = body.split(',').map((entry: string) => {
        const trimmed = entry.trim();
        if (!trimmed) return entry;
        const [imported, ...rest] = trimmed.split(/\s+as\s+/);
        const local = rest.length > 0 ? rest.join(' as ') : imported;
        if (!/^[A-Za-z_$][\w$]*$/.test(imported) || isLucideIcon(imported)) return entry;

        const replacement = nearestIconName(imported);
        substitutions.push({ file: path, from: imported, to: replacement });
        changed = true;
        // Alias back to the local name the rest of the file already uses.
        return ` ${replacement} as ${local}`;
      });

      if (!changed) return statement;
      return `import {${specifiers.join(',')} } from ${quote}lucide-react${quote}`;
    });

    if (updated !== source) next[path] = updated;
  }

  return { files: next, substitutions };
}
