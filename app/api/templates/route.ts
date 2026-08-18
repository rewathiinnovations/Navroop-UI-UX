import { NextRequest, NextResponse } from 'next/server';
import { withRequest } from '@/lib/api/with-request';
import { listTemplates } from '@/lib/templates/actions';
import { templateActionError } from '@/lib/templates/http';
import type { TemplateSort } from '@/lib/templates/types';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  return withRequest(request, async () => {
    const { searchParams } = request.nextUrl;
    const sort = searchParams.get('sort');
    const result = await listTemplates({
      category: searchParams.get('category') ?? undefined,
      stack: searchParams.get('stack') ?? undefined,
      sort: sort === 'newest' || sort === 'popular' ? (sort as TemplateSort) : 'popular',
    });
    if (!result || !result.ok) return templateActionError(result);
    return NextResponse.json(result.data);
  });
}
