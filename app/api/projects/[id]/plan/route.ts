import { NextRequest, NextResponse } from 'next/server';
import { getLatestPlan, retryFailedPlan, updatePlanContent } from '@/lib/projects/plan';
import { actionError } from '@/lib/projects/http';
import { readUserPrompt } from '@/lib/generation/user-prompt';

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await getLatestPlan(id);
  if (!result.ok) return actionError(result);
  return NextResponse.json({ plan: result.data });
}

/**
 * Saves a user's manual edits onto the PENDING plan. Builds read the approved
 * content, so editing before Approve changes what the build produces without
 * spending another plan generation (see `updatePlanContent`).
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const result = await updatePlanContent(id, {
    planId: typeof body.planId === 'string' ? body.planId : '',
    content: body.content,
  } as Parameters<typeof updatePlanContent>[1]);
  if (!result.ok) return actionError(result);
  return NextResponse.json({ plan: result.data });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  // Not `String(body.prompt ?? body.message ?? '')` — see F-011. Either key may carry the
  // prompt, but whichever it is has to be a usable string.
  const prompt = readUserPrompt(body.prompt ?? body.message);
  if (!prompt.ok) {
    return NextResponse.json({ error: prompt.message }, { status: 400 });
  }
  const result = await retryFailedPlan(id, prompt.prompt);
  if (!result.ok) return actionError(result);
  return NextResponse.json({ plan: result.data });
}
