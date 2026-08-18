import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser, requireSessionUser } from '@/lib/auth';
import { jsonError } from '@/lib/api/error-response';
import { withRequest } from '@/lib/api/with-request';
import { searchProjects } from '@/lib/search/projects';

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

    // Use Firecrawl search to get top 10 results with screenshots
    // Trusted host — do not route through safeFetch.
    const searchResponse = await fetch('https://api.firecrawl.dev/v1/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.FIRECRAWL_API_KEY}`,
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

    const searchData = await searchResponse.json();
    
    // Format results with screenshots and markdown
    const results = searchData.data?.map((result: any) => ({
      url: result.url,
      title: result.title || result.url,
      description: result.description || '',
      screenshot: result.screenshot || null,
      markdown: result.markdown || '',
    })) || [];

    return NextResponse.json({ results });
  } catch (error) {
    console.error('Search error:', error);
    return NextResponse.json(
      { error: 'Failed to perform search' },
      { status: 500 }
    );
  }
}