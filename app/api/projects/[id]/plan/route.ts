import { NextRequest, NextResponse } from 'next/server';
import { getLatestPlan, retryFailedPlan } from '@/lib/projects/plan';
import { actionError } from '@/lib/projects/http';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const result = await getLatestPlan(id);
  if (!result.ok) return actionError(result);
  return NextResponse.json({ plan: result.data });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const result = await retryFailedPlan(id, String(body.prompt ?? body.message ?? ''));
  if (!result.ok) return actionError(result);
  return NextResponse.json({ plan: result.data });
}

