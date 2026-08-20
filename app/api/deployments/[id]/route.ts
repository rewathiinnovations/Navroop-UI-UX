import { NextRequest, NextResponse } from 'next/server';
import {
  deleteDeploymentAction,
  listDeploymentReleasesAction,
  redeployAction,
  rollbackDeploymentAction,
  stopDeploymentAction,
} from '@/lib/publish/actions';

/** The releases this deployment can be rolled back to (F-264). Owner-gated in the action. */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await listDeploymentReleasesAction(id);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json(result.data);
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as {
    action?: unknown;
    confirmSlug?: unknown;
    targetSha?: unknown;
    confirmation?: unknown;
  };
  if (body.action === 'stop') {
    const result = await stopDeploymentAction(id);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result.data);
  }
  if (body.action === 'redeploy') {
    const result = await redeployAction(id);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result.data);
  }
  if (body.action === 'rollback') {
    const result = await rollbackDeploymentAction(
      id,
      typeof body.targetSha === 'string' ? body.targetSha : '',
      typeof body.confirmation === 'string' ? body.confirmation : '',
    );
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result.data);
  }
  if (body.action === 'delete') {
    const confirmSlug = typeof body.confirmSlug === 'string' ? body.confirmSlug : '';
    const result = await deleteDeploymentAction(id, confirmSlug);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result.data);
  }
  return NextResponse.json({ error: 'Unknown action' }, { status: 422 });
}
