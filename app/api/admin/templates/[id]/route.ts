import { NextRequest, NextResponse } from 'next/server';
import { withRequest } from '@/lib/api/with-request';
import { adminDeleteTemplate, adminUpdateTemplate } from '@/lib/templates/actions';
import { templateActionError } from '@/lib/templates/http';

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return withRequest(request, async () => {
    const { id } = await context.params;
    const body = await request.json().catch(() => ({}));
    const result = await adminUpdateTemplate(id, body);
    if (!result.ok) return templateActionError(result);
    return NextResponse.json(result.data);
  });
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return withRequest(request, async () => {
    const { id } = await context.params;
    const result = await adminDeleteTemplate(id);
    if (!result.ok) return templateActionError(result);
    return NextResponse.json(result.data);
  });
}
