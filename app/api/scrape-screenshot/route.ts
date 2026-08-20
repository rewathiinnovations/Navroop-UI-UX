import { NextRequest, NextResponse } from 'next/server';
import FirecrawlApp from '@mendable/firecrawl-js';
import { assertSafeUrl, UnsafeUrlError } from '@/lib/security/url-guard';
import { fromUnknownError, jsonError } from '@/lib/api/error-response';
import { requireSessionUser } from '@/lib/auth';

/** The v3 response envelopes the v4 SDK types no longer describe. */
type LegacyScrapeEnvelope = {
  data?: { screenshot?: unknown; metadata?: unknown };
  success?: boolean;
  error?: unknown;
};

export async function POST(req: NextRequest) {
  const auth = await requireSessionUser();
  if (!auth.user) return jsonError(auth.error, 'UNAUTHORIZED', auth.status);

  try {
    const { url } = await req.json();

    if (!url) {
      return NextResponse.json({ error: 'URL is required' }, { status: 400 });
    }

    try {
      await assertSafeUrl(String(url));
    } catch (error) {
      const message = error instanceof UnsafeUrlError ? error.message : 'URL import failed';
      return NextResponse.json({ error: message }, { status: 400 });
    }

    // Initialize Firecrawl with API key from environment
    const apiKey = process.env.FIRECRAWL_API_KEY;

    if (!apiKey) {
      console.error('FIRECRAWL_API_KEY not configured');
      return NextResponse.json(
        {
          error: 'Firecrawl API key not configured',
        },
        { status: 500 },
      );
    }

    const app = new FirecrawlApp({ apiKey });

    console.log('[scrape-screenshot] Attempting to capture screenshot for:', url);
    console.log('[scrape-screenshot] Using Firecrawl API key:', apiKey ? 'Present' : 'Missing');

    // Use the new v4 scrape method (not scrapeUrl)
    const scrapeResult = await app.scrape(url, {
      formats: ['screenshot'], // Request screenshot format
      waitFor: 3000, // Wait for page to fully load
      timeout: 30000,
      onlyMainContent: false, // Get full page for screenshot
      actions: [
        {
          type: 'wait',
          milliseconds: 2000, // Additional wait for dynamic content
        },
      ],
    });

    console.log('[scrape-screenshot] Full scrape result:', JSON.stringify(scrapeResult, null, 2));
    console.log('[scrape-screenshot] Scrape result type:', typeof scrapeResult);
    console.log('[scrape-screenshot] Scrape result keys:', Object.keys(scrapeResult));

    // Firecrawl v4's `scrape` resolves to a Document with `screenshot`/`metadata` at
    // the top level. The two fallbacks below are the v3 envelopes — `{ data: { … } }`
    // and `{ success: false, error }` — which the SDK type no longer declares but a
    // mismatched API version still returns. Narrowing through `unknown` keeps the
    // fallbacks working without an `any` that would also hide a real typo.
    const legacy = scrapeResult as unknown as LegacyScrapeEnvelope;

    // The Firecrawl v4 API might return data directly without a success flag
    // Check if we have data with screenshot
    if (scrapeResult && scrapeResult.screenshot) {
      // Direct screenshot response
      return NextResponse.json({
        success: true,
        screenshot: scrapeResult.screenshot,
        metadata: scrapeResult.metadata || {},
      });
    } else if (typeof legacy.data?.screenshot === 'string') {
      // Nested v3 data structure
      return NextResponse.json({
        success: true,
        screenshot: legacy.data.screenshot,
        metadata: legacy.data.metadata || {},
      });
    } else if (legacy.success === false) {
      // Explicit failure
      console.error('[scrape-screenshot] Firecrawl API error:', legacy.error);
      throw new Error(
        typeof legacy.error === 'string' ? legacy.error : 'Failed to capture screenshot',
      );
    } else {
      // No screenshot in response
      console.error(
        '[scrape-screenshot] No screenshot in response. Full response:',
        JSON.stringify(scrapeResult, null, 2),
      );
      throw new Error(
        'Screenshot not available in response - check console for full response structure',
      );
    }
  } catch (error: unknown) {
    // `fromUnknownError` logs the real message under the request id and returns a
    // fixed sentence. This handler used to forward `error.message` to the browser,
    // which is the leak F-079 removed from the helper — Firecrawl errors echo the
    // request metadata, and a fetch failure names the upstream host.
    return fromUnknownError(error, 'Failed to capture screenshot', 'SCREENSHOT_FAILED');
  }
}
