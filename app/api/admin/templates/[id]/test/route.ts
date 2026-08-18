import { NextRequest, NextResponse } from 'next/server';
import { withRequest } from '@/lib/api/with-request';
import { adminTestTemplate } from '@/lib/templates/actions';
import { templateActionError } from '@/lib/templates/http';

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return withRequest(request, async () => {
    const { id } = await context.params;
    const result = await adminTestTemplate(id);
    if (!result || !result.ok) return templateActionError(result);
    return NextResponse.json(result.data);
  });
}
