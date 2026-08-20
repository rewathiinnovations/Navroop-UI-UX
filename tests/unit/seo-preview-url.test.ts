import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchPreviewText, previewPathUrl } from '@/lib/seo/live';

/**
 * The SEO audit fetches robots.txt and sitemap.xml from the served preview, and
 * that URL is signed: `signedPreviewUrl` puts the token in the query string
 * (`lib/preview/url.ts:60`). Appending the path to the end of that string put it
 * inside the token value — `…/p1/?token=t0ken/robots.txt` — so the audit read
 * whatever came back from that corrupted request and then asserted "robots.txt
 * is present and is not sitewide-blocking" from those bytes (F-706).
 */
const SIGNED = 'https://preview.example.com/p1/?token=t0ken';

function stubFetch(body: string) {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(body, { status: 200 });
    }),
  );
  return urls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('previewPathUrl', () => {
  it('inserts the path before the query so the token survives', () => {
    expect(previewPathUrl(SIGNED, '/robots.txt')).toBe(
      'https://preview.example.com/p1/robots.txt?token=t0ken',
    );
    expect(previewPathUrl(SIGNED, '/sitemap.xml')).toBe(
      'https://preview.example.com/p1/sitemap.xml?token=t0ken',
    );
  });

  it('handles a base with no trailing slash, no query, and a fragment', () => {
    expect(previewPathUrl('https://preview.example.com/p1', '/robots.txt')).toBe(
      'https://preview.example.com/p1/robots.txt',
    );
    expect(previewPathUrl('https://preview.example.com/p1/#top', '/robots.txt')).toBe(
      'https://preview.example.com/p1/robots.txt#top',
    );
  });

  it('accepts a path that is not already rooted', () => {
    expect(previewPathUrl(SIGNED, 'robots.txt')).toBe(
      'https://preview.example.com/p1/robots.txt?token=t0ken',
    );
  });
});

describe('fetchPreviewText', () => {
  it('requests the signed path, not the token with a path glued onto it', async () => {
    const urls = stubFetch('User-agent: *\nDisallow:');

    const result = await fetchPreviewText(SIGNED, '/robots.txt');

    expect(urls).toEqual(['https://preview.example.com/p1/robots.txt?token=t0ken']);
    expect(result.status).toBe(200);
    expect(result.text).toContain('User-agent');
  });
});
