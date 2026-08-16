import { NextRequest, NextResponse } from 'next/server';
import { getCheckpoints } from '@/lib/checkpoints/actions';
import { actionError } from '@/lib/projects/http';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const result = await getCheckpoints(id);
  if (!result.ok) return actionError(result);
  return NextResponse.json({ checkpoints: result.data });
}
