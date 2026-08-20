import { NextRequest, NextResponse } from 'next/server';
import { jsonError } from '@/lib/api/error-response';
import { requireSessionUser } from '@/lib/auth';
import { analyzeEditIntent } from '@/lib/generation/analyze-edit-intent';

export async function POST(request: NextRequest) {
  const auth = await requireSessionUser();
  if (!auth.user) return jsonError(auth.error, 'UNAUTHORIZED', auth.status);

  let body: { prompt?: unknown; manifest?: unknown; model?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const result = await analyzeEditIntent({
    prompt: body.prompt,
    manifest: body.manifest,
    model: typeof body.model === 'string' ? body.model : undefined,
    userId: auth.user.id,
  });

  if (!result.ok) {
    return NextResponse.json({ success: false, error: result.error }, { status: result.status });
  }

  return NextResponse.json({ success: true, searchPlan: result.searchPlan });
}
