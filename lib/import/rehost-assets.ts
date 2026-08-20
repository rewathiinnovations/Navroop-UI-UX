import { safeFetch } from '../security/safe-fetch.ts';
import { sanitizeUntrustedLine } from '../security/untrusted-html.ts';
import type { CapturedImage, RehostResult, RehostedAsset } from './types.ts';

export const MAX_REHOST_BYTES = 10 * 1024 * 1024;

/**
 * How many images one import may rehost.
 *
 * Each one is a network fetch of up to 10 MB, a sharp re-encode and a storage
 * upload plus a `ProjectAsset` row, and the page can offer as many as it likes:
 * a catalogue or an image gallery used to produce hundreds. Forty covers the
 * hero, the section art and the gallery strip of a normal marketing page, which
 * is all the generated site can place.
 */
export const MAX_REHOST_ASSETS = 40;

/**
 * Wall-clock budget for the whole rehost stage. The count cap alone does not
 * bound time — forty images behind one slow host still ran for minutes, and the
 * import job's heartbeat keeps it alive, so the reaper never clears it.
 */
export const MAX_REHOST_MS = 90_000;

/** Fetched this many at a time, matching `fulfillNeedImages`' image batches. */
export const REHOST_CONCURRENCY = 3;

export function shouldSkipRehost(input: {
  contentLength?: number | null;
  byteLength?: number | null;
}) {
  if (typeof input.contentLength === 'number' && input.contentLength > MAX_REHOST_BYTES)
    return true;
  if (typeof input.byteLength === 'number' && input.byteLength > MAX_REHOST_BYTES) return true;
  return false;
}

/**
 * `alt` is read off the imported page's DOM and is stored as `ProjectAsset.altText`, which
 * every later generation for that project renders into the pipe-delimited PROJECT ASSETS
 * manifest — a permanent line in the prompt of every future chat message. Third-party text
 * is therefore flattened to one short plain line here, at the boundary, before it is
 * persisted: no `|` to forge a manifest row, no markup, no unbounded instruction blob.
 * A page that supplies nothing usable falls back to the filename.
 */
export function importedAltText(url: string, pageAlt?: string) {
  const fromPage = sanitizeUntrustedLine(pageAlt ?? '');
  if (fromPage) return fromPage;
  try {
    const path = new URL(url).pathname.split('/').filter(Boolean).pop() || 'image';
    const fromUrl = sanitizeUntrustedLine(path.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' '));
    return fromUrl || 'Imported image';
  } catch {
    return 'Imported image';
  }
}

export async function rehostImportAssets(input: {
  projectId: string;
  userId?: string;
  images: CapturedImage[];
  fetchImpl?: typeof fetch;
  persist?: (buffer: Buffer, altText: string, sourceUrl: string) => Promise<RehostedAsset>;
  /** Elapsed-time source, injectable so the budget is testable. */
  clock?: () => number;
}): Promise<RehostResult> {
  const fetchImpl = input.fetchImpl;
  const persist =
    input.persist ??
    (async (buffer: Buffer, altText: string, sourceUrl: string) => {
      const { persistOptimizedAsset } = await import('../assets/persist.ts');
      const row = await persistOptimizedAsset({
        projectId: input.projectId,
        buffer,
        kind: 'uploaded',
        prompt: sourceUrl,
        altText,
      });
      return {
        url: row.url,
        altText: row.altText,
        width: row.width,
        height: row.height,
        sourceUrl,
      };
    });

  const assets: RehostedAsset[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  const now = input.clock ?? Date.now;
  const startedAt = now();

  const queue: Array<{ sourceUrl: string; alt?: string }> = [];
  for (const image of input.images) {
    const sourceUrl = image.url?.trim();
    if (!sourceUrl || seen.has(sourceUrl)) continue;
    seen.add(sourceUrl);
    if (sourceUrl.startsWith('data:')) {
      warnings.push(`skipped data URL`);
      continue;
    }
    queue.push({ sourceUrl, alt: image.alt });
  }

  if (queue.length > MAX_REHOST_ASSETS) {
    warnings.push(
      `skipped ${queue.length - MAX_REHOST_ASSETS} more images (limit ${MAX_REHOST_ASSETS} per import)`,
    );
    queue.length = MAX_REHOST_ASSETS;
  }

  const one = async (item: { sourceUrl: string; alt?: string }) => {
    const { sourceUrl } = item;
    try {
      const response = fetchImpl
        ? await fetchImpl(sourceUrl, { redirect: 'manual' })
        : await safeFetch(sourceUrl, { userId: input.userId });
      if (!response.ok) {
        warnings.push(`skipped ${sourceUrl} (${response.status})`);
        return;
      }
      const headerLength = Number(response.headers.get('content-length') || 0);
      if (shouldSkipRehost({ contentLength: headerLength || null })) {
        warnings.push(`skipped ${sourceUrl} (over 10MB)`);
        return;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (shouldSkipRehost({ byteLength: buffer.byteLength })) {
        warnings.push(`skipped ${sourceUrl} (over 10MB)`);
        return;
      }
      assets.push(await persist(buffer, importedAltText(sourceUrl, item.alt), sourceUrl));
    } catch (error) {
      const detail = error instanceof Error && error.message ? error.message : 'fetch failed';
      warnings.push(`skipped ${sourceUrl} (fetch failed: ${detail})`);
    }
  };

  for (let index = 0; index < queue.length; index += REHOST_CONCURRENCY) {
    if (now() - startedAt >= MAX_REHOST_MS) {
      warnings.push(
        `stopped after ${Math.round(MAX_REHOST_MS / 1000)}s — ${queue.length - index} images were not rehosted`,
      );
      break;
    }
    await Promise.all(queue.slice(index, index + REHOST_CONCURRENCY).map(one));
  }

  return { assets, warnings };
}
