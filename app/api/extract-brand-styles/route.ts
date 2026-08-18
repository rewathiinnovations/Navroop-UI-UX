import { NextRequest, NextResponse } from 'next/server';
import { assertSafeUrl, UnsafeUrlError } from '@/lib/security/url-guard';
import { jsonError } from '@/lib/api/error-response';
import { requireSessionUser } from '@/lib/auth';

export async function POST(request: NextRequest) {
  const auth = await requireSessionUser();
  if (!auth.user) return jsonError(auth.error, 'UNAUTHORIZED', auth.status);

  try {
    const body = await request.json();
    const url = body.url;
    const prompt = body.prompt;

    if (!url) {
      return NextResponse.json({ success: false, error: 'URL is required' }, { status: 400 });
    }
    try {
      await assertSafeUrl(String(url));
    } catch (error) {
      const message = error instanceof UnsafeUrlError ? error.message : 'URL import failed';
      return NextResponse.json({ success: false, error: message }, { status: 400 });
    }

    console.log('[extract-brand-styles] Extracting brand styles for:', url);
    console.log('[extract-brand-styles] User prompt:', prompt);

    // Call Firecrawl API to extract branding information
    const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY;

    if (!FIRECRAWL_API_KEY) {
      console.error('[extract-brand-styles] No Firecrawl API key found');
      throw new Error('Firecrawl API key not configured');
    }

    console.log('[extract-brand-styles] Calling Firecrawl branding API for:', url);

    // Trusted host — do not route through safeFetch.
    const firecrawlResponse = await fetch('https://api.firecrawl.dev/v2/scrape', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${FIRECRAWL_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: url,
        formats: ['branding'],
      }),
    });

    if (!firecrawlResponse.ok) {
      const errorText = await firecrawlResponse.text();
      console.error('[extract-brand-styles] Firecrawl API error:', firecrawlResponse.status, errorText);
      throw new Error(`Firecrawl API returned ${firecrawlResponse.status}`);
    }

    const firecrawlData = await firecrawlResponse.json();
    console.log('[extract-brand-styles] Firecrawl response received successfully');

    // Extract branding data from response
    const brandingData = firecrawlData.data?.branding || firecrawlData.branding;

    if (!brandingData) {
      console.error('[extract-brand-styles] No branding data in Firecrawl response');
      console.log('[extract-brand-styles] Response structure:', JSON.stringify(firecrawlData, null, 2));
      throw new Error('No branding data in Firecrawl response');
    }

    console.log('[extract-brand-styles] Successfully extracted branding data');

    // Return the branding data
    return NextResponse.json({
      success: true,
      url,
      styleName: brandingData.name || url,
      guidelines: brandingData,
    });

  } catch (error) {
    console.error('[extract-brand-styles] Error occurred:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to extract brand styles'
      },
      { status: 500 }
    );
  }
}
