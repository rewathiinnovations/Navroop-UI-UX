import { NextRequest, NextResponse } from 'next/server';
import { withRequest } from '@/lib/api/with-request';
import { jsonError } from '@/lib/api/error-response';
import { previewSaveAsTemplate, saveProjectAsTemplate } from '@/lib/templates/actions';
import { templateActionError } from '@/lib/templates/http';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  return withRequest(request, async () => {
    const projectId = request.nextUrl.searchParams.get('projectId') || '';
    if (!projectId) return jsonError('projectId is required', 'VALIDATION', 400);
    const result = await previewSaveAsTemplate(projectId);
    if (!result || !result.ok) return templateActionError(result);
    return NextResponse.json(result.data);
  });
}

export async function POST(request: NextRequest) {
  return withRequest(request, async () => {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const projectId = String(body.projectId || '');
    if (!projectId) return jsonError('projectId is required', 'VALIDATION', 400);
    const result = await saveProjectAsTemplate(projectId, {
      name: String(body.name || ''),
      description: String(body.description || ''),
      category: String(body.category || ''),
      prompt: String(body.prompt || ''),
    });
    if (!result || !result.ok) return templateActionError(result);
    return NextResponse.json(result.data);
  });
}
