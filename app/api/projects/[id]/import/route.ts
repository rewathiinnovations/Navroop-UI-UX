import { NextRequest } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { importJobErrorCode } from '@/lib/import/errors';
import { resolveImportMode } from '@/lib/import/mode';
import { persistImportedSite } from '@/lib/import/persist';
import { runProjectUrlImport } from '@/lib/import/run';
import { normalizeSourceUrl } from '@/lib/import/url';
import { looksLikeUrl } from '@/lib/projects/prompt';
import { creditDeniedJson } from '@/lib/plans/http';
import { checkCredits } from '@/lib/plans/limits';
import { WORKSPACE_ROW_ID } from '@/lib/storage/usage';
import { assertSafeUrl, UnsafeUrlError } from '@/lib/security/url-guard';
import { errorPayload } from '@/lib/api/error-response';
import { holdProjectLock } from '@/lib/projects/lock';
import { lockConflictJson } from '@/lib/projects/lock-http';
import {
  beginJobHeartbeat,
  createOrReuseJob,
  failJob,
  markJobRunning,
  succeedJob,
} from '@/lib/jobs/lifecycle';
import { ensureJobSettled } from '@/lib/jobs/settle';
import { updateJobFields } from '@/lib/jobs/store';
import { getRequestId } from '@/lib/request-context';
import { log } from '@/lib/logger';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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

  // `holdProjectLock`, not the acquire + heartbeat + release triple: `acquireLock` is
  // re-entrant for the same user, so a double-submitted import — or Retry import while
  // this user's generation still holds the project — takes ok: true without owning the
  // hold, and renewing or releasing then breaks the run that does own it (security
  // review NAV-03). The hold decides that once, for every call site.
  const hold = await holdProjectLock(project.id, user.id, 'import');
  if (!hold.ok) return lockConflictJson(hold);
  // Until the detached IIFE below (with its own finally) owns the cleanup, a throw in
  // here has to give the hold back itself. `markJobRunning` does throw: its conditional
  // UPDATE writes zero rows when the row was already settled, which a rolling deploy
  // causes for real — abandonInstanceJobs('deploying') settles the QUEUED IMPORT row this
  // request just inserted. The renew timer inside the hold is the dangerous half: it
  // pushes lockExpiresAt out every 60s, so the 15-minute TTL never fires and the project
  // stays locked for the life of the process.
  let importJob: Awaited<ReturnType<typeof createOrReuseJob>>;
  let jobHeartbeat: ReturnType<typeof beginJobHeartbeat>;
  try {
    importJob = await createOrReuseJob({
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
        {
          key: 'import',
          label: 'Importing the site',
          status: 'running',
          startedAt: new Date().toISOString(),
        },
      ],
    });
    // `request.signal` only reports the disconnect (`jobs.heartbeat_client_gone`): the
    // heartbeat deliberately keeps beating after an abort, because a closed tab means the
    // person navigated away, not that the import stopped. The work below runs to the end
    // and is stored either way, so the row has to keep looking alive until it settles.
    jobHeartbeat = beginJobHeartbeat(importJob.id, { signal: request.signal });
  } catch (error) {
    await hold.release();
    throw error;
  }

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
      // Not raced against `clientGone`. The import keeps running server-side after the
      // tab closes — nothing here can cancel Playwright or the model — so racing it only
      // decided that a finished, already-paid-for import got thrown away: the site was
      // never stored and the `finally` filed the row as ABANDONED. Each `send` still
      // races the abort, so no write can park on a reader that is gone.
      const result = await runProjectUrlImport({
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
      });
      // The site is stored here, before the job is allowed to succeed. An import
      // never reaches /api/generate-ai-code-stream — the workspace skips the
      // generation stream once the import produced filesXml — so nothing else on
      // the server writes Project.lastCode for this flow, and the browser's
      // terminal PATCH stopped carrying it. Storing before succeedJob also fixes
      // the ordering the checkpoint depends on: the client's later `ready` PATCH
      // snapshots from lastCode, which is only real if it was written first.
      // Throws IMPORT_NO_FILES_MESSAGE when the XML parses to nothing, so a blank
      // import fails as import_failed instead of succeeding with an empty site.
      await persistImportedSite({ projectId: project.id, filesXml: result.filesXml });
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
      await ensureJobSettled(importJob.id, {
        errorCode: 'client_disconnected',
        errorMessage: clientDisconnectReason
          ? `Client disconnected before the import finished (${clientDisconnectReason})`
          : 'Client disconnected before the import finished',
      });
      await hold.release();
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
