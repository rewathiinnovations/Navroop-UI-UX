import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { ensureSandbox, SandboxBootError, touchSandbox } from '@/lib/sandbox/manager';
import { withRequest } from '@/lib/api/with-request';
import { errorPayload } from '@/lib/api/error-response';
import { getPreviewStatus } from '@/lib/preview/status';
import { buildPreviewForProject } from '@/lib/preview/production';
import { signedPreviewUrl } from '@/lib/preview/url';
import { issuePreviewToken } from '@/lib/preview/token';

async function loadProject(id: string) {
  return prisma.project.findFirst({
    where: { id, deletedAt: null },
    select: { id: true },
  });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
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

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
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

  if (action === 'heartbeat') {
    await touchSandbox(id);
    return NextResponse.json({ ok: true });
  }

  if (action === 'live') {
    if (body.enabled === false) {
      return NextResponse.json({ ok: true, enabled: false });
    }
    try {
      const result = await ensureSandbox(id);
      await touchSandbox(id);
      return NextResponse.json({
        ok: true,
        enabled: true,
        previewUrl: result.previewUrl,
        status: result.status,
      });
    } catch (error) {
      const boot = error instanceof SandboxBootError ? error : null;
      return NextResponse.json(
        errorPayload(
          error instanceof Error ? error.message : 'Failed to start live preview',
          boot?.code || 'SANDBOX_FAILED',
          boot?.requestId,
        ),
        { status: boot?.code === 'NO_CHECKPOINT' ? 409 : 500 },
      );
    }
  }

  if (action === 'retry') {
    const latest = await prisma.checkpoint.findFirst({
      where: { projectId: id },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (!latest) {
      return NextResponse.json({ error: 'No saved version to preview' }, { status: 409 });
    }
    const result = await buildPreviewForProject(id, latest.id);
    if ('skipped' in result && result.skipped) {
      return NextResponse.json(
        { error: 'A live sandbox is required to retry the preview build', skipped: true },
        { status: 409 },
      );
    }
    return NextResponse.json(result);
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
