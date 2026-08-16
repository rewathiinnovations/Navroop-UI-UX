import { NextRequest, NextResponse } from 'next/server';
import { restoreProject } from '@/lib/projects/actions';
import { actionError } from '@/lib/projects/http';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const result = await restoreProject(id);
  if (!result.ok) return actionError(result);
  return NextResponse.json({ project: result.data });
}
