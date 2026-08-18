import { NextRequest, NextResponse } from 'next/server';
import { withRequest } from '@/lib/api/with-request';
import { createFromTemplate } from '@/lib/templates/actions';
import { templateActionError } from '@/lib/templates/http';

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return withRequest(request, async () => {
    const { id } = await context.params;
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const result = await createFromTemplate(id, {
      prompt: typeof body.prompt === 'string' ? body.prompt : undefined,
      name: typeof body.name === 'string' ? body.name : undefined,
    });
    if (!result || !result.ok) return templateActionError(result);
    return NextResponse.json(result.data);
  });
}
