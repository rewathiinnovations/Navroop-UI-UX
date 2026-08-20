import { NextRequest, NextResponse } from 'next/server';
import { getCheckpoints } from '@/lib/checkpoints/actions';
import { actionError } from '@/lib/projects/http';

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await getCheckpoints(id);
  if (!result.ok) return actionError(result);
  // `previewingCheckpointId` travels with the list so a page that has just loaded knows it
  // is showing an older version (F-102). It used to be client-only state, which a reload
  // discarded while the project stayed rolled back.
  return NextResponse.json({
    checkpoints: result.data,
    previewingCheckpointId: result.previewingCheckpointId,
  });
}
