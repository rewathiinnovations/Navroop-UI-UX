import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { withRequest } from '@/lib/api/with-request';
import { getPreviewStatus } from '@/lib/preview/status';
import { publicPreviewViewHref } from '@/lib/preview/public-view';
import { issuePreviewToken } from '@/lib/preview/token';

/**
 * Both verbs are readers of the project, and any signed-in member may read: the
 * project list shows every member every project, and `BrowserPreview` renders a
 * teammate's site in the reader's own tab with no token at all.
 *
 * What is not a read is *minting* a preview token. The `/preview-view?projectId=&token=`
 * href it returns is an anonymous, two-hour capability over the project's files
 * (`GET /api/projects/[id]/preview-files` and the public shell). That is owner/ADMIN
 * only (F-148): a member who can read the project still cannot hand its site to the
 * world. So `loadProject` fetches `ownerId`, `POST action:'token'` refuses a
 * non-owner, and the status read omits the URL it may not mint rather than refusing
 * the whole read.
 */
async function loadProject(id: string) {
  return prisma.project.findFirst({
    where: { id, deletedAt: null },
    select: { id: true, ownerId: true },
  });
}

function mayMintPreview(user: { id: string; role: string }, ownerId: string) {
  return user.id === ownerId || user.role === 'ADMIN';
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

  const status = await getPreviewStatus(id, {
    userId: user.id,
    mayMint: mayMintPreview(user, project.ownerId),
  });
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
    if (!mayMintPreview(user, project.ownerId)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    const token = issuePreviewToken({ projectId: id, userId: user.id });
    return NextResponse.json({
      token,
      previewUrl: publicPreviewViewHref({ projectId: id, token }),
    });
  }

  // 'heartbeat', 'live' and 'retry' are gone with the sandbox VMs. The live
  // preview is compiled and run in the user's browser from the project's
  // stored files, so there is nothing to keep warm, boot, or rebuild here.

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
