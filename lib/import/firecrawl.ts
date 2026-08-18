/**
 * Firecrawl scrape of page markdown. Complementary to the Playwright capture —
 * screenshots and tokens still come from capture.ts.
 *
 * A failed HTTP/network/credential scrape is not the same fact as a 200 with
 * no markdown. Callers must not collapse the two.
 */
import { getSetting } from '@/lib/settings/resolve';

export const FIRECRAWL_EMPTY_IS_NOT_FAILURE = true;

export type FirecrawlFailReason =
  | 'missing_key'
  | 'unauthorized'
  | 'rate_limit'
  | 'http'
  | 'network'
  | 'timeout';

export type FirecrawlScrapeOk = {
  ok: true;
  markdown: string;
};

export type FirecrawlScrapeFailed = {
  ok: false;
  reason: FirecrawlFailReason;
  status?: number;
  detail?: string;
};

export type FirecrawlScrapeResult = FirecrawlScrapeOk | FirecrawlScrapeFailed;

function scrubSecrets(value: string) {
  return value
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/fc-[A-Za-z0-9_-]+/g, '[redacted]');
}

function failureFromStatus(status: number): FirecrawlScrapeFailed {
  if (status === 401 || status === 403) {
    return { ok: false, reason: 'unauthorized', status };
  }
  if (status === 429) {
    return { ok: false, reason: 'rate_limit', status };
  }
  return { ok: false, reason: 'http', status };
}

export function firecrawlFailureMessage(failure: FirecrawlScrapeFailed): string {
  switch (failure.reason) {
    case 'missing_key':
      return 'We could not read the page text — Firecrawl is not configured. Ask an administrator to add a Firecrawl key, then try the import again.';
    case 'unauthorized':
      return `We could not read the page text — Firecrawl returned ${failure.status ?? 401}. Ask an administrator to check the Firecrawl key, then try the import again.`;
    case 'rate_limit':
      return `We could not read the page text — Firecrawl rate-limited this request (${failure.status ?? 429}). Wait a minute and try the import again.`;
    case 'timeout':
      return 'We could not read the page text — the request to Firecrawl timed out. Try the import again.';
    case 'network': {
      const detail = failure.detail ? scrubSecrets(failure.detail) : 'network error';
      return `We could not read the page text — we could not reach Firecrawl (${detail}). Try the import again.`;
    }
    case 'http':
      return failure.status
        ? `We could not read the page text — Firecrawl returned ${failure.status}. Try the import again in a few minutes.`
        : 'We could not read the page text — Firecrawl did not return page text. Try the import again.';
  }
}

export async function scrapeFirecrawlText(
  url: string,
  opts?: { fetchImpl?: typeof fetch; apiKey?: string | null },
): Promise<FirecrawlScrapeResult> {
  const apiKey = (
    opts?.apiKey !== undefined ? opts.apiKey : await getSetting('tooling.firecrawl.apiKey')
  )?.trim();
  if (!apiKey) {
    return { ok: false, reason: 'missing_key' };
  }
  const fetchImpl = opts?.fetchImpl ?? fetch;
  try {
    // Trusted host — do not route through safeFetch.
    const response = await fetchImpl('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url,
        formats: ['markdown'],
        waitFor: 2000,
        timeout: 20000,
        blockAds: true,
        maxAge: 3600000,
      }),
    });
    if (!response.ok) {
      return failureFromStatus(response.status);
    }
    let data: { success?: boolean; data?: { markdown?: string } };
    try {
      data = (await response.json()) as { success?: boolean; data?: { markdown?: string } };
    } catch {
      return {
        ok: false,
        reason: 'http',
        status: response.status,
        detail: 'Firecrawl returned a response we could not read',
      };
    }
    if (data.success === false) {
      return {
        ok: false,
        reason: 'http',
        status: response.status,
        detail: 'Firecrawl reported the scrape did not succeed',
      };
    }
    return { ok: true, markdown: data.data?.markdown?.trim() || '' };
  } catch (error) {
    const detail = scrubSecrets(error instanceof Error ? error.message : String(error ?? 'network error'));
    if (/timeout|timed out|aborted/i.test(detail)) {
      return { ok: false, reason: 'timeout', detail };
    }
    return { ok: false, reason: 'network', detail };
  }
}
