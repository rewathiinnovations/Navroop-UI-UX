import type { LiveDocument, LiveText } from './types';

const TIMEOUT_MS = 8000;

async function fetchText(
  url: string,
): Promise<{ status: number; text: string; url: string; headers: Record<string, string> }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    // Trusted host — do not route through safeFetch.
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    const text = await response.text();
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    return { status: response.status, text, url: response.url, headers };
  } catch (error) {
    // status 0 is the "unreachable" sentinel the audit checks read, but the reason
    // is only useful if it is logged.
    console.warn('[seo] preview fetch failed', url, error);
    return { status: 0, text: '', url, headers: {} };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchPreviewDocument(previewUrl: string): Promise<LiveDocument> {
  const result = await fetchText(previewUrl);
  return {
    url: result.url,
    status: result.status,
    html: result.text,
    headers: result.headers,
  };
}

/**
 * Adds a path to a preview URL that already carries its signed token.
 *
 * `signedPreviewUrl` returns `https://host/<projectId>/?token=<jwt>`
 * (`lib/preview/url.ts:59-61`), so appending the path to the end of that string
 * put it *inside* the token value and every live robots.txt / sitemap.xml check
 * fetched a URL nobody serves. The path belongs on the pathname; the query and
 * fragment ride along untouched.
 */
export function previewPathUrl(previewUrl: string, path: string): string {
  const suffix = path.startsWith('/') ? path : `/${path}`;
  const marker = previewUrl.search(/[?#]/);
  const base = marker === -1 ? previewUrl : previewUrl.slice(0, marker);
  const tail = marker === -1 ? '' : previewUrl.slice(marker);
  return `${base.replace(/\/+$/, '')}${suffix}${tail}`;
}

export async function fetchPreviewText(previewUrl: string, path: string): Promise<LiveText> {
  const result = await fetchText(previewPathUrl(previewUrl, path));
  return { status: result.status, text: result.text };
}
