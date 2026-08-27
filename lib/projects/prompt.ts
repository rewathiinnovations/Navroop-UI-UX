export function looksLikeUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed)) return false;
  return /^(https?:\/\/)?([\w-]+\.)+[a-z]{2,}([/?#].*)?$/i.test(trimmed);
}

/**
 * The one length a project name is cut to, and the one place a name is derived from text.
 *
 * There used to be two helpers answering this question with different numbers: this file's
 * `titleFromPrompt` (48, ellipsis, no caller) and `nameFromPrompt` in `lib/projects/schema.ts`
 * (40, hard slice) — and only the second reached the database. Its hard slice is what named a
 * project `Build a landing page for "Chai Point", a`: cut mid-word, ending on a dangling
 * article. That string is not cosmetic. It slugifies into the GitHub repository name
 * (`lib/github/repo-name.ts`), the export archive filename (`lib/export/filename.ts`) and the
 * published subdomain — the measured `liveUrl` was
 * `https://build-a-landing-page-for-chai-point-a.navroop.app`, which is the URL a customer's
 * site is served on. Two functions disagreeing about a number is how that went unnoticed, so
 * there is now exactly one; `schema.ts` re-exports this binding rather than defining its own.
 */
export const PROJECT_NAME_LIMIT = 48;

export const UNTITLED_PROJECT_NAME = 'Untitled project';

/**
 * Words a truncated name must not end on. A cut that lands after "…for a" or "…and" reads as
 * a sentence someone forgot to finish, and it is the dangling article that made the Chai Point
 * subdomain absurd rather than merely long.
 */
const TRAILING_STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'but',
  'with',
  'for',
  'of',
  'to',
  'in',
  'on',
  'at',
  'from',
  'by',
  'that',
  'which',
  'plus',
  'featuring',
  'including',
  '&',
]);

/** Clause and sentence terminators, Latin and CJK — a name may end on any of them. */
const BOUNDARY_CHARS = ',;:.!?—–，、。；：！？';

const ENDS_ON_BOUNDARY = new RegExp(`[${BOUNDARY_CHARS}]$`);

/**
 * A boundary cut this early throws most of the name away ("Hi, build me …" would become
 * "Hi"), so below it the word-boundary trim wins instead.
 */
const MIN_BOUNDARY_CUT = 16;

/** Trailing debris left by a cut. Quotes are deliberately absent: dropping the closing quote
 *  of `for "Chai Point"` would leave the name unbalanced. */
const TRAILING_JUNK = /[\s.,;:!?/|&_-]+$/;
const LEADING_JUNK = /^[\s.,;:!?/|&_-]+/;

/**
 * Grapheme clusters, not UTF-16 units. A 40-char slice of Devanagari, Thai or an emoji family
 * splits a cluster and leaves a lone surrogate or an orphaned combining mark in the project
 * name — which then reaches a repository name and a DNS label.
 */
function graphemesOf(value: string): string[] {
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    return Array.from(segmenter.segment(value), (part) => part.segment);
  }
  // Code points still never split a surrogate pair, which is the worst of the failure modes.
  return Array.from(value);
}

function collapse(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

/** The word with its edge punctuation removed, lowercased, for stopword lookups. */
function bareWord(token: string) {
  return token.replace(LEADING_JUNK, '').replace(TRAILING_JUNK, '').toLowerCase();
}

function dropDanglingWords(value: string): string {
  const words = value.trim().replace(TRAILING_JUNK, '').split(' ').filter(Boolean);
  // Never below one word: a prompt that is a single stopword still has to produce a name.
  while (words.length > 1 && TRAILING_STOPWORDS.has(bareWord(words[words.length - 1] ?? ''))) {
    words.pop();
  }
  return words.join(' ').replace(TRAILING_JUNK, '').trim();
}

/**
 * Cuts `value` to `PROJECT_NAME_LIMIT` graphemes, preferring a clause boundary, then a word
 * boundary, then — only for a single token with no space in it — the raw window. Never
 * returns an empty string, and appends the ellipsis whenever anything was dropped.
 */
function trimToNameLimit(value: string): string {
  const units = graphemesOf(value);
  if (units.length <= PROJECT_NAME_LIMIT) return value;
  const window = units.slice(0, PROJECT_NAME_LIMIT).join('');

  let boundary = -1;
  for (let i = window.length - 1; i >= 0; i -= 1) {
    if (BOUNDARY_CHARS.includes(window.charAt(i))) {
      boundary = i;
      break;
    }
  }

  const attempts: string[] = [];
  if (boundary >= MIN_BOUNDARY_CUT) attempts.push(window.slice(0, boundary));
  const lastSpace = window.lastIndexOf(' ');
  if (lastSpace > 0) attempts.push(window.slice(0, lastSpace));

  for (const attempt of attempts) {
    const tidied = dropDanglingWords(attempt);
    if (tidied) return `${tidied}…`;
  }
  // One very long token with no space and no punctuation. The window is grapheme-safe, so a
  // hard cut here is the only option that is not an empty name.
  return `${window}…`;
}

/**
 * The name a project gets at insert, before any plan exists — and the permanent name for the
 * paths that never produce one (URL import, skip-planning).
 */
export function nameFromPrompt(prompt: string): string {
  const cleaned = collapse(prompt);
  if (!cleaned) return UNTITLED_PROJECT_NAME;
  if (looksLikeUrl(cleaned)) {
    // A URL import named after a truncated URL ("https://stripe.com/pricing/enterprise…") is
    // worse than useless in a sidebar. The host is what the user recognises.
    const host = cleaned
      .replace(/^[a-z][\w+.-]*:\/\//i, '')
      .split(/[/?#]/)[0]
      ?.replace(/^www\./i, '');
    return trimToNameLimit(host || cleaned);
  }
  return trimToNameLimit(cleaned);
}

/** Words after which a capitalised run in a plan summary is the thing being built. */
const SUBJECT_INTRODUCERS = new Set([
  'for',
  'called',
  'named',
  'titled',
  'branded',
  'promoting',
  'showcasing',
]);

/**
 * Capitalised runs that name a technology, a page or the product itself rather than the
 * customer's business. Without this, "a landing page for Next.js" names the project "Next.js".
 */
const SUBJECT_DENY = new Set([
  'react',
  'next',
  'next.js',
  'nextjs',
  'node',
  'node.js',
  'vite',
  'astro',
  'tailwind',
  'tailwind css',
  'css',
  'html',
  'javascript',
  'typescript',
  'json',
  'seo',
  'ui',
  'ux',
  'api',
  'ai',
  'github',
  'vercel',
  'google',
  'google fonts',
  'home',
  'about',
  'contact',
  'pricing',
  'landing page',
  'untitled project',
]);

/**
 * Symbols and words that join two halves of one business name.
 *
 * `&` is in `LEADING_JUNK`, so stripping a token's edge punctuation turned the standalone
 * `&` of "…landing page for Kettle & Co, a specialty coffee roastery in Pune" into an empty
 * string, which is not a subject word, which ended the run: the project, its repository, its
 * export archive and its published subdomain were all named `Kettle`. Half a business name
 * is not recoverable downstream — every consumer slugifies whatever it is handed.
 *
 * A connector is held rather than emitted: it joins only once another subject word follows,
 * so "for Acme and its customers" still ends at `Acme` and never at `and`.
 */
const SUBJECT_CONNECTORS = new Set(['&', '+', 'and']);

/**
 * A word that can carry the subject: one that begins upper case, or one whose script has no
 * upper case to begin with. Requiring a case distinction refused every name written in CJK,
 * Devanagari, Arabic, Hebrew or Thai — `'カ' === 'カ'.toLowerCase()` — so a run in one of them
 * ended before its first word. Digits and punctuation are still not names.
 */
function isSubjectWord(word: string) {
  const first = word.charAt(0);
  if (!first) return false;
  const lower = first.toLowerCase();
  const upper = first.toUpperCase();
  if (lower !== upper) return first !== lower && first === upper;
  return HAS_NAMEABLE_CHARACTER.test(first);
}

function introducedSubject(text: string): string | null {
  const tokens = text.split(' ');
  for (let i = 0; i < tokens.length - 1; i += 1) {
    if (!SUBJECT_INTRODUCERS.has(bareWord(tokens[i] ?? ''))) continue;
    const run: string[] = [];
    /** Connectors seen since the last subject word, kept only if another one follows. */
    let pending: string[] = [];
    for (let j = i + 1; j < tokens.length; j += 1) {
      const token = tokens[j] ?? '';
      // A connector still carrying a terminator ("Kettle &, a roastery") is not one: it
      // falls through, strips to nothing, and ends the run where the clause ended.
      if (run.length > 0 && SUBJECT_CONNECTORS.has(token.toLowerCase())) {
        pending.push(token);
        continue;
      }
      const word = token.replace(LEADING_JUNK, '').replace(TRAILING_JUNK, '');
      if (!isSubjectWord(word)) break;
      run.push(...pending, word);
      pending = [];
      // The clause ended on this word ("for Kettle & Co, a specialty roastery"), so the run does.
      if (ENDS_ON_BOUNDARY.test(token)) break;
    }
    if (run.length > 0) return run.join(' ');
  }
  return null;
}

/** Digits and punctuation alone are not a name; any letter, Latin or not, is. */
const HAS_NAMEABLE_CHARACTER = /[^\s\d.,;:!?'"“”()[\]{}\-–—_/\\|&@#$%^*+=~`]/;

function acceptableSubject(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = collapse(raw).replace(LEADING_JUNK, '').replace(TRAILING_JUNK, '').trim();
  if (value.length < 2) return null;
  if (!HAS_NAMEABLE_CHARACTER.test(value)) return null;
  if (SUBJECT_DENY.has(value.toLowerCase())) return null;
  const words = value.split(' ').filter(Boolean);
  // Nothing but filler. Stopwords were always refused; the denied words have to be refused
  // word by word as well now that a connector can join two of them, or "A single page for
  // Home and Contact" would name the project after its own page list — the exact-match test
  // above only sees a denied word standing alone.
  const isFiller = (word: string) =>
    TRAILING_STOPWORDS.has(bareWord(word)) ||
    SUBJECT_DENY.has(bareWord(word)) ||
    SUBJECT_CONNECTORS.has(word.toLowerCase());
  if (words.every(isFiller)) return null;
  return trimToNameLimit(value) || null;
}

/**
 * The subject the plan is about, or `null` when the plan names none.
 *
 * The plan for the Chai Point run already knew the business: its summary opened "A warm,
 * minimal landing page for Chai Point, a small tea cafe in Bangalore." Two signals are read,
 * strongest first — a quoted phrase, then a run of subject words introduced by
 * for/called/named — and anything else returns `null` so the provisional prompt-derived name
 * stands. Guessing a worse name than the one already on the row is not an improvement.
 *
 * The run is the whole subject, `&`/`+`/`and` and all: it is a display name, not a slug, so
 * nothing is removed here for the benefit of a downstream target. `slugifyRepoName`,
 * `slugifyExportName`, `slugFromName` (the published subdomain) and `slugify` (the generated
 * package.json) each sanitise this string for their own target, and each has its own fallback
 * for a name that leaves them nothing — which is what lets the name keep an ampersand, an
 * apostrophe or a non-Latin script.
 */
export function nameFromPlanSummary(summary: string | null | undefined): string | null {
  const cleaned = collapse(String(summary ?? ''));
  if (!cleaned) return null;
  const quoted = cleaned.match(/["“«]([^"“”«»\n]{2,60})["”»]/);
  return acceptableSubject(quoted?.[1]) ?? acceptableSubject(introducedSubject(cleaned));
}

/** API returns `name`; older clients still read `title`. */
export function projectDisplayName(
  project:
    | {
        name?: string | null;
        title?: string | null;
      }
    | null
    | undefined,
) {
  return (project?.name || project?.title || '').trim();
}
