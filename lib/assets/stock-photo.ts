import { fallbackAltText } from '@/lib/assets/keys';
import { getSetting } from '@/lib/settings/resolve';
import { persistOptimizedAsset } from '@/lib/assets/persist';
import { searchOpenversePhoto } from '@/lib/assets/openverse';
import { downloadImageBuffer } from '@/lib/assets/download';

/**
 * Stock photography for a generated site, as an ordered chain of providers.
 *
 * Unsplash is the normal path whenever `tooling.unsplash.accessKey` is set.
 * Openverse is the keyless fallback for what Unsplash cannot serve on a given
 * request: a query with no match, a 4xx/5xx, or the demo-tier rate limit of 50
 * requests/hour — which one build of a multi-page site with several NEED_IMAGE
 * tokens can plausibly exhaust. Without the fallback those tokens became grey
 * placeholder panels and the generated page read as broken.
 *
 * Neither provider's photo carries an attribution string into the generated
 * markup: the asset manifest the model sees (`lib/assets/manifest.ts`) exposes
 * only url/altText/size/kind, so any credit the model wrote was invented. One
 * verified site shipped a "Photo via Unsplash" caption under a placeholder that
 * no photographer ever took. The generation rules now caption only an asset that
 * genuinely carries a credit line.
 */
export type SearchStockInput = {
  projectId: string;
  query: string;
  /**
   * Shared state for all directives in one generation. Optional so a single
   * ad-hoc search still works; `fulfillNeedImages` passes one per run.
   */
  run?: StockPhotoRun;
};

/**
 * Per-generation memory of a provider that has refused in a way that will refuse
 * again. Deliberately passed in rather than held at module scope: module state
 * would leak between generations in a long-lived server process and between
 * tests in one file.
 */
export type StockPhotoRun = {
  /** Why Unsplash is being skipped for the rest of this generation. */
  unsplashUnavailable?: string;
};

type UnsplashSearch = {
  results?: Array<{
    alt_description?: string | null;
    description?: string | null;
    urls?: { regular?: string; full?: string };
    user?: { name?: string; username?: string };
    links?: { html?: string };
  }>;
};

async function searchUnsplash(
  input: { projectId: string; query: string },
  accessKey: string,
  run?: StockPhotoRun,
) {
  const search = new URL('https://api.unsplash.com/search/photos');
  search.searchParams.set('query', input.query);
  search.searchParams.set('per_page', '1');
  search.searchParams.set('orientation', 'landscape');

  const response = await fetch(search, {
    headers: { Authorization: `Client-ID ${accessKey}` },
  });
  if (!response.ok) {
    // 429, and the 403 Unsplash uses to report a spent demo-tier allowance, will
    // answer the same way for every remaining directive; 401 means the key itself
    // is rejected. Record it once so the rest of this generation goes straight to
    // the fallback instead of hammering an endpoint that has already said no.
    if (run && (response.status === 401 || response.status === 403 || response.status === 429)) {
      run.unsplashUnavailable = `refused with ${response.status} earlier in this generation`;
    }
    throw new Error(`Unsplash search failed (${response.status})`);
  }
  const data = (await response.json()) as UnsplashSearch;
  const photo = data.results?.[0];
  const downloadUrl = photo?.urls?.regular || photo?.urls?.full;
  if (!photo || !downloadUrl) {
    throw new Error('No Unsplash photo matched that query');
  }

  // Same ceiling and content-type check as the Openverse path: the URL is still
  // a remote body this process has to hold in memory.
  const buffer = await downloadImageBuffer(downloadUrl);

  const photographer = photo.user?.name || photo.user?.username || 'Unsplash photographer';
  const attribution = `Photo by ${photographer} on Unsplash`;
  const altText = fallbackAltText(photo.alt_description || photo.description || input.query);
  const prompt = `${input.query} — ${attribution}`;

  return persistOptimizedAsset({
    projectId: input.projectId,
    buffer,
    kind: 'stock',
    prompt,
    altText,
  });
}

function reasonOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * First provider that can answer wins. When none can, the throw names every
 * provider and its reason — a caller logging only `error.message` still gets a
 * diagnosable line instead of "no photo".
 */
export async function searchStockPhoto(input: SearchStockInput) {
  const query = input.query.trim();
  if (!query) throw new Error('Stock photo query is required');

  const target = { projectId: input.projectId, query };
  const failures: string[] = [];

  const accessKey = await getSetting('tooling.unsplash.accessKey');
  if (input.run?.unsplashUnavailable) {
    failures.push(`unsplash: skipped, ${input.run.unsplashUnavailable}`);
  } else if (!accessKey) {
    failures.push('unsplash: no access key configured');
  } else {
    try {
      return await searchUnsplash(target, accessKey, input.run);
    } catch (error) {
      failures.push(`unsplash: ${reasonOf(error)}`);
    }
  }

  try {
    return await searchOpenversePhoto(target);
  } catch (error) {
    failures.push(`openverse: ${reasonOf(error)}`);
  }

  throw new Error(`No photo provider could serve "${query}" — ${failures.join('; ')}`);
}
