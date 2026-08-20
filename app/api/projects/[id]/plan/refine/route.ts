import { NextRequest, NextResponse } from 'next/server';
import { refinePlan } from '@/lib/projects/plan';
import { actionError } from '@/lib/projects/http';
import { readUserPrompt } from '@/lib/generation/user-prompt';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  // Not `String(body.feedback ?? '')`: that turned `{}` into a paid plan generation on the
  // literal string "[object Object]", an array into its comma-joined elements, and `''`
  // into a generation on nothing (F-011).
  const feedback = readUserPrompt(body.feedback);
  if (!feedback.ok) {
    return NextResponse.json({ error: feedback.message }, { status: 400 });
  }
  const result = await refinePlan(id, feedback.prompt);
  if (!result.ok) return actionError(result);
  return NextResponse.json({ plan: result.data });
}
