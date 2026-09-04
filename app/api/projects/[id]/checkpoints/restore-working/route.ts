import { NextRequest, NextResponse } from 'next/server';
import { restoreLastWorkingCheckpoint } from '@/lib/checkpoints/actions';
import { actionError } from '@/lib/projects/http';

/**
 * Called by the workspace when the auto-fix loop has spent its attempts and the site still
 * does not validate. It answers with what it did — including "nothing", which is the honest
 * answer when no earlier version can be proven to work and the alternative would be swapping
 * one broken state for another.
 */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await restoreLastWorkingCheckpoint(id);
  if (!result || !('ok' in result) || !result.ok) return actionError(result);
  return NextResponse.json({ restored: result.restored ?? null, reason: result.reason ?? null });
}
