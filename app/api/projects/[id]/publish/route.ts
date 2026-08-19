import { after } from 'next/server';
import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/db';
import type { DeploymentKind } from '@/generated/prisma';
import { getMissingIntegrations } from '@/lib/integrations/store';
import { publishBlockedMessage } from '@/lib/integrations/messages';
import { getPublishState, startPublish } from '@/lib/publish/actions';
import { DEFAULT_WORKSPACE_ID } from '@/lib/publish/constants';
import { assertPublishSlot, PublishLimitError, publishLimitPayload } from '@/lib/publish/limits';
import { runPublishJob } from '@/lib/publish/execute';
import { startPublishJob, PublishSetupError } from '@/lib/publish/publish';
import { jsonError } from '@/lib/api/error-response';
import { log } from '@/lib/logger';
import { holdProjectLock } from '@/lib/projects/lock';
import { lockConflictJson } from '@/lib/projects/lock-http';

export const maxDuration = 600;

function parseKind(value: unknown): DeploymentKind | null {
  return value === 'LIVE' || value === 'PREVIEW' ? value : null;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
  const { id } = await params;
  const kind = parseKind(request.nextUrl.searchParams.get('kind'));
  const result = await getPublishState(id);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  if (kind) {
    return NextResponse.json({
      ...result.data,
      deployment: result.data.deployments.find((row) => row.kind === kind) ?? null,
    });
  }
  return NextResponse.json(result.data);
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as { kind?: unknown };
  const kind = parseKind(body.kind);
  if (!kind) return NextResponse.json({ error: 'kind must be PREVIEW or LIVE' }, { status: 422 });

  const project = await prisma.project.findFirst({
    where: { id, deletedAt: null },
    select: { ownerId: true },
  });
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  if (project.ownerId !== user.id && user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const missing = await getMissingIntegrations(DEFAULT_WORKSPACE_ID);
  const setupMessage = publishBlockedMessage(missing, user.role === 'ADMIN');
  if (setupMessage) {
    return NextResponse.json(
      { error: setupMessage, missingIntegrations: missing },
      { status: 409 },
    );
  }

  try {
    await assertPublishSlot({ workspaceId: DEFAULT_WORKSPACE_ID, projectId: id, kind });
  } catch (error) {
    if (error instanceof PublishLimitError) {
      return NextResponse.json(
        { reason: error.reason, used: error.used, limit: error.limit, message: error.message },
        { status: 402 },
      );
    }
    throw error;
  }

  const hold = await holdProjectLock(id, user.id, 'publish');
  if (!hold.ok) return lockConflictJson(hold);

  const run = async () => {
    try {
      const started = await startPublishJob({ projectId: id, kind, userId: user.id });
      await runPublishJob(started.jobId);
    } finally {
      await hold.release();
    }
  };

  try {
    after(() =>
      run().catch((error) => {
        log.warn('publish.route_failed', {
          id,
          kind,
          error: error instanceof Error ? error.message : String(error),
        });
      }),
    );
  } catch {
    // `after` is unavailable outside a request scope, so nothing will ever run `run` — or
    // its `finally`. Hand the lock back before the fallback tries to take it: left held,
    // that call would re-enter our own hold, own nothing, release nothing, and strand the
    // project until the TTL expires.
    await hold.release();
    void startPublish(id, kind);
  }

  const state = await getPublishState(id);
  if (!state.ok) return NextResponse.json({ error: state.error }, { status: state.status });
  return NextResponse.json(state.data);
}

export function publishErrorResponse(error: unknown) {
  const limit = publishLimitPayload(error);
  if (limit) return NextResponse.json(limit, { status: 402 });
  if (error instanceof PublishLimitError) {
    return NextResponse.json(
      { reason: error.reason, used: error.used, limit: error.limit, message: error.message },
      { status: 402 },
    );
  }
  if (error instanceof PublishSetupError) {
    return NextResponse.json(
      { error: error.message, missingIntegrations: error.missing },
      { status: 409 },
    );
  }
  return jsonError(
    error instanceof Error ? error.message : 'Publish failed',
    'PUBLISH_FAILED',
    500,
  );
}
