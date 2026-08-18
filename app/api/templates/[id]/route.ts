import { NextRequest, NextResponse } from 'next/server';
import { withRequest } from '@/lib/api/with-request';
import { getTemplate } from '@/lib/templates/actions';
import { templateActionError } from '@/lib/templates/http';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return withRequest(request, async () => {
    const { id } = await context.params;
    const result = await getTemplate(id);
    if (!result || !result.ok) return templateActionError(result);
    return NextResponse.json(result.data);
  });
}
