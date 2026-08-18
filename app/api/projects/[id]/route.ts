import { NextRequest, NextResponse } from 'next/server';
import {
  deleteProject,
  getProject,
  persistProjectGeneration,
  updateProject,
} from '@/lib/projects/actions';
import { actionError, hasGenerationFields, readGenerationInput } from '@/lib/projects/http';
import { isProductStatus } from '@/lib/projects/schema';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const result = await getProject(id);
  if (!result.ok) return actionError(result);
  if (!result.data) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }
  return NextResponse.json({ project: result.data });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

  const name = typeof (body.name ?? body.title) === 'string' ? String(body.name ?? body.title) : undefined;
  const productStatus = isProductStatus(body.status) ? body.status : undefined;
  const wantsProductUpdate = name !== undefined || productStatus !== undefined;

  if (wantsProductUpdate) {
    const updated = await updateProject(id, { name, status: productStatus });
    if (!updated.ok) return actionError(updated);
  }

  const generation = readGenerationInput(body);
  if (hasGenerationFields(generation)) {
    const persisted = await persistProjectGeneration(id, generation);
    if (!persisted.ok) return actionError(persisted);
    return NextResponse.json({
      project: persisted.data,
      previewNotice: persisted.previewNotice ?? null,
    });
  }

  if (wantsProductUpdate) {
    const latest = await getProject(id);
    if (!latest.ok) return actionError(latest);
    if (!latest.data) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }
    return NextResponse.json({ project: latest.data });
  }

  return NextResponse.json({ error: 'Validation failed', details: [{ message: 'Provide name and/or status' }] }, { status: 400 });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const result = await deleteProject(id);
  if (!result.ok) return actionError(result);
  return NextResponse.json({ success: true });
}
