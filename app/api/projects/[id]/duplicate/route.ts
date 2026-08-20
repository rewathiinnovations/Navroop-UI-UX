import { NextRequest, NextResponse } from 'next/server';
import { duplicateProject } from '@/lib/projects/actions';
import { actionError } from '@/lib/projects/http';

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await duplicateProject(id);
  if (!result.ok) return actionError(result);
  // The dashboard card's shape (`ListProject`), not the row. The copy now carries the
  // whole duplicated site in `lastCode` (F-805), which has no business crossing the wire
  // to a project tile that renders a name and a thumbnail.
  const project = result.data;
  return NextResponse.json({
    project: {
      id: project.id,
      name: project.name,
      thumbnailUrl: project.thumbnailUrl,
      status: project.status,
      phase: project.phase,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      ownerId: project.ownerId,
      owner: { name: project.owner.name },
      previewUrl: project.previewUrl,
    },
  });
}
