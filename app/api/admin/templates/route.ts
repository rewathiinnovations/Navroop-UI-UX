import { NextRequest, NextResponse } from 'next/server';
import { withRequest } from '@/lib/api/with-request';
import { adminCreateTemplate, adminListTemplates } from '@/lib/templates/actions';
import { templateActionError } from '@/lib/templates/http';
import type { TemplateSort } from '@/lib/templates/types';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  return withRequest(request, async () => {
    const { searchParams } = request.nextUrl;
    const sort = searchParams.get('sort');
    const result = await adminListTemplates({
      category: searchParams.get('category') ?? undefined,
      stack: searchParams.get('stack') ?? undefined,
      sort: sort === 'newest' || sort === 'popular' ? (sort as TemplateSort) : 'newest',
    });
    if (!result.ok) return templateActionError(result);
    return NextResponse.json(result.data);
  });
}

export async function POST(request: NextRequest) {
  return withRequest(request, async () => {
    const body = await request.json().catch(() => ({}));
    const result = await adminCreateTemplate(body);
    if (!result.ok) return templateActionError(result);
    return NextResponse.json(result.data);
  });
}
