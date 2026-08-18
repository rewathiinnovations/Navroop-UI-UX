import { NextRequest, NextResponse } from 'next/server';
import { deleteDeploymentAction, redeployAction, stopDeploymentAction } from '@/lib/publish/actions';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as { action?: unknown; confirmSlug?: unknown };
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
  if (body.action === 'delete') {
    const confirmSlug = typeof body.confirmSlug === 'string' ? body.confirmSlug : '';
    const result = await deleteDeploymentAction(id, confirmSlug);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result.data);
  }
  return NextResponse.json({ error: 'Unknown action' }, { status: 422 });
}
