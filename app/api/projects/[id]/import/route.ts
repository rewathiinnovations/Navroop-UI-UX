import { NextRequest } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { importJobErrorCode } from '@/lib/import/errors';
import { resolveImportMode } from '@/lib/import/mode';
import { runProjectUrlImport } from '@/lib/import/run';
import { normalizeSourceUrl } from '@/lib/import/url';
import { looksLikeUrl } from '@/lib/projects/prompt';
import { creditDeniedJson } from '@/lib/plans/http';
import { checkCredits } from '@/lib/plans/limits';
import { WORKSPACE_ROW_ID } from '@/lib/storage/usage';
import { assertSafeUrl, UnsafeUrlError } from '@/lib/security/url-guard';
import { errorPayload } from '@/lib/api/error-response';
import { acquireLock, beginLockHeartbeat, releaseLock } from '@/lib/projects/lock';
import { lockConflictJson } from '@/lib/projects/lock-http';
import { beginJobHeartbeat, createOrReuseJob, failJob, markJobRunning, succeedJob } from '@/lib/jobs/lifecycle';
import { ensureJobSettled } from '@/lib/jobs/settle';
import { updateJobFields } from '@/lib/jobs/store';
import { getRequestId } from '@/lib/request-context';
import { log } from '@/lib/logger';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getSessionUser();
  if (!user) {
    return Response.json({ error: 'Sign in required' }, { status: 401 });
  }

  const { id } = await params;
  const project = await prisma.project.findFirst({
    where: { id, deletedAt: null },
    include: { importSource: true },
  });
  if (!project) {
    return Response.json({ error: 'Project not found' }, { status: 404 });
  }
  if (user.id !== project.ownerId && user.role !== 'ADMIN') {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const sourceUrl = normalizeSourceUrl(
    String(body.sourceUrl || project.importSource?.sourceUrl || project.initialPrompt || ''),
  );
  if (!looksLikeUrl(sourceUrl)) {
    return Response.json({ error: 'A source URL is required' }, { status: 400 });
  }
  try {
    await assertSafeUrl(sourceUrl, { userId: user.id });
  } catch (error) {
    const message = error instanceof UnsafeUrlError ? error.message : 'Import failed';
    return Response.json({ error: message }, { status: 400 });
  }
  const mode = resolveImportMode(body.mode ?? project.importSource?.mode);

  const credits = await checkCredits(WORKSPACE_ROW_ID, user.id, 'import');
  if (!credits.ok) return creditDeniedJson(credits);

  const lock = await acquireLock(project.id, user.id, 'import');
  if (!lock.ok) return lockConflictJson(lock);
  const heartbeat = beginLockHeartbeat(project.id, user.id);
  const importJob = await createOrReuseJob({
    projectId: project.id,
    workspaceId: WORKSPACE_ROW_ID,
    userId: user.id,
    kind: 'IMPORT',
    inputPrompt: sourceUrl,
    requestId: getRequestId(),
  });
  if (importJob.status === 'QUEUED') {
    await markJobRunning(importJob.id, { chargeCredits: true, acquireProjectLock: false });
  }
  await updateJobFields(importJob.id, {
    currentStep: 'import',
    steps: [
      { key: 'import', label: 'Importing the site', status: 'running', startedAt: new Date().toISOString() },
    ],
  });
  // A live heartbeat hides the row from the staleness reaper. Tie it to the request so a
  // client that disconnects stops vouching for work nobody is reading.
  const jobHeartbeat = beginJobHeartbeat(importJob.id, { signal: request.signal });

  const encoder = new TextEncoder();
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();
  let clientDisconnected = false;
  let clientDisconnectReason: string | null = null;
  const noteClientDisconnected = (reason: string) => {
    if (clientDisconnected) return;
    clientDisconnected = true;
    clientDisconnectReason = reason;
  };
  if (request.signal.aborted) {
    noteClientDisconnected('request was already aborted when streaming started');
  }
  request.signal.addEventListener('abort', () => noteClientDisconnected('request aborted'), {
    once: true,
  });
  const clientGone = new Promise<void>((resolve) => {
    if (request.signal.aborted) {
      resolve();
      return;
    }
    request.signal.addEventListener('abort', () => resolve(), { once: true });
  });

  const send = async (data: Record<string, unknown>) => {
    if (clientDisconnected) return;
    const written = writer
      .write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
      .catch((error: unknown) =>
        noteClientDisconnected(error instanceof Error ? error.message : String(error)),
      );
    await Promise.race([written, clientGone]);
  };

  void (async () => {
    try {
      const result = await Promise.race([
        runProjectUrlImport({
          projectId: project.id,
          userId: user.id,
          sourceUrl,
          mode,
          stack: project.stack,
          designDirection: project.designDirection,
          jobId: importJob.id,
          onProgress: (message) => {
            void send({ type: 'progress', message });
          },
        }),
        clientGone.then(() => null),
      ]);
      if (clientDisconnected || !result) return;
      await succeedJob(importJob.id);
      await send({
        type: 'complete',
        filesXml: result.filesXml,
        warnings: result.warnings,
        usedFallback: result.usedFallback,
        sourceUrl: result.sourceUrl,
        mode: result.mode,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Import failed';
      await failJob(importJob.id, { errorCode: importJobErrorCode(error), errorMessage: message });
      await send({ type: 'error', ...errorPayload(message, 'IMPORT_FAILED') });
    } finally {
      jobHeartbeat.stop();
      heartbeat.stop();
      await ensureJobSettled(importJob.id, {
        errorCode: 'client_disconnected',
        errorMessage: clientDisconnectReason
          ? `Client disconnected before the import finished (${clientDisconnectReason})`
          : 'Client disconnected before the import finished',
      });
      await releaseLock(project.id, user.id);
      void writer.close().catch(() => undefined);
    }
  })().catch((error: unknown) => {
    log.error('import.detached_work_failed', {
      jobId: importJob.id,
      error: error instanceof Error ? error.message : String(error),
    });
  });

  return new Response(stream.readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
