import { NextRequest, NextResponse } from 'next/server';
import { createProject, listProjects, persistProjectGeneration } from '@/lib/projects/actions';
import {
  actionError,
  hasGenerationFields,
  readCreateInput,
  readGenerationInput,
} from '@/lib/projects/http';

export async function GET(request: NextRequest) {
  // Shared internal workspace: every authenticated member can LIST/GET every
  // non-deleted project. mine=true scopes to the current user's ownerId.
  // Shared with me = projects other people own = mine=false. Shared workspace, every member sees every project.
  const { searchParams } = request.nextUrl;
  const mineParam = searchParams.get('mine');
  const result = await listProjects({
    search: searchParams.get('search') ?? undefined,
    sort: searchParams.get('sort') ?? undefined,
    mine: mineParam === null ? undefined : mineParam === 'true',
    starred: searchParams.get('starred') === 'true',
  });
  if (!result.ok) return actionError(result);
  return NextResponse.json(result.data);
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const created = await createProject(readCreateInput(body));
  if (!created.ok) return actionError(created);

  const generation = readGenerationInput(body);

  if (hasGenerationFields(generation)) {
    const persisted = await persistProjectGeneration(created.data.id, generation);
    if (!persisted.ok) return actionError(persisted);
    return NextResponse.json({
      id: created.data.id,
      initialPrompt: created.data.initialPrompt,
      name: persisted.data.name,
      project: persisted.data,
    });
  }

  return NextResponse.json(created.data);
}
