import { NextRequest, NextResponse } from 'next/server';
import { streamText } from 'ai';
import type { ConversationMessage, ConversationEdit } from '@/types/conversation';
import { appConfig } from '@/config/app.config';
import { buildUiUxProMaxBrief } from '@/lib/ui-ux-pro-max/build-design-brief';
import { looksLikeUrl } from '@/lib/projects/prompt';
import { attachGenerationInputTokens, logGenerationEvent } from '@/lib/usage-costs';
import { buildCachedMessages } from '@/lib/generation/prompt-cache';
import { filesFromReply, replaceBlockInReply } from '@/lib/generation/parse-blocks';
import { wrapUserRequest } from '@/lib/generation/user-prompt';
import { intakeGenerationRequest } from '@/lib/generation/intake';

/** Markdown code fence, kept in a constant so prompt strings stay readable. */
const FENCE = '```';
import { conversationStateFor } from '@/lib/generation/conversation-state';
import { shouldSendGeneratedCode } from '@/lib/generation/complete-frame';
import { StreamedFileTracker } from '@/lib/generation/stream-file-tracker';
import { fileContextTokenCap, selectFileContext } from '@/lib/generation/selective-context';
import { buildStablePromptPrefix, buildVolatilePromptSuffix } from '@/lib/stack-prompts';
import { resolveRequestGenerationProfile } from '@/lib/stack-resolve';
import { stackShapeMismatch } from '@/lib/stacks';
import { loadAssetManifest } from '@/lib/assets/load-manifest';
import { injectMatchedSkills } from '@/lib/skills/inject';
import { buildMemoryBlock } from '@/lib/memory/build-context';
import { WORKSPACE_ROW_ID } from '@/lib/storage/usage';
import { jsonError } from '@/lib/api/error-response';
import { withRequest } from '@/lib/api/with-request';
import { prisma } from '@/lib/db';
import { getCurrentProjectFiles } from '@/lib/github/current-files';
import { log, logError } from '@/lib/logger';
import { trackFailure, trackStart, trackSuccess } from '@/lib/observability/track';
import { LOCK_LOST_MESSAGE, ProjectLockLostError } from '@/lib/projects/lock';
import {
  beginJobHeartbeat,
  createOrReuseJob,
  failJob,
  markJobRunning,
  succeedJob,
} from '@/lib/jobs/lifecycle';
import { settleStreamedGeneration, type StreamSettleResult } from '@/lib/jobs/settle-generation';
import { applyOutcome } from '@/lib/jobs/copy';
import { createProgressBatcher, type ProgressBatcher } from '@/lib/jobs/progress';
import { ensureJobSettled } from '@/lib/jobs/settle';
import { recordJobStepFailure } from '@/lib/jobs/step-failure';
import { getJob, updateJobFields } from '@/lib/jobs/store';
import { toPublicJob } from '@/lib/jobs/types';
import { getRequestId } from '@/lib/request-context';
import { JobCapError, JobCapTracker } from '@/lib/consumption/caps';
import { getPlanCaps } from '@/lib/consumption/plan-caps';
import { recordJobUsage } from '@/lib/consumption/record';
import { RunUsage } from '@/lib/consumption/run-usage';
import { temperatureForModel } from '@/lib/ai/temperature';
import { isToolCallValidationError } from '@/lib/ai/tool-validation';
import { getDefaultCircuit } from '@/lib/ai/circuit';
import { jobErrorCodeForProviderFailure, providerFailureMessage } from '@/lib/ai/failover';
import { getDefaultProviderQueue, QUEUE_TIMEOUT_MESSAGE } from '@/lib/ai/queue';
import {
  maxOutputTokensForEntry,
  modelIdForEntry,
  NO_PROVIDER_CONFIGURED_MESSAGE,
  providerConcurrency,
  providerDisplayName,
  ProviderNotConfiguredError,
  requireUsableProviderChain,
  type ProviderEntry,
} from '@/lib/ai/providers';
import { loadEffectiveProviderEnv } from '@/lib/ai/effective-env';
import { clientForEntry } from '@/lib/ai/client-for-entry';
import {
  bindStreamErrorCapture,
  EmptyCompletionError,
  surfaceStreamFailure,
} from '@/lib/ai/empty-completion';
import { sanitizeGenerationPath } from '@/lib/generation/parse-files';
import {
  collectRecoveredStreamText,
  detectTruncatedFiles,
  truncationRecoveryOutcome,
  type TruncationRecoveryOutcome,
} from '@/lib/generation/truncation-recovery';
import {
  executeWithCompletionFailover,
  ProviderRunError,
  type ProviderAttempt,
} from '@/lib/ai/run';
import {
  attemptProducedOutput,
  classifyReplyOutcome,
  describeNoChanges,
  MISSING_FILES_ASKED_AGAIN,
  MISSING_FILES_CORRECTION,
  MISSING_FILES_STEP_ERROR,
} from '@/lib/generation/no-changes';
import { summarizeGenerationOutput } from '@/lib/generation/output-summary';
import { runBuildValidation } from '@/lib/validation/run-build-validation';

/**
 * The three fields the prompt builder reads off `context.conversationContext
 * .scrapedWebsites[]`. The request body arrives from `request.json()`, so `context`
 * is `any` until F-743 gives the whole payload one schema; naming the element shape
 * here is what makes these three reads checked rather than assumed.
 */
type ScrapedWebsiteContext = {
  url?: string;
  timestamp?: string | number;
  content?: unknown;
};

// Force dynamic route to enable streaming
export const dynamic = 'force-dynamic';
/**
 * Kept in step with `JOB_TIMEOUT_MS` (lib/jobs/poll.ts), which is 20 minutes: the platform
 * bound and the job's own hard timeout must agree, or one of them silently wins. The route
 * had no `maxDuration` at all while the import route next door set 300 (F-030). Next
 * requires a literal here, so `tests/unit/provider-rest-and-stall.test.ts` asserts the two
 * numbers still match.
 */
export const maxDuration = 1200;

/**
 * How much of a fileless reply is echoed back to the model on the corrective ask.
 *
 * Enough for it to see the claim it made; short enough that a reply which ran to tens of
 * thousands of output tokens is not bought a second time as input.
 */
const CORRECTIVE_ECHO_CHARS = 2000;

// Helper function to analyze user preferences from conversation history
function analyzeUserPreferences(messages: ConversationMessage[]): {
  commonPatterns: string[];
  preferredEditStyle: 'targeted' | 'comprehensive';
} {
  const userMessages = messages.filter((m) => m.role === 'user');
  const patterns: string[] = [];

  // Count edit-related keywords
  let targetedEditCount = 0;
  let comprehensiveEditCount = 0;

  userMessages.forEach((msg) => {
    const content = msg.content.toLowerCase();

    // Check for targeted edit patterns
    if (content.match(/\b(update|change|fix|modify|edit|remove|delete)\s+(\w+\s+)?(\w+)\b/)) {
      targetedEditCount++;
    }

    // Check for comprehensive edit patterns
    if (content.match(/\b(rebuild|recreate|redesign|overhaul|refactor)\b/)) {
      comprehensiveEditCount++;
    }

    // Extract common request patterns
    if (content.includes('hero')) patterns.push('hero section edits');
    if (content.includes('header')) patterns.push('header modifications');
    if (content.includes('color') || content.includes('style')) patterns.push('styling changes');
    if (content.includes('button')) patterns.push('button updates');
    if (content.includes('animation')) patterns.push('animation requests');
  });

  return {
    commonPatterns: [...new Set(patterns)].slice(0, 3), // Top 3 unique patterns
    preferredEditStyle: targetedEditCount > comprehensiveEditCount ? 'targeted' : 'comprehensive',
  };
}

/**
 * Reports a terminal job write that failed, instead of discarding it.
 *
 * The chat's busy state follows the job row, so a lost settle is a build that hangs: the
 * input stays locked and the building indicator keeps spinning until the 20-minute hard
 * timeout. `.catch(() => undefined)` kept the `finally` from throwing and threw the
 * diagnosis away with it — the symptom then looked identical to a wedged producer.
 *
 * Never throws, so a settle failure cannot replace the error the caller is already
 * unwinding with, and cannot skip the rest of the cleanup.
 */
async function reportSettleFailure(input: {
  jobId: string;
  intended: 'succeeded' | 'failed';
  error: unknown;
}): Promise<void> {
  const detail = input.error instanceof Error ? input.error.message : String(input.error);
  const summary = `Could not record the final job status (${input.intended}): ${detail}`;
  try {
    log.error('generation.settle_write_failed', {
      jobId: input.jobId,
      intended: input.intended,
      error: detail,
    });
    // Puts it in front of a human: the workspace recovery panel and /admin/jobs both read
    // job steps. Never throws.
    await recordJobStepFailure(input.jobId, {
      key: 'settle-job',
      label: 'Record the final job status',
      error: summary,
    });
    // A much simpler write than succeedJob's raw-SQL phase update, so it can still land
    // when that one could not — and it reports its own verdict either way.
    const outcome = await ensureJobSettled(input.jobId, {
      errorCode: 'settle_write_failed',
      errorMessage: summary,
    });
    log.warn('generation.settle_write_fallback', { jobId: input.jobId, outcome });
  } catch (reportError) {
    // The reporters are documented as non-throwing; if that ever stops being true, say so
    // rather than losing the original failure.
    console.error(
      '[generate-ai-code-stream] Failed to report a lost settle:',
      summary,
      reportError,
    );
  }
}

async function recordProviderAttempts(jobId: string, attempts: ProviderAttempt[]) {
  if (attempts.length === 0) return;
  const current = await getJob(jobId);
  await updateJobFields(jobId, {
    resourceIds: {
      ...(current?.resourceIds ?? {}),
      providerAttempts: attempts,
    },
  });
}

export async function POST(request: NextRequest) {
  return withRequest(request, () => generateAiCodeStream(request));
}

async function generateAiCodeStream(request: NextRequest) {
  const startedAt = Date.now();
  let releaseGenerationLock: (() => Promise<void>) | null = null;
  let generationJob: Awaited<ReturnType<typeof createOrReuseJob>> | null = null;
  let jobHeartbeat: { stop: () => void } | null = null;
  let jobProgress: ProgressBatcher | null = null;
  let providerSlot: ReturnType<ReturnType<typeof getDefaultProviderQueue>['acquire']> | null = null;
  // Everything the setup region acquires — job heartbeat, provider-queue slot, job row,
  // project lock — released in one place, in reverse acquisition order. Every underlying
  // release is idempotent (heartbeat.stop and slot.release are flag-guarded, the job
  // settle only touches a QUEUED/RUNNING row, LockHold.release is a no-op the second
  // time), so any exit path may call this without coordinating with the others. Nothing
  // is buffered in jobProgress before the stream worker starts, and once that worker
  // starts its own `finally` owns this cleanup — no path reaches here again (F-001).
  let setupReleased = false;
  const releaseSetup = async (
    settle: { errorCode: string; errorMessage: string; tokensOut?: number } | null,
  ) => {
    if (setupReleased) return;
    setupReleased = true;
    jobHeartbeat?.stop();
    providerSlot?.release();
    // `settle: null` is the reused-job return: the row belongs to the run that is
    // already streaming, so this exit must not fail it.
    if (generationJob && settle) {
      try {
        await failJob(generationJob.id, settle);
      } catch (settleError) {
        await reportSettleFailure({
          jobId: generationJob.id,
          intended: 'failed',
          error: settleError,
        });
      }
    }
    await releaseGenerationLock?.();
  };
  try {
    const {
      prompt: promptInput,
      model: requestedModelRaw,
      context,
      isEdit = false,
      styleHint,
      projectId: requestProjectId,
      stack: requestStack,
      designDirection: requestDirection,
      idempotencyKey: requestIdempotencyKey,
      // Carried back by the client when this generation is a repair of a failed build
      // check, so the auto-fix policy can count attempts and spot a repeated failure
      // instead of looping on the same one.
      buildFixAttempt,
      buildFixSignature,
    } = await request.json();
    // Every guard that must clear before anything is acquired, in the order it must
    // clear it, now lives in one module rather than as a convention at the top of this
    // handler. On !ok nothing has been taken, so the response returns directly.
    const intake = await intakeGenerationRequest({
      promptInput,
      requestedModelRaw,
      requestProjectId,
      contextProjectId: context?.projectId,
    });
    if (!intake.ok) return intake.response;
    const { prompt, requestedModel, projectId, sessionUser, hold } = intake;
    releaseGenerationLock = hold.release;
    // Aborted the moment a renewal proves this hold is gone. A generation writes
    // `Project.lastCode` minutes after it takes the lock, so from that moment another run
    // may be writing the same row: this one has to stop and refuse to persist rather than
    // finish under a lock that no longer protects the write (F-730).
    const lockLost = hold.lost;

    const idempotencyKey =
      typeof requestIdempotencyKey === 'string' && requestIdempotencyKey.trim()
        ? requestIdempotencyKey.trim()
        : null;
    generationJob = await createOrReuseJob({
      projectId,
      workspaceId: WORKSPACE_ROW_ID,
      userId: sessionUser.id,
      kind: isEdit ? 'FOLLOWUP' : 'BUILD',
      // A non-empty string by construction — `readUserPrompt` at the top of the handler
      // is what makes that true. This used to be
      // `typeof prompt === 'string' ? prompt : null`, which quietly stored null for a
      // non-string request and left the recovery panel with nothing to retry (F-033).
      inputPrompt: prompt,
      idempotencyKey,
      requestId: getRequestId(),
    });
    if (
      generationJob &&
      (generationJob.status === 'RUNNING' || generationJob.status === 'SUCCEEDED')
    ) {
      await releaseSetup(null);
      return NextResponse.json({ job: toPublicJob(generationJob), reused: true });
    }
    let providerChain;
    let providerEnv: Record<string, string | undefined> = process.env;
    try {
      providerEnv = await loadEffectiveProviderEnv(sessionUser.id, process.env);
      providerChain = requireUsableProviderChain(providerEnv, { requestedModel });
    } catch (error) {
      const message =
        error instanceof ProviderNotConfiguredError
          ? error.message
          : NO_PROVIDER_CONFIGURED_MESSAGE;
      await releaseSetup({ errorCode: 'provider_not_configured', errorMessage: message });
      return jsonError(message, 'PROVIDER_NOT_CONFIGURED', 503);
    }

    // `providerEnv` carries the admin `ai.concurrency` value, so applying it
    // here is what makes the limit on /admin/config take effect on the next
    // build instead of at the next container restart.
    getDefaultProviderQueue().setConcurrency(providerConcurrency(providerEnv));

    const model = requestedModel ?? modelIdForEntry(providerChain[0]);
    const primaryProvider = providerChain[0];
    if (generationJob?.status === 'QUEUED' && primaryProvider) {
      providerSlot = getDefaultProviderQueue().acquire(primaryProvider.provider, {
        jobId: generationJob.id,
        onPosition: (n) => {
          void updateJobFields(generationJob!.id, { queuePosition: n });
        },
      });
      if (providerSlot.position > 0) {
        await updateJobFields(generationJob.id, { queuePosition: providerSlot.position });
      }
      const started = await providerSlot.started;
      if (!started.ok) {
        // The waiter timed out without ever taking a slot, and `release()` decrements the
        // running count unconditionally — dropping the handle here is what keeps every
        // cleanup path from corrupting the queue counter.
        providerSlot = null;
        await releaseSetup({
          errorCode: 'queue_timeout',
          errorMessage: started.errorMessage || QUEUE_TIMEOUT_MESSAGE,
        });
        return jsonError(started.errorMessage || QUEUE_TIMEOUT_MESSAGE, 'QUEUE_TIMEOUT', 429);
      }
    }
    if (generationJob?.status === 'QUEUED') {
      generationJob = await markJobRunning(generationJob.id, {
        chargeCredits: true,
        acquireProjectLock: false,
      });
      if (generationJob && primaryProvider) {
        await updateJobFields(generationJob.id, {
          queuePosition: 0,
          provider: primaryProvider.provider,
          model: primaryProvider.model,
        });
      }
    }
    // A live heartbeat hides the row from the staleness reaper, so it beats for exactly
    // as long as the work runs — including after the browser goes away, because the
    // stream finishes and persists server-side. `request.signal` only records the
    // disconnect (see JobHeartbeatOptions.signal); the interval stops when the work
    // settles or when the stream worker's `finally` runs. When a heartbeat write finds
    // the row already settled — Cancel / Start over flipped it — `onInactive` aborts the
    // in-flight provider stream so a cancelled build stops buying tokens (F-022).
    const jobCancelled = new AbortController();
    jobHeartbeat = generationJob
      ? beginJobHeartbeat(generationJob.id, {
          signal: request.signal,
          onInactive: () => jobCancelled.abort(new Error('The build was cancelled')),
        })
      : null;
    // Losing the project lock stops the run through the same controller, so the in-flight
    // provider stream unwinds exactly as a Cancel does and no more tokens are bought. What
    // the two mean is not the same, so the catch below reads `lockLost.aborted` to tell them
    // apart: a cancel was asked for, a lost lock is a failure that saved nothing (F-730).
    const abortForLockLoss = () => jobCancelled.abort(lockLost.reason);
    if (lockLost.aborted) abortForLockLoss();
    else lockLost.addEventListener('abort', abortForLockLoss, { once: true });
    jobProgress = generationJob ? createProgressBatcher(generationJob.id) : null;
    const planCaps = await getPlanCaps(WORKSPACE_ROW_ID);
    const capTracker = new JobCapTracker(planCaps);
    let servedProvider = primaryProvider?.provider ?? null;
    let servedModel = primaryProvider?.model ?? null;

    const generationProfile = await resolveRequestGenerationProfile({
      stack: requestStack,
      designDirection: requestDirection,
      projectId,
    });
    const projectStack = generationProfile.stack;
    const projectDirection = generationProfile.designDirection;

    trackStart('generation.start', {
      action: 'generation',
      stack: projectStack,
      workspaceId: WORKSPACE_ROW_ID,
      model,
    });
    log.info('generation.request', {
      isEdit,
      stack: projectStack,
      designDirection: projectDirection,
      model,
      fileCount: context?.currentFiles ? Object.keys(context.currentFiles).length : 0,
    });

    // The GenerationEvent this run's token spend belongs to, resolved now rather than at
    // settle time (F-749). `attachGenerationInputTokens` used to take a projectId and
    // write to whichever event was newest for it when the run finished — so a follow-up
    // that started while this run was streaming stole the count, or already carried one
    // and the count was dropped silently.
    let usageEventId: string | null = null;
    if (isEdit) {
      usageEventId = await logGenerationEvent({
        projectId,
        userId: sessionUser.id,
        kind: 'followup',
        isUrlClone: looksLikeUrl(prompt),
      });
    } else {
      // A first build's event is written by `startInitialGeneration` in the request that
      // approved the plan, so this route never holds its id. Reading it here — before a
      // single token is spent — still pins the row: a generation that starts later cannot
      // be the one this picked, which is exactly the interleaving that used to misattribute.
      //
      // Build kinds only. `image` events are logged with no token count and never get one,
      // so "the newest event with no tokens" would happily hand a build's spend to an
      // image generated in between.
      const pending = await prisma.generationEvent.findFirst({
        where: {
          projectId,
          inputTokens: null,
          kind: { in: ['initial', 'followup'] },
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      usageEventId = pending?.id ?? null;
    }

    // Resolve this run's conversation state.
    //
    // Without project scoping the shared state carried the previous project's
    // "RECENTLY CREATED/EDITED FILES (DO NOT RECREATE)" list — Next.js app/
    // files — into a fresh REACT project's first build, and the model updated
    // that phantom tree instead of following the stack prompt. Everything below
    // reads `conversation`, never the global, so an overlapping request for
    // another project cannot swap this run's history out mid-stream.
    // The id resolved and required at the top of the handler, under the name the
    // file-context branches below read it by.
    const conversationProjectId = projectId;
    const conversation = conversationStateFor(conversationProjectId, sessionUser.id);
    log.info('generation.conversation_state', {
      requestId: getRequestId(),
      projectId: conversationProjectId,
      conversationId: conversation.conversationId,
      messages: conversation.context.messages.length,
    });
    // Add user message to conversation history
    // No `metadata`: the only field it ever carried was `sandboxId`, a leftover of the
    // deleted sandbox subsystem that is now always undefined (F-766).
    const userMessage: ConversationMessage = {
      id: `msg-${Date.now()}`,
      role: 'user',
      content: prompt,
      timestamp: Date.now(),
    };
    conversation.context.messages.push(userMessage);

    // Clean up old messages to prevent unbounded growth
    if (conversation.context.messages.length > 20) {
      // Keep only the last 15 messages
      conversation.context.messages = conversation.context.messages.slice(-15);
      console.log(
        '[generate-ai-code-stream] Trimmed conversation history to prevent context overflow',
      );
    }

    // Clean up old edits
    if (conversation.context.edits.length > 10) {
      conversation.context.edits = conversation.context.edits.slice(-8);
    }

    // No process-global publish here. The old unkeyed `global.*` conversation slot was a
    // single view overwritten on every request; its readers — checkpoint labels,
    // memory extraction, the follow-up plan context — now peek the per-project registry
    // (lib/generation/conversation-state.ts) with their own project id.

    // Debug: Show a sample of actual file content
    if (context?.currentFiles && Object.keys(context.currentFiles).length > 0) {
      const firstFile = Object.entries(context.currentFiles)[0];
      console.log('[generate-ai-code-stream] - sample file:', firstFile[0]);
      console.log(
        '[generate-ai-code-stream] - sample content preview:',
        typeof firstFile[1] === 'string' ? firstFile[1].substring(0, 100) + '...' : 'not a string',
      );
    }

    // Create a stream for real-time updates
    const encoder = new TextEncoder();
    const stream = new TransformStream();
    const writer = stream.writable.getWriter();

    // The client leaving is a fact the work loop has to be able to see. A swallowed write
    // failure is why generation kept burning tokens and credits for a reader that was gone.
    let clientDisconnected = false;
    let clientDisconnectReason: string | null = null;
    const noteClientDisconnected = (reason: string) => {
      if (clientDisconnected) return;
      clientDisconnected = true;
      clientDisconnectReason = reason;
      log.warn('generation.client_disconnected', {
        jobId: generationJob?.id ?? null,
        reason,
      });
    };
    if (request.signal.aborted) {
      noteClientDisconnected('request was already aborted when streaming started');
    }
    request.signal.addEventListener('abort', () => noteClientDisconnected('request aborted'), {
      once: true,
    });
    // A TransformStream writable has highWaterMark 1, so a reader that stops consuming but
    // is not yet torn down parks `writer.write` forever — and a parked producer never reaches
    // its `finally`. Racing each write against the abort is what lets it unwind.
    const clientGone = new Promise<void>((resolve) => {
      if (request.signal.aborted) {
        resolve();
        return;
      }
      request.signal.addEventListener('abort', () => resolve(), { once: true });
    });

    const writeChunk = async (chunk: Uint8Array) => {
      // The catch is attached before the race, so the write we walk away from cannot
      // surface later as an unhandled rejection.
      const written = writer
        .write(chunk)
        .catch((error: unknown) =>
          noteClientDisconnected(error instanceof Error ? error.message : String(error)),
        );
      await Promise.race([written, clientGone]);
    };

    // Function to send progress updates with flushing
    const sendProgress = async (data: Record<string, unknown>) => {
      if (clientDisconnected) return;
      await writeChunk(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      // Force flush by writing a keep-alive comment
      if (!clientDisconnected && (data.type === 'stream' || data.type === 'conversation')) {
        await writeChunk(encoder.encode(': keepalive\n\n'));
      }
    };

    // Start processing in background
    (async () => {
      // Every provider call this run makes adds to one accumulator: the main
      // stream, each failover attempt, the corrective ask, and each truncation
      // recovery. Declared out here so the catch below can record what a failed
      // run burned — a provider that took the prompt billed for it (F-027).
      const runUsage = new RunUsage();
      try {
        // Send initial status
        await sendProgress({ type: 'status', message: 'Initializing AI...' });

        // Build conversation context for system prompt
        let conversationContext = '';
        if (conversation.context.messages.length > 1) {
          console.log('[generate-ai-code-stream] Building conversation context');
          console.log(
            '[generate-ai-code-stream] Total messages:',
            conversation.context.messages.length,
          );
          console.log('[generate-ai-code-stream] Total edits:', conversation.context.edits.length);

          conversationContext = `\n\n## Conversation History (Recent)\n`;

          // Include only the last 3 edits to save context
          const recentEdits = conversation.context.edits.slice(-3);
          if (recentEdits.length > 0) {
            console.log(
              '[generate-ai-code-stream] Including',
              recentEdits.length,
              'recent edits in context',
            );
            conversationContext += `\n### Recent Edits:\n`;
            recentEdits.forEach((edit) => {
              conversationContext += `- "${edit.userRequest}" → ${edit.editType} (${edit.targetFiles.map((f) => f.split('/').pop()).join(', ')})\n`;
            });
          }

          // Include recently created files - CRITICAL for preventing duplicates
          const recentMsgs = conversation.context.messages.slice(-5);
          const recentlyCreatedFiles: string[] = [];
          recentMsgs.forEach((msg) => {
            if (msg.metadata?.editedFiles) {
              recentlyCreatedFiles.push(...msg.metadata.editedFiles);
            }
          });

          if (recentlyCreatedFiles.length > 0) {
            const uniqueFiles = [...new Set(recentlyCreatedFiles)];
            conversationContext += `\n### 🚨 RECENTLY CREATED/EDITED FILES (DO NOT RECREATE THESE):\n`;
            uniqueFiles.forEach((file) => {
              conversationContext += `- ${file}\n`;
            });
            conversationContext += `\nIf the user mentions any of these components, UPDATE the existing file!\n`;
          }

          // Include only last 5 messages for context (reduced from 10)
          const recentMessages = recentMsgs;
          if (recentMessages.length > 2) {
            // More than just current message
            conversationContext += `\n### Recent Messages:\n`;
            recentMessages.slice(0, -1).forEach((msg) => {
              // Exclude current message
              if (msg.role === 'user') {
                const truncatedContent =
                  msg.content.length > 100 ? msg.content.substring(0, 100) + '...' : msg.content;
                conversationContext += `- "${truncatedContent}"\n`;
              }
            });
          }

          // Include only last 2 major changes
          const majorChanges = conversation.context.projectEvolution.majorChanges.slice(-2);
          if (majorChanges.length > 0) {
            conversationContext += `\n### Recent Changes:\n`;
            majorChanges.forEach((change) => {
              conversationContext += `- ${change.description}\n`;
            });
          }

          // Keep user preferences - they're concise
          const userPrefs = analyzeUserPreferences(conversation.context.messages);
          if (userPrefs.commonPatterns.length > 0) {
            conversationContext += `\n### User Preferences:\n`;
            conversationContext += `- Edit style: ${userPrefs.preferredEditStyle}\n`;
          }

          // Limit total conversation context length
          if (conversationContext.length > 2000) {
            conversationContext =
              conversationContext.substring(0, 2000) +
              '\n[Context truncated to prevent length errors]';
          }
        }

        const uiUxBrief = buildUiUxProMaxBrief({
          prompt,
          styleHint: styleHint || context?.styleName || context?.conversationContext?.style,
          // The style the user actually picked. Without it the brief fell out of a
          // keyword tie onto STYLES[0] and shipped Glassmorphism to almost every
          // prompt (F-829).
          designDirection: projectDirection,
          isEdit,
        });

        const memoryProjectId =
          (typeof requestProjectId === 'string' && requestProjectId) ||
          (typeof context?.projectId === 'string' && context.projectId) ||
          '';
        let memoryBlock = '';
        if (memoryProjectId) {
          try {
            memoryBlock = (await buildMemoryBlock(memoryProjectId)).block;
          } catch (error) {
            console.warn('[memory] build block failed', error);
          }
        }
        // Stable prefix is byte-identical for the same stack + direction + ACTIVE memory.
        const stablePrefix = buildStablePromptPrefix(projectStack, projectDirection, {
          memoryBlock,
        });
        // Skills are conditional and sit AFTER the cacheable prefix, never inside it.
        const injectedSkills = await injectMatchedSkills(
          prompt,
          conversationContext || '',
          sessionUser.id,
        );
        if (injectedSkills.names.length > 0) {
          await sendProgress({ type: 'skills', names: injectedSkills.names });
        }
        const assetProjectId =
          (typeof requestProjectId === 'string' && requestProjectId) ||
          (typeof context?.projectId === 'string' && context.projectId) ||
          '';
        const assetManifest = await loadAssetManifest(assetProjectId || null);
        // The model call sends `stablePrefix` as the system message and this as the
        // volatile user turn (see buildCachedMessages), so the composed getStackPrompt
        // string has no reader here.
        const volatileSuffix = buildVolatilePromptSuffix({
          conversationContext,
          uiUxBrief,
          isEdit,
          assetManifest,
        });

        // There is one output contract, and it is the fenced `{path=…}` block that
        // `filesFromReply` parses. Morph Fast Apply used to compete with it by asking
        // for `<edit>` blocks that no applier ever consumed, so a follow-up edit
        // reported SUCCEEDED and left the project untouched; the feature is removed
        // (F-718). Do not add a second reply format without an applier for it.

        // Build full prompt with context.
        //
        // Entered when there is a project even if the client sent no `context` at all.
        // Gating the whole block on `context` was a second way a request could talk its
        // way out of the file load below: omit the object and the project's stored code
        // was never read, so the model was asked to satisfy the prompt with no sight of
        // the site it was about to overwrite. Request-supplied fields stay optional; the
        // project id is what decides whether this runs.
        // Wrapped, not spliced. The prompt used to be interpolated bare into instruction
        // text — inside quotes it could close, under a `USER REQUEST:` header it could
        // forge more of — next to the stack rules and the fenced-path output contract the
        // persist step depends on (F-009).
        let fullPrompt = wrapUserRequest(prompt);
        // Declared out here because the validation below needs the same map: a build check
        // over only the newly generated files reports a correct one-file edit as broken,
        // since every import into the rest of the project resolves to nothing.
        let backendFiles: Record<string, string> = {};
        if (context || conversationProjectId) {
          const contextParts = [];

          // No "Current sandbox ID" line: the sandbox subsystem is gone, so `context.sandboxId`
          // is always absent and the branch only ever told the model about a VM that would not
          // exist if it did fire (F-766).

          if (context?.structure) {
            contextParts.push(`Current file structure:\n${context.structure}`);
          }

          // The project's files come from its row. This used to read a
          // server-global cache that a sandbox kept in sync; nothing writes
          // that cache any more, so every edit found no files and fell through
          // to FIRST GENERATION MODE below — the model never saw the site it
          // was being asked to change, and rewrote it from scratch instead.
          //
          // Loading per project also settles the hazard the cache had: it was
          // never scoped, so a REACT initial build once inherited the previous
          // NEXTJS project's app/ tree as "EXISTING APPLICATION" context and
          // edited that instead of following the stack prompt.
          //
          // Loaded whenever there is a project, NOT only when the client says
          // `isEdit`. `isEdit` is a client hint, and a client that got it wrong
          // (or forged it) used to skip this read, land in FIRST GENERATION MODE
          // below, and have the model rewrite a project that already had stored
          // code from scratch. The row is the authority on whether a site
          // exists: with files loaded, `else if (!hasBackendFiles)` can no
          // longer reach first-generation mode, and a genuinely new project
          // still finds nothing here and still gets it.
          backendFiles = {};
          if (conversationProjectId) {
            const projectFilesRow = await prisma.project.findFirst({
              where: { id: conversationProjectId, deletedAt: null },
              select: { lastCode: true },
            });
            if (projectFilesRow) backendFiles = getCurrentProjectFiles(projectFilesRow);
            log.info('generation.project_files_loaded', {
              requestId: getRequestId(),
              projectId: conversationProjectId,
              fileCount: Object.keys(backendFiles).length,
            });
          }
          const hasBackendFiles = Object.keys(backendFiles).length > 0;

          console.log('[generate-ai-code-stream] - File count:', Object.keys(backendFiles).length);

          // Show the model the files it is being asked to change.
          if (hasBackendFiles) {
            contextParts.push('\nEXISTING APPLICATION - TARGETED EDIT REQUIRED');
            contextParts.push(
              '\nYou MUST analyze the user request and determine which specific file(s) to edit.',
            );
            // Selection reads `backendFiles` directly. It used to have a second
            // path that pulled contents out of a FileManifest, but a manifest only
            // ever came from a sandbox sync, and the branch that built one was
            // unreachable (F-026) — so the hints below are the whole of it.
            const recentPaths = conversation.context.edits
              .flatMap((edit) => edit.targetFiles || [])
              .slice(-12);
            const selected = selectFileContext({
              files: backendFiles,
              userMessage: prompt,
              recentlyModifiedPaths: recentPaths,
              tokenCap: await fileContextTokenCap(),
            });
            console.log(
              `[generate-ai-code-stream] Selective context: ${selected.fullPaths.length} full, ${selected.pathOnly.length} path-only, ~${selected.estimatedTokens} tokens`,
            );
            contextParts.push(selected.formatted);
            contextParts.push(
              '\nEdit only the files required. Path-only entries are listed for orientation — do not regenerate them.',
            );
          } else if (context?.currentFiles && Object.keys(context.currentFiles).length > 0) {
            console.log(
              '[generate-ai-code-stream] Warning: Backend cache empty, using selective frontend files',
            );
            contextParts.push('\nEXISTING APPLICATION - DO NOT REGENERATE FROM SCRATCH');
            const recentPaths = conversation.context.edits
              .flatMap((edit) => edit.targetFiles || [])
              .slice(-12);
            const selected = selectFileContext({
              files: context.currentFiles as Record<string, string>,
              userMessage: prompt,
              recentlyModifiedPaths: recentPaths,
              tokenCap: await fileContextTokenCap(),
            });
            contextParts.push(selected.formatted);
            contextParts.push(
              '\nThe listed full files already exist. Generate ONLY files that must change.',
            );
          }

          // Add explicit edit mode indicator
          if (isEdit) {
            contextParts.push('\nEDIT MODE ACTIVE');
            contextParts.push('This is an incremental update to an existing application.');
            contextParts.push(
              'DO NOT regenerate App.jsx, index.css, or other core files unless explicitly requested.',
            );
            contextParts.push(
              "ONLY create or modify the specific files needed for the user's request.",
            );
            contextParts.push('\nFILE OUTPUT FORMAT — every file in its own fenced block:');
            contextParts.push(`${FENCE}tsx{path=src/components/ComponentName.tsx}`);
            contextParts.push('// Complete file content here');
            contextParts.push(FENCE);
            contextParts.push('Never list file names as plain text outside a fence.');
            contextParts.push('Include every file you changed, with its complete contents.');
          } else if (!hasBackendFiles) {
            // First generation mode - make it beautiful!
            contextParts.push('\n🎨 FIRST GENERATION MODE - CREATE SOMETHING BEAUTIFUL!');
            contextParts.push("\nThis is the user's FIRST experience. Make it impressive:");
            contextParts.push('1. **USE TAILWIND PROPERLY** - Use standard Tailwind color classes');
            contextParts.push('2. **NO PLACEHOLDERS** - Use real content, not lorem ipsum');
            contextParts.push(
              '3. **COMPLETE COMPONENTS** - Header, Hero, Features, Footer minimum',
            );
            contextParts.push('4. **VISUAL POLISH** - Shadows, hover states, transitions');
            contextParts.push(
              '5. **STANDARD CLASSES** - bg-white, text-gray-900, bg-blue-500, NOT bg-background',
            );
            contextParts.push(
              '\nCreate a polished, professional application that works perfectly on first load.',
            );
            contextParts.push('\nOUTPUT FORMAT:');
            contextParts.push(
              `Every file in its own path-tagged fence: ${FENCE}tsx{path=src/App.tsx}`,
            );
            contextParts.push('Never list file names as plain text outside a fence.');
          }

          // Add conversation context (scraped websites, etc)
          if (context?.conversationContext) {
            if (context.conversationContext.scrapedWebsites?.length > 0) {
              contextParts.push('\nScraped Websites in Context:');
              context.conversationContext.scrapedWebsites.forEach((site: ScrapedWebsiteContext) => {
                contextParts.push(`\nURL: ${site.url}`);
                // Naming the element shape turned up that `timestamp` is optional:
                // `new Date(undefined)` renders the literal string "Invalid Date"
                // into the prompt, which reads to the model as a real value.
                if (site.timestamp !== undefined) {
                  contextParts.push(`Scraped: ${new Date(site.timestamp).toLocaleString()}`);
                }
                if (site.content) {
                  // Include a summary of the scraped content
                  const contentPreview =
                    typeof site.content === 'string'
                      ? site.content.substring(0, 1000)
                      : JSON.stringify(site.content).substring(0, 1000);
                  contextParts.push(`Content Preview: ${contentPreview}...`);
                }
              });
            }

            if (context.conversationContext.currentProject) {
              contextParts.push(`\nCurrent Project: ${context.conversationContext.currentProject}`);
            }
          }

          if (contextParts.length > 0) {
            fullPrompt = `CONTEXT:\n${contextParts.join('\n')}\n\n${wrapUserRequest(prompt)}`;
          }
        }

        await sendProgress({ type: 'status', message: 'Planning application structure...' });

        // Nobody is listening: stop before the model call rather than paying for tokens and
        // credits nobody will see. The `finally` settles the job.
        if (clientDisconnected) {
          log.warn('generation.stopped_before_model', {
            jobId: generationJob?.id ?? null,
            reason: clientDisconnectReason,
          });
          return;
        }

        console.log('\n[generate-ai-code-stream] Starting streaming response...\n');

        // DeepSeek is the only provider; the chain below supplies the client.
        const actualModel = model;

        // Never exceed the workspace plan's per-job token cap.
        const outputTokenCap = Math.min(appConfig.ai.maxTokens, planCaps.maxTokensPerJob);

        // Typed on purpose: this object used to be `any`, which let the AI SDK v4 names
        // `maxTokens` and `experimental_providerMetadata` sit here unnoticed. Both are
        // silently ignored by v5 (they are `maxOutputTokens` and `providerOptions` now),
        // so the output cap never applied and GPT-5 never received reasoningEffort.
        // Keeping the type means a stale option name fails tsc instead of failing quietly.
        // Stable prefix first (cacheable). Volatile user + file context last.
        // Typed on purpose: v5 renamed maxTokens to maxOutputTokens and
        // experimental_providerMetadata to providerOptions, and silently
        // ignored the old names — the output cap never applied. A stale option
        // now fails tsc instead of failing quietly.
        const streamOptions: Parameters<typeof streamText>[0] = {
          // Replaced per attempt by the provider chain below.
          model: undefined as never,
          messages: buildCachedMessages({
            stablePrefix,
            volatileUser: [injectedSkills.block, volatileSuffix, fullPrompt]
              .filter(Boolean)
              .join('\n\n'),
          }),
          maxOutputTokens: outputTokenCap,
          stopSequences: [], // Don't stop early
        };

        // One decision for every provider call this run makes — see `temperatureForModel`
        // for the two call sites that disagreed (F-041). Left off the object entirely for a
        // thinking-mode model, which rejects the option rather than ignoring it.
        const temperature = temperatureForModel(actualModel);
        if (temperature !== undefined) {
          streamOptions.temperature = temperature;
        }
        /**
         * What the prompt is worth in tokens when the provider reports no usage
         * of its own — a rejected call, an aborted stream. `RunUsage` falls back
         * to a character estimate of exactly this text.
         */
        const promptTextForEstimate = `${stablePrefix}\n${injectedSkills.block}\n${volatileSuffix}\n${fullPrompt}`;
        let generatedCode = '';
        let files: { path: string; content: string }[] = [];
        let componentCount = 0;
        let providersTried: string[] = [];
        /**
         * Whether the browser can already hold the reply from its `stream`
         * frames, so the `complete` frame does not have to send the largest
         * payload in the product a second time (F-043). See
         * `shouldSendGeneratedCode` for what each field means.
         */
        const streamedReply = { streamAttempts: 0, replyRewritten: false, streamedChars: 0 };
        try {
          const failover = await executeWithCompletionFailover(
            providerChain,
            async (entry, ctx) => {
              servedProvider = entry.provider;
              servedModel = entry.model;
              const client = clientForEntry(entry, providerEnv);
              const nextOptions = {
                ...streamOptions,
                model: client(entry.model),
                maxOutputTokens: Math.min(outputTokenCap, maxOutputTokensForEntry(entry)),
                abortSignal: ctx.signal,
              };
              // Announced per attempt, not per run: a failover retry uploads the
              // whole prompt again and the provider bills it again.
              runUsage.willSend(promptTextForEstimate);
              const capture = bindStreamErrorCapture();
              return capture.attach(
                streamText({
                  ...nextOptions,
                  onError: capture.onError,
                }),
              );
            },
            async (stream, entry, collectCtx) => {
              servedProvider = entry.provider;
              servedModel = entry.model;
              generatedCode = '';
              files = [];
              const streamedFiles = new StreamedFileTracker();
              let isInTag = false;
              let conversationalBuffer = '';
              streamedReply.streamAttempts += 1;

              // Stream the response and parse in real-time
              for await (const textPart of stream.textStream || []) {
                // Deliberately no `break` on a disconnected client. Breaking
                // here threw away a build the moment someone reloaded the tab:
                // the loop stopped mid-site, the settle below never got a
                // complete reply, and the work — already paid for in tokens —
                // was lost. The site is persisted server-side, so finishing
                // the stream is what lets them come back to it. Writes to the
                // browser are already skipped while it is gone.
                // Every chunk rearms the idle bound in `executeWithCompletionFailover`.
                // Without it, a provider that accepted the request and then went quiet held
                // this handler, the queue slot and the project lock for 20 minutes (F-030).
                collectCtx.progress();
                const text = textPart || '';
                generatedCode += text;
                const closedFiles = streamedFiles.push(text);
                const capAbort = capTracker.addChunk(text);
                if (capAbort) {
                  for (const file of capTracker.partialFiles) {
                    jobProgress?.addFile(file.path, file.content);
                  }
                  await jobProgress?.flush();
                  throw capAbort;
                }

                // Check if we're entering or leaving a tag
                const hasOpenTag =
                  /<(file|package|packages|explanation|command|structure|template)\b/.test(text);
                const hasCloseTag =
                  /<\/(file|package|packages|explanation|command|structure|template)>/.test(text);

                if (hasOpenTag) {
                  // Send any buffered conversational text before the tag
                  if (conversationalBuffer.trim() && !isInTag) {
                    await sendProgress({
                      type: 'conversation',
                      text: conversationalBuffer.trim(),
                    });
                    conversationalBuffer = '';
                  }
                  isInTag = true;
                }

                if (hasCloseTag) {
                  isInTag = false;
                }

                // If we're not in a tag, buffer as conversational text
                if (!isInTag && !hasOpenTag) {
                  conversationalBuffer += text;
                }

                // Stream the raw text for live preview. Counted only when it is
                // actually written: `sendProgress` is a no-op once the browser
                // has gone, and a reply nobody received cannot be reused.
                if (!clientDisconnected) streamedReply.streamedChars += text.length;
                await sendProgress({
                  type: 'stream',
                  text: text,
                  raw: true,
                });

                // Files the tracker finished on this chunk. It owns the fence
                // bookkeeping and the path check — see StreamedFileTracker for the
                // two ways the accumulator that used to live here lost content.
                for (const closedFile of closedFiles) {
                  if (jobProgress) {
                    const fileAbort = capTracker.addFile(closedFile.path, closedFile.content);
                    jobProgress.addFile(closedFile.path, closedFile.content);
                    if (fileAbort) {
                      await jobProgress.flush();
                      throw fileAbort;
                    }
                  }
                  // Send component progress update
                  if (closedFile.path.includes('components/')) {
                    componentCount++;
                    const componentName =
                      closedFile.path.split('/').pop()?.replace('.jsx', '') || 'Component';
                    await sendProgress({
                      type: 'component',
                      name: componentName,
                      path: closedFile.path,
                      index: componentCount,
                    });
                  } else if (closedFile.path.includes('App.jsx')) {
                    await sendProgress({
                      type: 'app',
                      message: 'Generated main App.jsx',
                      path: closedFile.path,
                    });
                  }
                }
              }

              console.log('\n\n[generate-ai-code-stream] Streaming complete.');

              // A dropped path is not silent, but the live tracker's list is not the whole
              // story: `streamedFiles.rejectedPaths` holds only the fences the tracker
              // recognised as it streamed, while the post-stream parse below runs
              // `normalizeFenceOpeners` / `sanitizeAssistantOutput` first and so recovers
              // glued, split and unclosed fences the tracker missed. A path unique to that
              // recovered set used to drop with a bare `continue` and no notice. Collect
              // both and announce them together, after the parse.
              const droppedPaths = new Set<string>(streamedFiles.rejectedPaths);

              if (clientDisconnected) {
                // Note it and carry on. Returning here returned `files` before
                // the reply was ever parsed — parsing happens further down —
                // so a build whose browser had gone away arrived with zero
                // files and was recorded as "the AI produced nothing". A real
                // run lost a complete five-page site this way: the model had
                // emitted seven path-tagged fences, and every one was dropped
                // because the person reloaded the tab while it streamed.
                log.warn('generation.client_left_mid_stream', {
                  jobId: generationJob?.id ?? null,
                  reason: clientDisconnectReason,
                  charsGenerated: generatedCode.length,
                });
              }

              // Send any remaining conversational text
              if (conversationalBuffer.trim()) {
                await sendProgress({
                  type: 'conversation',
                  text: conversationalBuffer.trim(),
                });
              }

              // Parse files and send progress for each. The block parser carries
              // llamacoder's tolerances for how models actually break the fence
              // format — a glued opener, the path tag on the next line, a split
              // closing brace, a stream cut before the final fence.
              for (const [filePath, content] of Object.entries(filesFromReply(generatedCode))) {
                const safe = sanitizeGenerationPath(filePath);
                if (!safe.ok) {
                  droppedPaths.add(filePath);
                  continue;
                }
                files.push({ path: safe.path, content });
                jobProgress?.addFile(safe.path, content);

                // Send progress for each file (reusing componentCount from streaming)
                if (filePath.includes('components/')) {
                  const componentName =
                    filePath.split('/').pop()?.replace('.jsx', '') || 'Component';
                  await sendProgress({
                    type: 'component',
                    name: componentName,
                    path: filePath,
                    index: componentCount,
                  });
                } else if (filePath.includes('App.jsx')) {
                  await sendProgress({
                    type: 'app',
                    message: 'Generated main App.jsx',
                    path: filePath,
                  });
                }
              }

              // One frame for both sources — the live tracker's rejects and the ones only
              // the recovering parse above saw — so the file the user asked for never
              // vanishes with nothing anywhere saying why.
              if (droppedPaths.size > 0) {
                const rejectedPaths = [...droppedPaths];
                log.warn('generation.unsafe_stream_paths', {
                  jobId: generationJob?.id ?? null,
                  paths: rejectedPaths,
                });
                await sendProgress({
                  type: 'warning',
                  message: `Skipped ${rejectedPaths.length} file${rejectedPaths.length === 1 ? '' : 's'} whose path was unsafe.`,
                  warnings: rejectedPaths,
                });
              }

              // This attempt is done streaming, so its usage is readable. A
              // rejected usage promise must not take the run down: the
              // accumulator falls back to a character estimate of what was
              // sent and streamed.
              runUsage.settle(await stream.usage.catch(() => undefined), generatedCode);

              const summary = summarizeGenerationOutput(generatedCode);
              log.info('generation.stream_complete', {
                jobId: generationJob?.id ?? null,
                provider: entry.provider,
                model: entry.model,
                chars: summary.chars,
                preview: summary.preview,
                pathFences: summary.pathFences,
                fences: summary.fences,
              });
              return {
                generatedCode,
                files,
                stop: clientDisconnected,
              };
            },
            // "Complete" here means only that this provider did its job — see
            // `attemptProducedOutput`. Whether the reply contained files is a separate
            // question, decided once below on the final reply.
            attemptProducedOutput,
            { circuit: getDefaultCircuit(), signal: jobCancelled.signal },
          );
          servedProvider = failover.provider;
          servedModel = failover.model;
          generatedCode = failover.result.generatedCode;
          files = failover.result.files;
          providersTried = [
            ...new Set(failover.attempts.map((row) => providerDisplayName(row.provider))),
          ];
          if (generationJob) {
            await updateJobFields(generationJob.id, {
              provider: failover.provider,
              model: failover.model,
            });
            await recordProviderAttempts(generationJob.id, failover.attempts);
          }
          if (failover.failedOver) {
            // One provider now, so a "failover" is a retry of the same model.
            await sendProgress({
              type: 'info',
              message: 'The first attempt failed, so this was retried.',
            });
          }
        } catch (streamError: unknown) {
          if (streamError instanceof JobCapError) throw streamError;
          const cause =
            streamError instanceof ProviderRunError
              ? (streamError.causeError ?? streamError)
              : streamError;
          const attempts = streamError instanceof ProviderRunError ? streamError.attempts : [];
          providersTried = [...new Set(attempts.map((row) => providerDisplayName(row.provider)))];
          if (generationJob && attempts.length > 0) {
            await recordProviderAttempts(generationJob.id, attempts);
          }
          if (cause instanceof EmptyCompletionError) {
            log.warn('generation.empty_chain', {
              jobId: generationJob?.id ?? null,
              providersTried,
            });
          } else {
            console.error('[generate-ai-code-stream] Error calling streamText:', streamError);
            throw Object.assign(
              streamError instanceof Error
                ? streamError
                : new Error(providerFailureMessage(cause, servedProvider)),
              { cause },
            );
          }
        }

        // No early return for a disconnected client. Returning here skipped
        // the settle below, so the row stayed RUNNING with a heartbeat that
        // had already stopped — the workspace showed "Building your project…"
        // indefinitely for a build that was over. Everything from here is
        // server-side work: parse, persist, settle. The browser is welcome to
        // be gone for all of it.

        // A reply that parsed to zero files but owed us some — it claimed a change, or
        // pasted source that missed the `{path=…}` contract — gets exactly one corrective
        // ask, against the provider that just answered.
        //
        // This is deliberately not failover. Failover answers "is this vendor working", and
        // a model that talked is a working vendor: walking the chain for it pays a second
        // provider to repeat the mistake. Credits were charged once for this job, at
        // `markJobRunning({ chargeCredits: true })` before the first call, and nothing here
        // charges again — the ask is part of the same job. It happens at most once: the
        // `askedAgain` flag below is what stops a model that likes talking from being paid
        // to talk in a loop.
        let askedForFilesAgain = false;
        const correctiveEntry =
          (servedProvider && servedModel
            ? providerChain.find(
                (entry: ProviderEntry) =>
                  entry.provider === servedProvider && entry.model === servedModel,
              )
            : null) ??
          providerChain[0] ??
          null;
        if (
          correctiveEntry &&
          // Nobody is listening, so this would buy tokens for a reply no one reads and a
          // build no one asked to see — the same reason the first call is skipped above.
          !clientDisconnected &&
          classifyReplyOutcome({
            fileCount: files.length,
            reply: generatedCode,
            askedAgain: false,
          }) === 'ask_again'
        ) {
          askedForFilesAgain = true;
          log.warn('generation.missing_files_ask_again', {
            jobId: generationJob?.id ?? null,
            provider: correctiveEntry.provider,
            model: correctiveEntry.model,
            ...summarizeGenerationOutput(generatedCode),
          });
          // Recorded even when the ask then succeeds. Without it this class of miss is
          // invisible in /admin/jobs, and the only evidence we ever had of it was a user's
          // photograph of the chat.
          await recordJobStepFailure(generationJob?.id, {
            key: 'return-files',
            label: 'Return the changed files',
            error: MISSING_FILES_STEP_ERROR,
          });
          await sendProgress({ type: 'info', message: MISSING_FILES_ASKED_AGAIN });
          try {
            // A second full generation: the whole message list again, plus the
            // echo and the correction. It was previously free of charge in the
            // books because the usage read only ever looked at the main stream.
            const correctiveEcho = generatedCode.slice(0, CORRECTIVE_ECHO_CHARS);
            runUsage.willSend(
              `${promptTextForEstimate}\n${correctiveEcho}\n${MISSING_FILES_CORRECTION}`,
            );
            const capture = bindStreamErrorCapture();
            const correctiveClient = clientForEntry(correctiveEntry, providerEnv);
            const corrective = capture.attach(
              streamText({
                ...streamOptions,
                model: correctiveClient(correctiveEntry.model),
                maxOutputTokens: Math.min(outputTokenCap, maxOutputTokensForEntry(correctiveEntry)),
                // Decided from the entry that will actually serve this ask, not inherited
                // from `streamOptions`: the corrective entry need not be the model the main
                // call's decision was made for (F-041).
                temperature: temperatureForModel(correctiveEntry.model),
                messages: [
                  ...(streamOptions.messages ?? []),
                  // Its own words back, capped: the claim is what it has to answer for, and
                  // a reply that ran to tens of thousands of tokens must not be bought a
                  // second time as input.
                  { role: 'assistant', content: correctiveEcho },
                  { role: 'user', content: MISSING_FILES_CORRECTION },
                ],
                onError: capture.onError,
              }),
            );
            // Whatever this ask produces, the client's accumulated buffer now
            // holds the first reply followed by this one, so it can no longer
            // stand in for `generatedCode` on the `complete` frame (F-043).
            streamedReply.replyRewritten = true;
            let correctedCode = '';
            for await (const part of corrective.textStream ?? []) {
              const text = part || '';
              correctedCode += text;
              const capAbort = capTracker.addChunk(text);
              if (capAbort) {
                await jobProgress?.flush();
                throw capAbort;
              }
              await sendProgress({ type: 'stream', text, raw: true });
            }
            runUsage.settle(await corrective.usage.catch(() => undefined), correctedCode);
            // `textStream` drops error parts, so a rejected call iterates zero chunks and
            // resolves to nothing — indistinguishable from a model with nothing to say
            // unless the captured rejection is surfaced here.
            const correctiveFailure = await surfaceStreamFailure(corrective);
            if (correctiveFailure != null) throw correctiveFailure;
            const correctedFiles = Object.entries(filesFromReply(correctedCode)).flatMap(
              ([path, content]) => {
                const safe = sanitizeGenerationPath(path);
                return safe.ok ? [{ path: safe.path, content }] : [];
              },
            );
            if (correctedFiles.length > 0) {
              generatedCode = correctedCode;
              files = correctedFiles;
              // Counted against the job's caps exactly like the first pass: the file cap and
              // the per-path loop guard apply to the whole job, not per stream, and
              // `partialFiles` is what "keep what was built" recovers.
              for (const file of files) {
                const fileAbort = capTracker.addFile(file.path, file.content);
                jobProgress?.addFile(file.path, file.content);
                if (fileAbort) {
                  await jobProgress?.flush();
                  throw fileAbort;
                }
              }
              await sendProgress({
                type: 'info',
                message: `The second ask returned ${files.length} file${files.length === 1 ? '' : 's'}.`,
              });
            } else {
              // The first reply is kept when the ask adds nothing: it is what the user
              // watched arrive, and adopting a second helping of prose would let a nudged
              // reply pass as the answer to a question the user never asked.
              log.warn('generation.missing_files_ask_again_missed', {
                jobId: generationJob?.id ?? null,
                ...summarizeGenerationOutput(correctedCode),
              });
            }
          } catch (correctiveError) {
            if (correctiveError instanceof JobCapError) throw correctiveError;
            // A failed second ask never becomes the run's cause: the first reply still
            // stands and the settle below reports exactly what it was worth. Recorded under
            // its own step key so it cannot overwrite the miss that prompted it.
            const askFailure = providerFailureMessage(correctiveError, correctiveEntry.provider);
            logError('generation.missing_files_ask_again_failed', correctiveError);
            await recordJobStepFailure(generationJob?.id, {
              key: 'ask-files-again',
              label: 'Ask again for the files',
              error: askFailure,
            });
            await sendProgress({ type: 'warning', message: askFailure });
          }
        }

        // Extract explanation
        const explanationMatch = generatedCode.match(/<explanation>([\s\S]*?)<\/explanation>/);
        const explanation = explanationMatch
          ? explanationMatch[1].trim()
          : 'Code generated successfully!';

        // Validate generated code for truncation issues. Keyed to the fenced `{path=…}`
        // contract the prompt actually specifies: this used to count `<file path="` tags,
        // a shape no prompt asks for, so the warnings were always empty, the recovery
        // below was unreachable and a reply cut off mid-file shipped as a finished build.
        const truncatedFiles = detectTruncatedFiles(generatedCode);
        const truncationWarnings: string[] = truncatedFiles.map((file) => file.warning);

        // Handle truncation with automatic retry (if enabled in config)
        if (truncationWarnings.length > 0 && appConfig.codeApplication.enableTruncationRecovery) {
          console.warn(
            '[generate-ai-code-stream] Truncation detected, attempting to fix:',
            truncationWarnings,
          );

          await sendProgress({
            type: 'warning',
            message: 'Detected incomplete code generation. Attempting to complete...',
            warnings: truncationWarnings,
          });

          // One scan decides both the warnings and what recovery re-asks for. They used to
          // be two scans with different thresholds, so a warning could fire with no file
          // selected — recovery then did nothing and the warnings survived as "incomplete".
          const truncatedPaths = truncatedFiles.map((file) => file.path);

          // If we have truncated files, try to regenerate them
          if (truncatedPaths.length > 0) {
            console.log(
              '[generate-ai-code-stream] Attempting to regenerate truncated files:',
              truncatedPaths,
            );

            // The recovery call is a second generation, so reuse the provider entry that
            // served the first pass. The older mapping re-derived a client from the model
            // string and had no `google` branch at all, so Gemini runs were quietly sent to
            // Groq with a Gemini model name.
            const recoveryEntry =
              (servedProvider && servedModel
                ? providerChain.find(
                    (entry: ProviderEntry) =>
                      entry.provider === servedProvider && entry.model === servedModel,
                  )
                : null) ??
              providerChain[0] ??
              null;
            let recoveryFailure: TruncationRecoveryOutcome | null = null;
            /** Files whose completed content had no block to land on — kept as generated. */
            const unrepairedWarnings: string[] = [];

            for (const truncatedFile of truncatedFiles) {
              const filePath = truncatedFile.path;
              // One provider failure will repeat for every remaining file, so stop asking.
              if (recoveryFailure) break;
              await sendProgress({
                type: 'info',
                message: `Completing ${filePath}...`,
              });

              try {
                // Create a focused prompt to complete just this file
                const completionPrompt = `Complete the following file that was truncated. Provide the FULL file content.

File: ${filePath}
${wrapUserRequest(prompt)}

Provide the complete file content without any truncation. Include all necessary imports, complete all functions, and close all tags properly.`;

                const recoveryClient = clientForEntry(recoveryEntry, providerEnv);
                // One call per truncated file, each with its own prompt. None of
                // them were counted: `collectRecoveredStreamText` drains the
                // stream and never touches usage.
                runUsage.willSend(completionPrompt);
                const capture = bindStreamErrorCapture();
                const completionResult = capture.attach(
                  streamText({
                    model: recoveryClient(recoveryEntry.model),
                    messages: [
                      {
                        role: 'system',
                        content:
                          'You are completing a truncated file. Provide the complete, working file content.',
                      },
                      { role: 'user', content: completionPrompt },
                    ],
                    // Was `recoveryEntry.model.startsWith('gpt-5') ? undefined : …` — a dead
                    // OpenAI test that can never be true for a DeepSeek id, so `-pro` (which
                    // the main call is careful to exclude) received a temperature and every
                    // recovery call on that model was rejected by the provider (F-041).
                    temperature: temperatureForModel(recoveryEntry.model),
                    // truncationRecoveryMaxTokens existed in config but was never passed,
                    // so recovery ran uncapped and could truncate a second time.
                    maxOutputTokens: Math.min(
                      appConfig.ai.truncationRecoveryMaxTokens,
                      planCaps.maxTokensPerJob,
                    ),
                    onError: capture.onError,
                  }),
                );

                // Throws whatever the stream reported rather than handing back the empty
                // string a rejected call resolves to — and charges every chunk to the job's
                // caps, so N recovery calls cannot outrun `maxTokensPerJob` (F-042).
                const completedContent = await collectRecoveredStreamText(
                  completionResult,
                  (chunk) => capTracker.addChunk(chunk),
                );
                runUsage.settle(
                  await completionResult.usage.catch(() => undefined),
                  completedContent,
                );

                // Extract just the code content (remove any markdown or explanation)
                let cleanContent = completedContent;
                if (cleanContent.includes('```')) {
                  const codeMatch = cleanContent.match(/```[\w]*\n([\s\S]*?)```/);
                  if (codeMatch) {
                    cleanContent = codeMatch[1];
                  }
                }

                // A recovery that came back with nothing must not overwrite the file with
                // nothing: a file cut off mid-write is worth more than an empty one.
                if (!cleanContent.trim()) {
                  throw new EmptyCompletionError(recoveryEntry.provider, recoveryEntry.model);
                }

                // Put the repaired file back as a `{path=…}` fence. The rewrite used to emit
                // `<file path="…">`, which `filesFromReply` does not parse, so the settle
                // dropped the very file this second model call was paid for.
                //
                // A miss is not fatal and is emphatically not a provider failure. This used
                // to throw, which meant the catch below classified a local path-matching bug
                // as `provider_error`, abandoned every remaining truncated file untried, and
                // told the user their build was incomplete because of a vendor outage. The
                // block keeps whatever the first pass produced and the run names it.
                const repaired = replaceBlockInReply(generatedCode, filePath, cleanContent);
                if (!repaired) {
                  console.warn(
                    `[generate-ai-code-stream] No ${filePath} block to replace; keeping what was generated.`,
                  );
                  unrepairedWarnings.push(truncatedFile.warning);
                  continue;
                }
                generatedCode = repaired;
                // The repaired block replaces text the browser already received,
                // so its buffer is no longer the reply (F-043).
                streamedReply.replyRewritten = true;

                console.log(`[generate-ai-code-stream] Successfully completed ${filePath}`);
              } catch (completionError) {
                if (completionError instanceof JobCapError) throw completionError;
                console.error(
                  `[generate-ai-code-stream] Failed to complete ${filePath}:`,
                  completionError,
                );
                recoveryFailure = truncationRecoveryOutcome(
                  completionError,
                  recoveryEntry?.provider ?? servedProvider,
                );
              }
            }

            if (recoveryFailure) {
              // The truncated files stay, and the run says so. This branch used to clear the
              // warnings and report success no matter what the recovery had done.
              await recordJobStepFailure(generationJob?.id, {
                key: 'truncation-recovery',
                label: 'Complete the truncated files',
                error: recoveryFailure.errorMessage,
              });
              await sendProgress({
                type: 'warning',
                message: recoveryFailure.errorMessage,
                warnings: truncationWarnings,
              });
            } else {
              // Only the files that were actually rewritten stop being reported. A partial
              // repair used to be impossible to express: the branch cleared every warning
              // and claimed all of them were completed.
              truncationWarnings.length = 0;
              truncationWarnings.push(...unrepairedWarnings);
              const repairedCount = truncatedFiles.length - unrepairedWarnings.length;
              if (repairedCount > 0) {
                await sendProgress({
                  type: 'info',
                  message: `Completed ${repairedCount} truncated file${repairedCount === 1 ? '' : 's'}.`,
                });
              }
              if (unrepairedWarnings.length > 0) {
                await sendProgress({
                  type: 'warning',
                  message: `Could not repair ${unrepairedWarnings.length} truncated file${unrepairedWarnings.length === 1 ? '' : 's'} — the completed content had no matching block in the reply, so what was generated was kept.`,
                  warnings: truncationWarnings,
                });
              }
            }

            // The `complete` frame and the job's `producedFiles` are counted from `files`,
            // which was built from the pre-repair parse. Re-derive it from the reply the
            // settle will actually store, or the two disagree the moment recovery changes
            // what the reply contains.
            files = Object.entries(filesFromReply(generatedCode)).flatMap(([path, content]) => {
              const safe = sanitizeGenerationPath(path);
              return safe.ok ? [{ path: safe.path, content }] : [];
            });
          }
        }

        // Everything this run spent, across every call. `close` charges a call
        // that was announced and never settled — an aborted or rejected stream
        // whose prompt the provider still billed.
        runUsage.close();
        const spent = runUsage.totals;
        const inputTokens = spent.tokensIn;
        const outputTokens = spent.tokensOut;
        if (spent.estimatedCalls > 0) {
          log.warn('generation.tokens_partly_estimated', {
            jobId: generationJob?.id ?? null,
            calls: spent.calls,
            estimatedCalls: spent.estimatedCalls,
            tokensIn: inputTokens,
            tokensOut: outputTokens,
          });
        }
        try {
          // Bound to the event this run resolved before it spent anything, not to
          // whatever row is newest now (F-749). A null id logs the miss inside
          // `attachGenerationInputTokens` rather than writing to a stranger's event.
          await attachGenerationInputTokens(usageEventId, inputTokens);
        } catch (tokenError) {
          logError('generation.tokens_failed', tokenError);
        }

        // What a fileless reply means, decided once, on the final reply.
        //
        // Zero files used to mean one thing — failure — and that was wrong for the commonest
        // case of all. A finished project, the user types "hello", the model answers in
        // prose: nothing was asked to change, so nothing changing is the correct outcome.
        // Reporting it as `no_files_generated` failed the job and drew the red recovery
        // panel with a Try again button over a model that had done nothing wrong.
        //
        // A parsed file is still the only evidence a run changed anything (the removed
        // Morph `<edit>` block count was evidence of nothing, so counting it let an edit
        // that changed nothing report success), and a reply that owed files and did not
        // deliver after being asked twice is still a failure. An answer is not.
        const replyOutcome = classifyReplyOutcome({
          fileCount: files.length,
          reply: generatedCode,
          askedAgain: askedForFilesAgain,
        });
        const chatAnswer = replyOutcome === 'answer';
        const hadNoChanges = replyOutcome === 'no_files';
        const noChangeReason = hadNoChanges
          ? describeNoChanges({
              isEdit,
              hasProjectFiles: Object.keys(backendFiles).length > 0,
              // No manifest exists any more; the flag no longer selects a message.
              hasManifest: false,
              providersTried,
            })
          : null;

        // Initial builds only: files that can't render on the project's stack
        // (a Next.js tree for a Vite project) must fail here, not "succeed"
        // and then kill the sandbox boot with a bare npm ENOENT.
        const stackMismatchReason =
          !isEdit && !hadNoChanges && files.length > 0
            ? stackShapeMismatch(
                projectStack,
                files.map((file) => file.path),
              )
            : null;

        // Nothing below may run under a lock this run no longer holds. From the moment the
        // renewal failed, another run could have taken the project and written
        // `Project.lastCode`; persisting on top of that is the corruption the lock exists to
        // prevent, and a `complete` frame would report a write that never happened. Thrown
        // rather than returned so the catch fails the job as `project_lock_lost` and sends
        // the error frame, and so the build check is not paid for either (F-730).
        if (lockLost.aborted) throw new ProjectLockLostError(projectId);

        // Check the generated code before anyone is told the build worked.
        //
        // The class this catches reached a user: `No matching export in "vfs:lib/data.ts"
        // for import "site"` — the model imported a named export it never wrote, and the
        // preview died on it. The check that was supposed to catch it ran the stack's build
        // command inside a sandbox and skipped when there was no sandbox, so once the
        // sandbox subsystem was removed it skipped on every single run.
        //
        // Skipped for zero files on purpose: a fileless reply is either an answer or a
        // reported miss, and both are decided above.
        const buildFix =
          files.length > 0
            ? (
                await runBuildValidation({
                  stack: projectStack,
                  // The stored project merged with what this run produced. A partial map
                  // makes a correct one-file edit look like a broken project, because every
                  // import into the untouched rest of the site resolves to nothing.
                  files: {
                    ...backendFiles,
                    ...Object.fromEntries(files.map((file) => [file.path, file.content])),
                  },
                  changedPaths: files.map((file) => file.path),
                  jobId: generationJob?.id ?? null,
                  attempt: Number(buildFixAttempt ?? 0),
                  previousSignature:
                    typeof buildFixSignature === 'string' ? buildFixSignature : null,
                  // It writes its own chat notice and its own `validate-build` job step, so
                  // nothing here repeats them.
                  notify: (message, level) => sendProgress({ type: level, message }),
                })
              ).retry
            : null;

        let streamSettle: StreamSettleResult | null = null;
        /** Set when the answer turn could not be recorded as finished. */
        let answerSettleFailure: string | null = null;
        if (generationJob) {
          await jobProgress?.flush();
          // The tokens were spent either way, so they are recorded either way.
          // `claim` is what stops the catch below from accruing the same spend a
          // second time if anything after this point throws.
          const claimed = runUsage.claim();
          const estimatedCostUsd = claimed
            ? await recordJobUsage({
                jobId: generationJob.id,
                workspaceId: WORKSPACE_ROW_ID,
                tokensIn: claimed.tokensIn,
                tokensOut: claimed.tokensOut,
                provider: servedProvider,
                model: servedModel,
              })
            : null;
          if (chatAnswer) {
            // An answer changed nothing, so there is nothing to persist and no site to
            // claim. `succeedJob` puts the project back on the phase the evidence supports
            // (`resumablePhaseFromEvidence`: lastCode / checkpoints, never job.filesWritten),
            // so "hello" on a finished site lands on COMPLETE and "hello" on an empty
            // project lands back on PLANNING. Hard-coding COMPLETE here would make an empty
            // project insist it has a site, and the preview would then insist there is
            // something to show.
            //
            // `settleStreamedGeneration` is deliberately not used for this: it fails
            // `no_files_generated` whenever the project has no site yet, which is the same
            // false failure this branch exists to remove. No credits are charged here —
            // this job's one charge happened at `markJobRunning` before the first call.
            try {
              await succeedJob(generationJob.id, {
                tokensIn: inputTokens,
                tokensOut: outputTokens,
                estimatedCostUsd,
                provider: servedProvider,
                model: servedModel,
              });
            } catch (settleError) {
              // A lost settle leaves the chat busy, so it is reported rather than left to
              // unwind through the outer catch — which would describe a database failure as
              // a provider failure. `reportSettleFailure` never throws and its
              // `ensureJobSettled` fallback still gets the row out of RUNNING.
              await reportSettleFailure({
                jobId: generationJob.id,
                intended: 'succeeded',
                error: settleError,
              });
              answerSettleFailure =
                'The AI answered, but we could not record this turn as finished. Reload the project if it still shows as busy.';
            }
          } else {
            // Streamed files are not a finished site. A sandbox that never went READY
            // must not settle SUCCEEDED / COMPLETE with lastCode still null.
            try {
              streamSettle = await settleStreamedGeneration({
                jobId: generationJob.id,
                producedFiles: files.length,
                streamedCode: generatedCode,
                noChangeReason,
                stackMismatchReason,
                tokensIn: inputTokens,
                tokensOut: outputTokens,
                estimatedCostUsd,
                provider: servedProvider,
                model: servedModel,
              });
            } catch (settleError) {
              await reportSettleFailure({
                jobId: generationJob.id,
                intended: noChangeReason ? 'failed' : 'succeeded',
                error: settleError,
              });
              streamSettle = {
                outcome: 'failed',
                errorCode: 'settle_write_failed',
                errorMessage:
                  settleError instanceof Error
                    ? settleError.message
                    : 'The generated files were not saved because we could not record the build.',
              };
            }
          }
          // The terminal settle has already given the project lock back — `succeedJob`,
          // `failJob` and `ensureJobSettled` all call `releaseLockQuietly` — so this hold
          // is over. Handing it back here rather than only in the `finally` is what stops
          // its heartbeat before the next renewal tick can find the lock gone and report a
          // loss that is really our own settle (F-730). Idempotent, so the `finally` still
          // covers every path that does not reach this line.
          await releaseGenerationLock?.();
        }

        if (chatAnswer) {
          log.info('generation.chat_answer', {
            jobId: generationJob?.id ?? null,
            isEdit,
            ...summarizeGenerationOutput(generatedCode),
          });
          if (answerSettleFailure) {
            // The answer itself is already in chat; what failed is recording the turn as
            // finished, and the workspace has to be told or it keeps showing as busy.
            await sendProgress({ type: 'conversation', text: answerSettleFailure });
            await sendProgress({ type: 'error', error: answerSettleFailure });
            return;
          }
          // The reply is already in chat: the stream loop flushes its conversational buffer
          // when the stream ends, and the client renders a `conversation` frame as the
          // assistant's message. So the only thing left is to end the run cleanly. No
          // `error` frame — that is what threw on the client, set `lastError` and drew the
          // recovery panel over an answer. No `trackSuccess` and no conversation-edit
          // record either: nothing was generated, and claiming an edit here would put a
          // change that never happened into the project's history.
          await sendProgress({
            type: 'complete',
            generatedCode: shouldSendGeneratedCode(streamedReply) ? generatedCode : undefined,
            files: 0,
            components: 0,
            model,
            skillNames: injectedSkills.names,
          });
          return;
        }

        if (noChangeReason) {
          log.warn('generation.no_changes', {
            jobId: generationJob?.id ?? null,
            isEdit,
            ...summarizeGenerationOutput(generatedCode),
            providersTried,
          });
          await recordJobStepFailure(generationJob?.id, {
            key: 'write-files',
            label: 'Write the changed files',
            error: noChangeReason,
          });
          trackFailure('generation.failure', new Error('no_files_generated'), {
            action: 'generation',
            stack: projectStack,
            model,
            durationMs: Date.now() - startedAt,
          });
          // Both frames are needed, and neither is redundant with the other. `error` unwinds
          // the client's generating state, but the generate branch handles it by throwing,
          // and that throw only reaches `markGenerationError` — which sets `lastError` and
          // renders no chat message. Without the `conversation` frame the sentence below
          // never appears in the chat at all. Do not collapse this pair the way the
          // no-project-files branch above collapses its `warning`.
          await sendProgress({ type: 'conversation', text: noChangeReason });
          await sendProgress({ type: 'error', error: noChangeReason });
          return;
        }

        if (streamSettle?.outcome === 'failed') {
          const persistMiss =
            streamSettle.errorMessage ||
            'The generated files were not saved because the workspace never became ready.';
          log.warn('generation.persist_miss', {
            jobId: generationJob?.id ?? null,
            errorCode: streamSettle.errorCode ?? null,
            sandboxFailed: true,
          });
          await recordJobStepFailure(generationJob?.id, {
            key: 'persist-generation',
            label: 'Save the generated files',
            error: persistMiss,
          });
          trackFailure(
            'generation.failure',
            new Error(streamSettle.errorCode || 'sandbox_unavailable'),
            {
              action: 'generation',
              stack: projectStack,
              model,
              durationMs: Date.now() - startedAt,
            },
          );
          await sendProgress({ type: 'conversation', text: persistMiss });
          await sendProgress({ type: 'error', error: persistMiss });
          return;
        }

        // A file the persist guard refused while the rest of the batch was stored — an
        // oversized file, a binary payload, a broken package.json — is a write miss, not a
        // silent drop. Frame it with the applyOutcome sentence the apply page uses for
        // write failures, carrying the guard's own message, the way unsafe stream paths
        // are announced above (F-028).
        const persistRejections = streamSettle?.rejectedFiles ?? [];
        if (persistRejections.length > 0) {
          const rejectedPaths = new Set(persistRejections.map((file) => file.path));
          const rejectionMessages = persistRejections.map((file) => file.message);
          log.warn('generation.persist_rejected_files', {
            jobId: generationJob?.id ?? null,
            count: persistRejections.length,
            paths: persistRejections.slice(0, 10).map((file) => file.path),
          });
          const framed = applyOutcome({
            filesCreated: files.map((file) => file.path).filter((path) => !rejectedPaths.has(path)),
            errors: rejectionMessages,
          });
          await sendProgress({
            type: 'warning',
            message: `${framed.warning ?? framed.message} (${rejectionMessages.join('; ')})`,
            warnings: rejectionMessages,
          });
        }

        trackSuccess('generation.success', {
          action: 'generation',
          stack: projectStack,
          model,
          inputTokens,
          outputTokens,
          durationMs: Date.now() - startedAt,
        });

        // Send completion with packages info. `generatedCode` is omitted when the
        // browser already accumulated this exact text from the `stream` frames:
        // it is the largest payload in the product and was sent twice on every
        // build (F-043). `completedCodeFromFrame` reads the buffer back client-side.
        await sendProgress({
          type: 'complete',
          generatedCode: shouldSendGeneratedCode(streamedReply) ? generatedCode : undefined,
          explanation,
          files: files.length,
          components: componentCount,
          model,
          warnings: truncationWarnings.length > 0 ? truncationWarnings : undefined,
          skillNames: injectedSkills.names,
          // Present only when the build check failed and the policy allows a repair
          // generation; the workspace runs one more pass with this instruction.
          buildFix: buildFix ?? undefined,
        });

        // Track edit in conversation history. Writes land on the state this
        // request resolved, never on whatever the process global points at by
        // now — another project's request may have taken it over mid-stream.
        //
        // The gate used to be `isEdit && editContext`, and editContext came from
        // the sandbox-manifest search plan, which never ran (F-026) — so nothing
        // was ever recorded and `recentlyModifiedPaths` above was always empty.
        // The paths this reply actually changed are the honest source, and unlike
        // a predicted plan they need no confidence estimate.
        if (isEdit && files.length > 0) {
          const targetFiles = files.map((file) => file.path);
          const editRecord: ConversationEdit = {
            timestamp: Date.now(),
            userRequest: prompt,
            editType: 'EDIT',
            targetFiles,
            confidence: 1,
            outcome: 'success',
          };

          conversation.context.edits.push(editRecord);

          // Feeds the "Recent Changes" prompt section. A follow-up that rewrites
          // most of the project is the kind of change the next turn should know
          // about; a one-file tweak is not.
          if (files.length > 3) {
            conversation.context.projectEvolution.majorChanges.push({
              timestamp: Date.now(),
              description: `Edited ${targetFiles.length} files: ${targetFiles.slice(0, 5).join(', ')}`,
              filesAffected: targetFiles,
            });
          }

          conversation.lastUpdated = Date.now();
        }
      } catch (error) {
        console.error('[generate-ai-code-stream] Stream processing error:', error);

        // A lost project lock aborts the same controller a Cancel does, so it is checked
        // first: this run was not asked to stop, it stopped because the project stopped
        // being its to write. It has to be reported as a failure, with the code that says
        // nothing was saved (F-730).
        const lostLock = lockLost.aborted;
        if (lostLock) {
          log.error('generation.lock_lost', { jobId: generationJob?.id ?? null, projectId });
        } else if (jobCancelled.signal.aborted) {
          // Cancel / Start over settled the row as CANCELLED before the abort unwound the
          // stream — the person asked for this stop. Nothing to fail (`failJob` only
          // touches an active row and must not overwrite the cancel), and an error frame
          // would misreport a requested stop as a provider failure. The `finally` still
          // runs: heartbeat, slot, progress flush, lock.
          log.info('generation.cancelled_mid_stream', { jobId: generationJob?.id ?? null });
          return;
        }

        const errorMessage = error instanceof Error ? error.message : String(error);
        const cap = error instanceof JobCapError ? error : null;
        const cause =
          error instanceof ProviderRunError
            ? (error.causeError ?? error)
            : error && typeof error === 'object' && 'cause' in error
              ? error.cause
              : error;
        // Decided by the SDK's own type predicates rather than
        // `errorMessage.includes('tool call validation failed')`, which silently reroutes
        // this to the generic provider path on any change in the SDK's wording (F-038).
        const isToolValidationError = isToolCallValidationError(error);
        const honest = lostLock
          ? LOCK_LOST_MESSAGE
          : (cap?.message ??
            (isToolValidationError ? errorMessage : providerFailureMessage(cause, servedProvider)));
        if (isToolValidationError) {
          logError('generation.tool_call_validation_failed', error);
        }
        // Unconditional. The tool-validation branch used to send a `warning` about package
        // installation — a subsystem that no longer exists — and skip the error frame, so
        // the stream closed with no `complete` and no `error`: the client's read loop simply
        // ended, and the run was reported as a dropped connection. The job is failed either
        // way, so the frame that says so has to go out either way (F-038).
        await sendProgress({
          type: 'error',
          error: honest,
        });
        if (generationJob) {
          // A failed run still spent everything it sent. This path used to reach
          // `failJob` with `tokensIn` absent and `tokensOut` set only by a cap
          // abort, so `estimatedCostUsd` was 0, `accrueSpend` was skipped, and
          // the most expensive failures were the cheapest on the books (F-027).
          // Null when the successful settle above already billed this run and
          // something after it threw — the same spend must not be accrued twice.
          const burned = runUsage.claim();
          // Left undefined when the usage write failed or was already done, so
          // the terminal write skips the column rather than blanking it.
          let estimatedCostUsd: number | undefined;
          if (burned) {
            try {
              estimatedCostUsd = await recordJobUsage({
                jobId: generationJob.id,
                workspaceId: WORKSPACE_ROW_ID,
                tokensIn: burned.tokensIn,
                tokensOut: burned.tokensOut,
                provider: servedProvider,
                model: servedModel,
              });
            } catch (usageError) {
              // Never the reason a failure is reported as something else: the
              // settle below still runs and still says what went wrong.
              logError('generation.failed_usage_not_recorded', usageError);
            }
          }
          try {
            await failJob(generationJob.id, {
              errorCode: lostLock
                ? 'project_lock_lost'
                : (cap?.errorCode ??
                  (isToolValidationError
                    ? 'tool_call_validation_failed'
                    : jobErrorCodeForProviderFailure(cause))),
              errorMessage: honest,
              tokensIn: burned?.tokensIn,
              // A cap abort counted the output itself; otherwise it is what the
              // run accumulated.
              tokensOut: cap?.tokensOut ?? burned?.tokensOut,
              estimatedCostUsd,
              provider: servedProvider,
              model: servedModel,
            });
          } catch (settleError) {
            // Without this the failure fell through to the `finally`, which would settle it
            // as `client_disconnected` — a terminal status, but the wrong diagnosis.
            await reportSettleFailure({
              jobId: generationJob.id,
              intended: 'failed',
              error: settleError,
            });
          }
        }
      } finally {
        // Order matters here, and it used to be wrong. `writer.close()` rejects when the
        // readable was cancelled, and it sat ahead of the lock release — so a client
        // disconnect skipped `releaseGenerationLock`, which is what stops the hold's
        // heartbeat, and the project lock then renewed itself every 60 seconds
        // indefinitely. Cleanup that must happen runs first; the close is last and cannot
        // skip anything.
        jobHeartbeat?.stop();
        providerSlot?.release();
        await jobProgress?.flush();
        // Last-resort terminal write: the happy path and the catch both settle already, so
        // this is a no-op unless the work was torn down rather than finished or thrown.
        await ensureJobSettled(generationJob?.id, {
          errorCode: 'client_disconnected',
          errorMessage: clientDisconnectReason
            ? `Client disconnected before the generation finished (${clientDisconnectReason})`
            : 'Client disconnected before the generation finished',
        });
        await releaseGenerationLock?.();
        // Deliberately not awaited. `close()` waits for queued chunks to drain, and a client
        // that stopped reading never drains them — awaiting it here would park the handler
        // all over again, just past the settle. It also rejects outright on a cancelled
        // readable, and there is nobody left to tell.
        void writer.close().catch(() => undefined);
      }
    })().catch((error: unknown) => {
      // The IIFE is detached, so anything escaping it is an unhandled rejection.
      logError('generation.detached_work_failed', error);
    });

    // Streaming headers only. This response used to declare
    // `Access-Control-Allow-Origin: *` on an authenticated, credit-spending endpoint, and
    // advertise `Authorization` as an accepted header — inviting a bearer-token integration
    // the cookie-only auth gate does not support — with no OPTIONS handler for the preflight
    // it advertised. No other route in the product sets CORS at all (F-012).
    return new Response(stream.readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Transfer-Encoding': 'chunked',
        'Content-Encoding': 'none', // Prevent compression that can break streaming
        'X-Accel-Buffering': 'no', // Disable nginx buffering
      },
    });
  } catch (error) {
    // The stream worker has not started on any path that can throw here, so the setup
    // resources are still this scope's to release (F-001).
    const cap = error instanceof JobCapError ? error : null;
    await releaseSetup({
      errorCode: cap?.errorCode ?? jobErrorCodeForProviderFailure(error),
      errorMessage: cap?.message ?? providerFailureMessage(error),
      tokensOut: cap?.tokensOut,
    });
    trackFailure('generation.failure', error, {
      action: 'generation',
      durationMs: Date.now() - startedAt,
    });
    // The same sentence `releaseSetup` just recorded on the job. Returning
    // `(error as Error).message` here made the route contradict itself and put raw
    // internal text — Prisma connection failures, provider echoes — in the browser
    // and in `Job.errorMessage`, which any signed-in member can read (F-079).
    // `trackFailure` above already logged and captured the detail.
    return jsonError(cap?.message ?? providerFailureMessage(error), 'GENERATION_FAILED', 500);
  }
}
