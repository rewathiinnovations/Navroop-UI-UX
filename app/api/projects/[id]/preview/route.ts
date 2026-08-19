import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { withRequest } from '@/lib/api/with-request';
import { getPreviewStatus } from '@/lib/preview/status';
import { signedPreviewUrl } from '@/lib/preview/url';
import { issuePreviewToken } from '@/lib/preview/token';

/**
 * Both verbs are readers, and any signed-in member may use them.
 *
 * They were briefly owner/ADMIN-only, which closed a real hole — before that,
 * `POST action:'token'` minted a signed preview URL for ANY project id, and the
 * signature is the only thing `/preview-static` checks, so an authenticated user
 * could hand out anonymous access to a project they had nothing to do with.
 * But owner-only was the wrong boundary: the project list shows every member
 * every project and the workspace page renders for anyone signed in, so a member
 * opening a teammate's finished site got "Nothing to preview yet" over 85KB of
 * stored code. What actually matters is that a token is only ever minted for a
 * project the caller can already read, and is scoped to that project id.
 */
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
