import { NextRequest, NextResponse } from 'next/server';
import { exitCheckpointPreview } from '@/lib/checkpoints/actions';
import { actionError } from '@/lib/projects/http';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const result = await exitCheckpointPreview(id);
  if (!result.ok) return actionError(result);
  return NextResponse.json({ checkpoint: result.data });
}
