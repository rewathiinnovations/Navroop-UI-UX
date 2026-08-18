import { safeFetch } from '../security/safe-fetch.ts';
import type { CapturedImage, RehostResult, RehostedAsset } from './types.ts';

export const MAX_REHOST_BYTES = 10 * 1024 * 1024;

export function shouldSkipRehost(input: { contentLength?: number | null; byteLength?: number | null }) {
  if (typeof input.contentLength === 'number' && input.contentLength > MAX_REHOST_BYTES) return true;
  if (typeof input.byteLength === 'number' && input.byteLength > MAX_REHOST_BYTES) return true;
  return false;
}

function altFromUrl(url: string, fallback?: string) {
  if (fallback?.trim()) return fallback.trim();
  try {
    const path = new URL(url).pathname.split('/').filter(Boolean).pop() || 'image';
    return path.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ') || 'Imported image';
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

  for (const image of input.images) {
    const sourceUrl = image.url?.trim();
    if (!sourceUrl || seen.has(sourceUrl)) continue;
    seen.add(sourceUrl);
    if (sourceUrl.startsWith('data:')) {
      warnings.push(`skipped data URL`);
      continue;
    }
    try {
      const response = fetchImpl
        ? await fetchImpl(sourceUrl, { redirect: 'manual' })
        : await safeFetch(sourceUrl, { userId: input.userId });
      if (!response.ok) {
        warnings.push(`skipped ${sourceUrl} (${response.status})`);
        continue;
      }
      const headerLength = Number(response.headers.get('content-length') || 0);
      if (shouldSkipRehost({ contentLength: headerLength || null })) {
        warnings.push(`skipped ${sourceUrl} (over 10MB)`);
        continue;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (shouldSkipRehost({ byteLength: buffer.byteLength })) {
        warnings.push(`skipped ${sourceUrl} (over 10MB)`);
        continue;
      }
      const asset = await persist(buffer, altFromUrl(sourceUrl, image.alt), sourceUrl);
      assets.push(asset);
    } catch (error) {
      const detail = error instanceof Error && error.message ? error.message : 'fetch failed';
      warnings.push(`skipped ${sourceUrl} (fetch failed: ${detail})`);
    }
  }

  return { assets, warnings };
}
