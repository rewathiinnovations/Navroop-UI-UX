import { NextRequest, NextResponse } from 'next/server';
import { refinePlan } from '@/lib/projects/plan';
import { actionError } from '@/lib/projects/http';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const result = await refinePlan(id, String(body.feedback ?? ''));
  if (!result.ok) return actionError(result);
  return NextResponse.json({ plan: result.data });
}
