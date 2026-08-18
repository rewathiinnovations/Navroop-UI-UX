import { NextRequest, NextResponse } from 'next/server';
import { deleteCoolifyServer, forceDeactivateServer, updateCoolifyServer } from '@/lib/coolify/server-actions';
import { actionError } from '@/lib/team/http';

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  if (body.forceDeactivate === true) {
    const result = await forceDeactivateServer(id);
    if (!result.ok) return actionError(result);
    return NextResponse.json(result.data);
  }
  const result = await updateCoolifyServer(id, {
    isActive: typeof body.isActive === 'boolean' ? body.isActive : undefined,
    maxDeployments: typeof body.maxDeployments === 'number' ? body.maxDeployments : undefined,
  });
  if (!result.ok) return actionError(result);
  return NextResponse.json(result.data);
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const result = await deleteCoolifyServer(id);
  if (!result.ok) return actionError(result);
  return NextResponse.json(result.data);
}
