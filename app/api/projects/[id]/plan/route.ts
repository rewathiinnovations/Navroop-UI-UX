import { NextRequest, NextResponse } from 'next/server';
import { getLatestPlan } from '@/lib/projects/plan';
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
