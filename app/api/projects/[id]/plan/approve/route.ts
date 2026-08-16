import { NextRequest, NextResponse } from 'next/server';
import { approvePlan } from '@/lib/projects/plan';
import { actionError } from '@/lib/projects/http';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const result = await approvePlan(id);
  if (!result.ok) return actionError(result);
  return NextResponse.json(result.data);
}
