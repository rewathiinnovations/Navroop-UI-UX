import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { ensureSandbox, getSandboxStatus, SandboxBootError } from '@/lib/sandbox/manager';
import { errorPayload } from '@/lib/api/error-response';
import { withRequest } from '@/lib/api/with-request';

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
  return withRequest(request, () => getSandbox(params));
}

async function getSandbox(params: Promise<{ id: string }>) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Sign in required' }, { status: 401 });

  const { id } = await params;
  const project = await loadProject(id);
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  const status = await getSandboxStatus(id);
  if (!status) return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  return NextResponse.json(status);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return withRequest(request, () => postSandbox(params));
}

async function postSandbox(params: Promise<{ id: string }>) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Sign in required' }, { status: 401 });

  const { id } = await params;
  const project = await loadProject(id);
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  try {
    const result = await ensureSandbox(id);
    return NextResponse.json({
      sandboxId: result.sandboxId,
      previewUrl: result.previewUrl,
      wasColdStarted: result.wasColdStarted,
      requestId: result.requestId,
      status: result.status,
    });
  } catch (error) {
    const boot = error instanceof SandboxBootError ? error : null;
    if (boot?.code === 'SANDBOX_LIMIT') {
      return NextResponse.json(
        { reason: 'sandboxes', used: 0, limit: 0, message: boot.message },
        { status: 402 },
      );
    }
    const body = errorPayload(
      error instanceof Error ? error.message : 'Failed to start sandbox',
      boot?.code || 'SANDBOX_FAILED',
      boot?.requestId,
    );
    return NextResponse.json(
      { ...body, step: boot?.step, status: 'FAILED' },
      { status: boot?.code === 'NO_CHECKPOINT' ? 409 : 500 },
    );
  }
}
