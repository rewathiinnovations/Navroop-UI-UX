import { NextRequest, NextResponse } from 'next/server';
import { deleteProjectAsset, updateProjectAssetAlt } from '@/lib/assets/actions';
import { actionError } from '@/lib/projects/http';

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; assetId: string }> },
) {
  const { id, assetId } = await params;
  const body = (await request.json()) as { altText?: string };
  const result = await updateProjectAssetAlt(id, assetId, String(body.altText || ''));
  if (!result.ok) return actionError(result);
  return NextResponse.json({ asset: result.data });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; assetId: string }> },
) {
  const { id, assetId } = await params;
  const result = await deleteProjectAsset(id, assetId);
  if (!result.ok) return actionError(result);
  return NextResponse.json({ ok: true });
}
