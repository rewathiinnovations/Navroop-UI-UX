import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { withRequest } from '@/lib/api/with-request';
import { getPreviewStatus } from '@/lib/preview/status';
import { signedPreviewUrl } from '@/lib/preview/url';
import { issuePreviewToken } from '@/lib/preview/token';

async function loadProject(id: string) {
  return prisma.project.findFirst({
    where: { id, deletedAt: null },
    select: { id: true },
  });
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withRequest(request, () => getPreview(params));
}

async function getPreview(params: Promise<{ id: string }>) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Sign in required' }, { status: 401 });

  const { id } = await params;
  const project = await loadProject(id);
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  const status = await getPreviewStatus(id, user.id);
  if (!status) return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  return NextResponse.json(status);
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withRequest(request, () => postPreview(request, params));
}

async function postPreview(request: NextRequest, params: Promise<{ id: string }>) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Sign in required' }, { status: 401 });

  const { id } = await params;
  const project = await loadProject(id);
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  const body = (await request.json().catch(() => ({}))) as {
    action?: string;
    enabled?: boolean;
    path?: string;
  };
  const action = body.action || 'token';

  if (action === 'token') {
    const token = issuePreviewToken({ projectId: id, userId: user.id });
    const previewUrl = await signedPreviewUrl({
      projectId: id,
      userId: user.id,
      path: typeof body.path === 'string' ? body.path : '/',
    });
    return NextResponse.json({ token, previewUrl });
  }

  // 'heartbeat', 'live' and 'retry' are gone with the sandbox VMs. The live
  // preview is compiled and run in the user's browser from the project's
  // stored files, so there is nothing to keep warm, boot, or rebuild here.

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
