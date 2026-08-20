import { safeFetch } from '@/lib/security/safe-fetch';

/**
 * The one way an image is pulled from a host this application does not own.
 *
 * Both stock providers used the global `fetch` on a URL taken from a third-party
 * API response. Openverse's corpus is publicly contributed and it indexes
 * arbitrary CDNs, so a record's `url` is attacker-influenced: `parseOpenverseResults`
 * only checks `^https?://`, and a record pointing at `http://169.254.169.254/`
 * failed the content-type check *after* the request had been made — which is the
 * SSRF. `safeFetch` refuses that URL before any socket is opened, caps redirects,
 * and stops reading at `MAX_IMAGE_DOWNLOAD_BYTES` instead of letting
 * `arrayBuffer()` hold whatever arrived.
 *
 * Unsplash's download URL comes from an API this deployment authenticated to,
 * so its SSRF exposure is far smaller — but the byte ceiling and the
 * content-type check apply to any remote body, and a second code path with its
 * own idea of "safe enough" is how the first one came to have no ceiling. Both
 * providers use this.
 */

/** Same ceiling the import rehost uses (`MAX_REHOST_BYTES`). */
export const MAX_IMAGE_DOWNLOAD_BYTES = 10 * 1024 * 1024;

export type ImageDownloadOptions = {
  /** Attributed on the SSRF reject counter when the URL came from a user. */
  userId?: string;
};

export async function downloadImageBuffer(
  url: string,
  opts: ImageDownloadOptions = {},
): Promise<Buffer> {
  const response = await safeFetch(url, {
    userId: opts.userId,
    maxBytes: MAX_IMAGE_DOWNLOAD_BYTES,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const contentType = response.headers.get('content-type') ?? '';
  if (contentType && !contentType.toLowerCase().startsWith('image/')) {
    // `safeFetch` accepts text/html and application/json too — it is also the
    // page fetcher. An error page is not an image.
    throw new Error(`content-type ${contentType}`);
  }

  // The header pair the rehost path checks: a declared over-size body is refused
  // without reading it. `safeFetch` enforces the same ceiling while streaming,
  // so a lying header cannot get past it either.
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_IMAGE_DOWNLOAD_BYTES) {
    throw new Error('image is too large (over 10 MB)');
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength === 0) throw new Error('empty body');
  return buffer;
}
