import { NextRequest, NextResponse } from 'next/server';
import { previewCheckpoint } from '@/lib/checkpoints/actions';
import { actionError } from '@/lib/projects/http';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; checkpointId: string }> },
) {
  const { id, checkpointId } = await params;
  const result = await previewCheckpoint(id, checkpointId);
  if (!result.ok) return actionError(result);
  return NextResponse.json({ checkpoint: result.data });
}
