import { NextRequest, NextResponse } from 'next/server';
import { requestFollowUpPlan } from '@/lib/projects/plan';
import { actionError } from '@/lib/projects/http';
import { readUserPrompt } from '@/lib/generation/user-prompt';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  // Not `String(body.message ?? '')` — see F-011. Validate, never coerce, and refuse before
  // the action spends anything.
  const message = readUserPrompt(body.message);
  if (!message.ok) {
    return NextResponse.json({ error: message.message }, { status: 400 });
  }
  const result = await requestFollowUpPlan(id, message.prompt, request.signal);
  if (!result.ok) return actionError(result);
  return NextResponse.json({ plan: result.data });
}
