import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser, requireSessionUser } from '@/lib/auth';
import { jsonError } from '@/lib/api/error-response';
import { withRequest } from '@/lib/api/with-request';
import { searchProjects } from '@/lib/search/projects';
import { creditDeniedJson } from '@/lib/plans/http';
import { checkCredits, consumeCredits } from '@/lib/plans/limits';
import { trackFailure } from '@/lib/observability/track';
import { WORKSPACE_ROW_ID } from '@/lib/storage/usage';
import { WEB_SEARCH_RATE_LIMIT_MESSAGE, allowWebSearch } from '@/lib/search/rate-limit';

/** The fields this route forwards from a Firecrawl `/v1/search` hit. */
type FirecrawlSearchHit = {
  url: string;
  title?: string;
  description?: string;
  screenshot?: string;
  markdown?: string;
};

export async function GET(request: NextRequest) {
  return withRequest(request, async () => {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: 'Sign in required' }, { status: 401 });

    const q = request.nextUrl.searchParams.get('q') ?? '';
    const projects = await searchProjects({ q, limit: 20 });
    return NextResponse.json({
      projects: projects.map((row) => ({
        id: row.id,
        name: row.name,
        snippet: row.snippet,
        status: row.status,
        phase: row.phase,
        updatedAt: row.updatedAt,
      })),
    });
  });
}

export async function POST(req: NextRequest) {
  const auth = await requireSessionUser();
  if (!auth.user) return jsonError(auth.error, 'UNAUTHORIZED', auth.status);

  try {
    const { query } = await req.json();

    if (!query) {
      return NextResponse.json({ error: 'Query is required' }, { status: 400 });
    }

    // The one paid third-party call in this file: 10 results, each scraped for
    // markdown *and* a screenshot. Unlimited, any signed-in member could loop it
    // and spend the operator's Firecrawl balance with nothing recorded anywhere
    // (F-319). Charged after validation so a malformed body does not burn a slot.
    if (!allowWebSearch(auth.user.id).allowed) {
      return NextResponse.json({ error: WEB_SEARCH_RATE_LIMIT_MESSAGE }, { status: 429 });
    }

    // ...and metered, so the spend appears on /admin/usage attributed to whoever
    // caused it. `CREDIT_COSTS` had no entry for search at all, which is why an
    // unbounded Firecrawl bill belonged to nobody.
    const credits = await checkCredits(WORKSPACE_ROW_ID, auth.user.id, 'search');
    if (!credits.ok) return creditDeniedJson(credits);

    // Use Firecrawl search to get top 10 results with screenshots
    // Trusted host — do not route through safeFetch.
    const searchResponse = await fetch('https://api.firecrawl.dev/v1/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}`,
      },
      body: JSON.stringify({
        query,
        limit: 10,
        scrapeOptions: {
          formats: ['markdown', 'screenshot'],
          onlyMainContent: true,
        },
      }),
    });

    if (!searchResponse.ok) {
      throw new Error('Search failed');
    }

    // Debited after the call succeeded: a refused or broken Firecrawl request costs
    // the operator nothing, so it must not cost the member either. A failed debit is
    // provider spend nobody was billed for and leaves no other trace, so it is
    // tracked rather than swallowed — and never rethrown over a good response.
    try {
      await consumeCredits(WORKSPACE_ROW_ID, auth.user.id, 'search');
    } catch (error) {
      trackFailure('credits.search_debit_failed', error, {
        action: 'search',
        userId: auth.user.id,
      });
    }

    // `Response.json()` is `any`, so the shape has to be named here or nothing
    // downstream is checked — see the `catch` below, which is the only thing that
    // was standing behind a missing field.
    const searchData = (await searchResponse.json()) as { data?: FirecrawlSearchHit[] };

    // Format results with screenshots and markdown
    const results =
      searchData.data?.map((result) => ({
        url: result.url,
        title: result.title || result.url,
        description: result.description || '',
        screenshot: result.screenshot || null,
        markdown: result.markdown || '',
      })) || [];

    return NextResponse.json({ results });
  } catch (error) {
    console.error('Search error:', error);
    return NextResponse.json({ error: 'Failed to perform search' }, { status: 500 });
  }
}
