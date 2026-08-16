import { NextRequest, NextResponse } from 'next/server';
import { pushProjectToGitHub } from '@/lib/github/actions';

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as { projectId?: string };
  const projectId = String(body.projectId || '').trim();
  if (!projectId) {
    return NextResponse.json({ error: 'projectId is required' }, { status: 400 });
  }
  const result = await pushProjectToGitHub(projectId);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json(result.data);
}
