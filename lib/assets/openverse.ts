import { fallbackAltText } from '@/lib/assets/keys';
import { persistOptimizedAsset } from '@/lib/assets/persist';

/**
 * Keyless fallback photo source.
 *
 * Unsplash stays the primary provider (see `stock-photo.ts`). Openverse covers
 * what Unsplash cannot serve for a given generation: a query it has no match
 * for, a 4xx/5xx, or the demo-tier rate limit of 50 requests/hour — which one
 * build of a multi-page site with several NEED_IMAGE tokens can plausibly
 * exhaust. It needs no API key, so an install with no photo provider configured
 * still ships real photographs.
 *
 * This exists because a verified generated site ("Tilt & Tamp", 22 files)
 * shipped a grey box where its hero photo belonged: the only configured
 * provider could not answer, every NEED_IMAGE token fell through to
 * `placeholderImageDataUri`, and the page looked broken rather than unfinished.
 */

const OPENVERSE_IMAGES_URL = 'https://api.openverse.org/v1/images/';

/**
 * Only licences that carry no attribution obligation.
 *
 * A generated site is handed to its owner and edited freely afterwards, so
 * nothing guarantees a credit caption survives. A CC-BY photo would put that
 * owner in breach; CC0 and the public domain mark cannot. Enforced twice — as
 * the `license` request filter and again on every parsed result — so a change
 * in the API's defaults cannot quietly widen what we ship.
 */
const ATTRIBUTION_FREE_LICENSES = ['cc0', 'pdm'] as const;
const LICENSE_FILTER = ATTRIBUTION_FREE_LICENSES.join(',');

/**
 * Static membership tables, indexed by arbitrary words taken from a model-written
 * description. Prototype-free so that a description containing "constructor" or
 * "toString" is not silently treated as a stop word.
 */
function wordTable(words: string): Record<string, true> {
  const table: Record<string, true> = Object.create(null);
  for (const word of words.split(',')) table[word] = true;
  return table;
}

/** Vector "photographs" are diagrams and logos; a hero needs a raster photo. */
const REJECTED_FILETYPES = wordTable('svg');

/** How many results one search returns, so the best can be chosen locally. */
const PAGE_SIZE = 20;

/**
 * Words that carry no search signal. Openverse matches against title and tags,
 * where prose connectives and words describing the *act* of photographing
 * ("photo of", "shot showing") never appear.
 */
const STOP_WORDS = wordTable(
  'a,an,the,of,with,and,or,in,on,at,for,to,from,by,into,over,under,near,as,is,are,its,their,his,her,' +
    'photo,photos,photograph,photography,image,images,picture,pictures,shot,shots,close,closeup,' +
    'view,views,scene,background,backdrop,hero,banner,showing,shows,featuring,feature,style,styled,' +
    'looking,very,really,quite,some,that,this,these,those,being,been,there,here,' +
    'beautiful,modern,detailed,professional,high,quality,nice,good,great,lovely,pretty,clean,simple',
);

/**
 * Real words that describe framing, mood or setting rather than the subject.
 * Demoted, not dropped: "interior" is a fine extra term but a terrible primary
 * one. Searching the first words of "warm interior of an artisan coffee bar…"
 * returns porcelain bowls; searching "espresso" returns an espresso bar.
 */
const GENERIC_WORDS = wordTable(
  'warm,cool,soft,hard,natural,light,lighting,bright,dark,moody,cozy,rustic,vintage,retro,fresh,' +
    'plate,table,wooden,wood,interior,exterior,indoor,outdoor,inside,outside,room,space,wall,floor,' +
    'person,people,man,woman,men,women,group,hand,hands,face,portrait,large,small,big,little',
);

/** The subset of the response this module relies on; verified against the live API. */
type OpenverseImage = {
  title?: string | null;
  url?: string | null;
  creator?: string | null;
  license?: string | null;
  license_url?: string | null;
  category?: string | null;
  filetype?: string | null;
  width?: number | null;
  height?: number | null;
  tags?: Array<{ name?: string | null }> | null;
};

type OpenverseSearchResponse = { result_count?: number | null; results?: OpenverseImage[] | null };

export type OpenverseCandidate = {
  url: string;
  title: string;
  creator: string | null;
  license: string;
  licenseUrl: string | null;
  width: number;
  height: number;
  /** Lowercased title plus tag names, used to score against the query. */
  haystack: string;
};

/**
 * The description's most distinctive words, most distinctive first.
 *
 * Length is the specificity proxy: "sourdough" beats "fresh", "espresso" beats
 * "warm". Crude, but it needs no corpus and it puts the subject noun first,
 * which is what a conjunctive search depends on.
 */
export function openverseKeywords(description: string): string[] {
  const words = description
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2 && STOP_WORDS[word] !== true);

  const firstSeenAt = new Map<string, number>();
  words.forEach((word, index) => {
    if (!firstSeenAt.has(word)) firstSeenAt.set(word, index);
  });

  return [...firstSeenAt.entries()]
    .map(([word, index]) => ({
      word,
      index,
      score: word.length - (GENERIC_WORDS[word] === true ? 6 : 0),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.word);
}

/**
 * The search ladder, narrow to wide.
 *
 * `q` is conjunctive and has no OR operator — verified against the live API,
 * where `coffee|bar|espresso` matches nothing — so every extra word can only
 * shrink the result set, and a full NEED_IMAGE description passed verbatim
 * returns zero. Two words plus the shape filters is the precise attempt; each
 * later step drops a constraint. Short queries survive `aspect_ratio`/`size`
 * (verified: "sourdough bread" keeps 9 wide/large CC0 matches), so the
 * landscape preference is only given up at the last step.
 */
export function openverseSearchSteps(keywords: string[]): URL[] {
  if (keywords.length === 0) return [];
  const pair = keywords.slice(0, 2).join(' ');
  const single = keywords[0];

  const steps: Array<{ q: string; shape: boolean; photographsOnly: boolean }> = [
    { q: pair, shape: true, photographsOnly: true },
    { q: single, shape: true, photographsOnly: true },
    { q: single, shape: false, photographsOnly: true },
  ];

  const seen = new Set<string>();
  const urls: URL[] = [];
  for (const step of steps) {
    const url = new URL(OPENVERSE_IMAGES_URL);
    url.searchParams.set('q', step.q);
    url.searchParams.set('license', LICENSE_FILTER);
    url.searchParams.set('page_size', String(PAGE_SIZE));
    if (step.photographsOnly) url.searchParams.set('category', 'photograph');
    if (step.shape) {
      url.searchParams.set('aspect_ratio', 'wide');
      url.searchParams.set('size', 'large');
    }
    const key = url.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    urls.push(url);
  }
  return urls;
}

/**
 * Usable candidates from one response body.
 *
 * Anything without a direct `url`, outside the attribution-free licences, or in
 * a vector format is dropped here rather than trusted to the request filter.
 */
export function parseOpenverseResults(payload: unknown): OpenverseCandidate[] {
  const results = (payload as OpenverseSearchResponse | null)?.results;
  if (!Array.isArray(results)) return [];

  const candidates: OpenverseCandidate[] = [];
  for (const item of results) {
    const url = typeof item?.url === 'string' ? item.url.trim() : '';
    const license = typeof item?.license === 'string' ? item.license.toLowerCase().trim() : '';
    if (!url || !/^https?:\/\//i.test(url)) continue;
    if (
      !ATTRIBUTION_FREE_LICENSES.includes(license as (typeof ATTRIBUTION_FREE_LICENSES)[number])
    ) {
      continue;
    }
    const filetype = typeof item?.filetype === 'string' ? item.filetype.toLowerCase() : '';
    if (REJECTED_FILETYPES[filetype] === true) continue;

    const title = (item?.title ?? '').toString().replace(/\s+/g, ' ').trim();
    const tags = Array.isArray(item?.tags)
      ? item.tags.map((tag) => (tag?.name ?? '').toString()).filter(Boolean)
      : [];
    candidates.push({
      url,
      title,
      creator: (item?.creator ?? null) || null,
      license,
      licenseUrl: (item?.license_url ?? null) || null,
      width: Number(item?.width) > 0 ? Number(item.width) : 0,
      height: Number(item?.height) > 0 ? Number(item.height) : 0,
      haystack: `${title} ${tags.join(' ')}`.toLowerCase(),
    });
  }
  return candidates;
}

/**
 * Best match first.
 *
 * The winning step often searched one word, so relevance is recovered here by
 * scoring each result against the *whole* description: how many of its keywords
 * appear in the title and tags dominates, then landscape orientation, then
 * pixel area (capped, so a scan of a wall-sized painting cannot outrank a
 * relevant photo). Ties keep API order, which keeps this deterministic.
 */
export function rankOpenverseCandidates(
  candidates: OpenverseCandidate[],
  keywords: string[],
): OpenverseCandidate[] {
  return candidates
    .map((candidate, index) => {
      const overlap = keywords.filter((word) => candidate.haystack.includes(word)).length;
      const landscape = candidate.width > candidate.height ? 1 : 0;
      const area = Math.min((candidate.width * candidate.height) / (1600 * 900), 4);
      return { candidate, index, score: overlap * 10 + landscape * 4 + area };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.candidate);
}

/** Openverse asks API clients to identify themselves. */
const REQUEST_HEADERS = {
  Accept: 'application/json',
  'User-Agent': 'Navroop/1.0 (+https://github.com/navroop) generated-site image sourcing',
};

/** How many ranked candidates may be downloaded before the query is given up on. */
const DOWNLOAD_ATTEMPTS = 2;

export type SearchOpenverseInput = {
  projectId: string;
  query: string;
};

/**
 * One persisted stock asset, or a throw explaining why not.
 *
 * Messages deliberately do not name Openverse: the only production caller is the
 * provider chain in `stock-photo.ts`, which prefixes each failure with its
 * provider name, and self-naming here produced "openverse: Openverse: …".
 */
export async function searchOpenversePhoto(input: SearchOpenverseInput) {
  const query = input.query.trim();
  if (!query) throw new Error('query is required');

  const keywords = openverseKeywords(query);
  const steps = openverseSearchSteps(keywords);
  if (steps.length === 0) {
    throw new Error(`no searchable keyword in "${query}"`);
  }

  let candidates: OpenverseCandidate[] = [];
  for (const url of steps) {
    const response = await fetch(url, { headers: REQUEST_HEADERS });
    if (response.status === 429) {
      // Widening the query would spend more of an allowance that has already
      // run out. Stop and let the caller report it.
      throw new Error('rate limit reached (429)');
    }
    if (!response.ok) {
      throw new Error(`search failed (${response.status})`);
    }
    candidates = parseOpenverseResults(await response.json());
    if (candidates.length > 0) break;
  }

  if (candidates.length === 0) {
    throw new Error(
      `no CC0 or public-domain photo matched "${query}" (searched ${keywords
        .slice(0, 2)
        .join(' ')})`,
    );
  }

  const ranked = rankOpenverseCandidates(candidates, keywords);
  const downloadFailures: string[] = [];

  for (const candidate of ranked.slice(0, DOWNLOAD_ATTEMPTS)) {
    let buffer: Buffer;
    try {
      // Openverse indexes third-party CDNs, so an individual record can point at
      // a URL that has since died or answers with an error page. One retry on
      // the next-best candidate costs a request and saves a placeholder.
      const image = await fetch(candidate.url);
      if (!image.ok) throw new Error(`HTTP ${image.status}`);
      const contentType = image.headers.get('content-type') ?? '';
      if (contentType && !contentType.toLowerCase().startsWith('image/')) {
        throw new Error(`content-type ${contentType}`);
      }
      buffer = Buffer.from(await image.arrayBuffer());
      if (buffer.byteLength === 0) throw new Error('empty body');
    } catch (error) {
      downloadFailures.push(
        `${candidate.url} (${error instanceof Error ? error.message : String(error)})`,
      );
      continue;
    }

    // CC0 and the public domain mark require no credit, so no attribution
    // string is produced: the generation rules only caption an asset that
    // carries one, and a caption naming a provider that did not supply the
    // photo is worse than none. Provenance still lands in `prompt`, which is
    // operator-facing only.
    const provenance = candidate.creator
      ? `${candidate.title || query} by ${candidate.creator}`
      : candidate.title || query;
    return persistOptimizedAsset({
      projectId: input.projectId,
      buffer,
      kind: 'stock',
      prompt: `${query} — ${provenance} via Openverse (${candidate.license}, no attribution required)`,
      altText: fallbackAltText(candidate.title || query),
    });
  }

  throw new Error(`download failed: ${downloadFailures.join('; ')}`);
}
