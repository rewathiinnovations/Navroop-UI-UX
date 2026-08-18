import { fallbackAltText } from '@/lib/assets/keys';
import { getSetting } from '@/lib/settings/resolve';
import { persistOptimizedAsset } from '@/lib/assets/persist';

/**
 * Unsplash requires attribution for every photo used.
 * Part C generation rules must emit photographer credit in the generated markup
 * for kind=stock assets (e.g. "Photo by Name on Unsplash").
 */
export type SearchStockInput = {
  projectId: string;
  query: string;
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

export async function searchStockPhoto(input: SearchStockInput) {
  const query = input.query.trim();
  if (!query) throw new Error('Stock photo query is required');

  const accessKey = await getSetting('tooling.unsplash.accessKey');
  if (!accessKey) {
    throw new Error('No Unsplash access key is configured. Add one in Admin → Configuration.');
  }

  const search = new URL('https://api.unsplash.com/search/photos');
  search.searchParams.set('query', query);
  search.searchParams.set('per_page', '1');
  search.searchParams.set('orientation', 'landscape');

  const response = await fetch(search, {
    headers: { Authorization: `Client-ID ${accessKey}` },
  });
  if (!response.ok) {
    throw new Error(`Unsplash search failed (${response.status})`);
  }
  const data = (await response.json()) as UnsplashSearch;
  const photo = data.results?.[0];
  const downloadUrl = photo?.urls?.regular || photo?.urls?.full;
  if (!photo || !downloadUrl) {
    throw new Error('No Unsplash photo matched that query');
  }

  const image = await fetch(downloadUrl);
  if (!image.ok) throw new Error('Unsplash download failed');
  const buffer = Buffer.from(await image.arrayBuffer());

  const photographer = photo.user?.name || photo.user?.username || 'Unsplash photographer';
  const attribution = `Photo by ${photographer} on Unsplash`;
  const altText = fallbackAltText(photo.alt_description || photo.description || query);
  const prompt = `${query} — ${attribution}`;

  return persistOptimizedAsset({
    projectId: input.projectId,
    buffer,
    kind: 'stock',
    prompt,
    altText,
  });
}
