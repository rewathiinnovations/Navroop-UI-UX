import { NextRequest, NextResponse } from 'next/server';
import { approvePlan } from '@/lib/projects/plan';
import { actionError } from '@/lib/projects/http';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as { idempotencyKey?: string };
  const result = await approvePlan(id, { idempotencyKey: body.idempotencyKey });
  if (!result.ok) return actionError(result);
  return NextResponse.json(result.data);
}
