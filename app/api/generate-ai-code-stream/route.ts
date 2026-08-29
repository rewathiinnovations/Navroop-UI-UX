import { NextRequest, NextResponse } from 'next/server';
import { stepCountIs, streamText } from 'ai';
import type { ConversationMessage, ConversationEdit } from '@/types/conversation';
import { appConfig } from '@/config/app.config';
import { buildUiUxProMaxBrief } from '@/lib/ui-ux-pro-max/build-design-brief';
import { getSessionUser } from '@/lib/auth';
import { looksLikeUrl } from '@/lib/projects/prompt';
import { attachGenerationInputTokens, logGenerationEvent } from '@/lib/usage-costs';
import { buildCachedMessages } from '@/lib/generation/prompt-cache';
import {
  describeRepairs,
  hasRepairs,
  repairedPaths,
  repairGeneratedFiles,
} from '@/lib/generation/deterministic-repairs';
import { filesFromReply, replaceBlockInReply } from '@/lib/generation/parse-blocks';
import {
  GENERATION_RATE_LIMIT_MESSAGE,
  allowGenerationSubmit,
} from '@/lib/generation/submit-rate-limit';
import { readUserPrompt, wrapUserRequest } from '@/lib/generation/user-prompt';
import { readGenerationProjectId } from '@/lib/generation/request-project';

/** Markdown code fence, kept in a constant so prompt strings stay readable. */
const FENCE = '```';
import { conversationStateFor } from '@/lib/generation/conversation-state';
import { shouldSendGeneratedCode } from '@/lib/generation/complete-frame';
import { StreamedFileTracker } from '@/lib/generation/stream-file-tracker';
import {
  MODEL_THINKING_STATUS,
  WAITING_FOR_MODEL_STATUS,
  classifyStreamPart,
} from '@/lib/generation/stream-parts';
import { fileContextTokenCap, selectFileContext } from '@/lib/generation/selective-context';
import { createGenerationFileStore } from '@/lib/generation/tools/file-store';
import {
  AGENT_STEP_BUDGET_MESSAGE,
  buildGenerationTools,
  exhaustedStepBudget,
} from '@/lib/generation/tools';
import { agentToolsEnabled, maxAgentSteps } from '@/lib/ai/agent-tools';
import { buildStablePromptPrefix, buildVolatilePromptSuffix } from '@/lib/stack-prompts';
import { resolveRequestGenerationProfile } from '@/lib/stack-resolve';
import { stackShapeMismatch } from '@/lib/stacks';
import { withStarterFiles } from '@/lib/stacks/starter';
import { loadAssetManifest } from '@/lib/assets/load-manifest';
import { injectMatchedSkills } from '@/lib/skills/inject';
import { buildMemoryBlock } from '@/lib/memory/build-context';
import { creditDeniedJson } from '@/lib/plans/http';
import { checkCredits } from '@/lib/plans/limits';
import { WORKSPACE_ROW_ID } from '@/lib/storage/usage';
import { jsonError } from '@/lib/api/error-response';
import { withRequest } from '@/lib/api/with-request';
import { prisma } from '@/lib/db';
import { getCurrentProjectFiles } from '@/lib/github/current-files';
import { log, logError } from '@/lib/logger';
import { trackFailure, trackStart, trackSuccess } from '@/lib/observability/track';
import {
  countToolResult,
  recordToolRefusalRates,
  type ToolResultTally,
} from '@/lib/signals/collect';
import { holdProjectLock, LOCK_LOST_MESSAGE, ProjectLockLostError } from '@/lib/projects/lock';
import { lockConflictJson } from '@/lib/projects/lock-http';
import { getApprovedPlanContract } from '@/lib/projects/plan';
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
import { getDefaultProviderQueue, QUEUE_TIMEOUT_MESSAGE, queuePositionLabel } from '@/lib/ai/queue';
import {
  isDeepSeekModel,
  maxOutputTokensForEntry,
  modelIdForEntry,
  NO_PROVIDER_CONFIGURED_MESSAGE,
  providerConcurrency,
  providerDisplayName,
  ProviderNotConfiguredError,
  requireUsableProviderChain,
  unknownModelMessage,
  type ProviderEntry,
} from '@/lib/ai/providers';
import { loadEffectiveProviderEnv } from '@/lib/ai/effective-env';
import {
  chatModelForEntry,
  thinkingEnabledFromEnv,
  wrapReasoningModel,
} from '@/lib/ai/client-for-entry';
import {
  bindStreamErrorCapture,
  EmptyCompletionError,
  surfaceStreamFailure,
} from '@/lib/ai/empty-completion';
import { sanitizeGenerationPath } from '@/lib/generation/parse-files';
import {
  collectRecoveredStreamText,
  detectTruncatedFiles,
  truncationDetectedStepError,
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
  imagePlacementCorrection,
  imagesOwedByReply,
  imagesPlacedIn,
  MISSING_FILES_ASKED_AGAIN,
  MISSING_FILES_CORRECTION,
  MISSING_FILES_STEP_ERROR,
  MISSING_IMAGES_STEP_ERROR,
  unplacedImagesAskedAgain,
  unplacedImagesNotice,
} from '@/lib/generation/no-changes';
import {
  createConversationalScrubber,
  summarizeGenerationOutput,
} from '@/lib/generation/output-summary';
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
/**
 * The approved plan's contract, in the shape `runBuildValidation` takes.
 *
 * One read for both halves: `plannedRoutes` catches a page the plan promised and the model
 * never wrote, `plannedPages` catches the page it wrote thin. Reading the plan twice would
 * be two queries on the hot path of every first build for one fact.
 */
async function planContractForBuild(projectId: string) {
  const contract = await getApprovedPlanContract(projectId);
  return { plannedRoutes: contract.routes, plannedPages: contract.pages };
}

export const maxDuration = 1200;

/**
 * How much of a fileless reply is echoed back to the model on the corrective ask.
 *
 * Enough for it to see the claim it made; short enough that a reply which ran to tens of
 * thousands of output tokens is not bought a second time as input.
 */
const CORRECTIVE_ECHO_CHARS = 2000;

/**
 * Said when Stop / Start over settled the row between stream end and settle: the
 * person's own stop, not a persist failure.
 */
const CANCELLED_BEFORE_SAVING_LINE = 'The build was stopped before anything could be saved.';

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
 * The corrective ask's file list laid over the first reply's, keyed by path.
 *
 * The ask can be about pictures rather than about missing files, and in that case the
 * first reply is the site — eleven files that are right about everything except their
 * images. A correction only resends the two or three files that carry a token, so
 * substituting its list would ship those as the whole project. Merging is also what
 * `filesFromReply` does to the appended reply text (later block wins), so the array the
 * route reasons about and the map the settle stores stay the same set.
 */
function mergeGeneratedFiles(
  base: { path: string; content: string }[],
  corrected: { path: string; content: string }[],
): { path: string; content: string }[] {
  const byPath = new Map(base.map((file) => [file.path, file]));
  for (const file of corrected) byPath.set(file.path, file);
  return [...byPath.values()];
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
      isEdit: clientIsEdit,
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
    let isEdit = clientIsEdit ?? false;
    // Reject a bad prompt before anything is acquired. This guard used to sit after the
    // credit check, the project lock (with its 60s renew timer), the Job row, the
    // provider-queue slot and the job heartbeat, and its bare `return` leaked all five
    // for the life of the process (F-001). It must stay ahead of every acquisition below.
    //
    // `readUserPrompt` is the whole contract: a string, non-empty after trimming, and no
    // longer than MAX_USER_PROMPT_CHARS. A whitespace-only request used to buy a full build
    // on no instruction, a non-string was coerced five different ways downstream (F-005),
    // and nothing bounded the length at all — so an oversized paste was refused by the
    // provider, after the credit was charged, as a `request_rejected` the recovery panel
    // offers no Try again for (F-007). Everything below reads the trimmed `prompt`.
    const promptCheck = readUserPrompt(promptInput);
    if (!promptCheck.ok) {
      return NextResponse.json({ success: false, error: promptCheck.message }, { status: 400 });
    }
    const prompt = promptCheck.prompt;
    // Explicit only: defaulting this to appConfig.ai.defaultModel pushed that
    // model to the front of the chain and demoted the configured primary
    // (AI_PRIMARY_* / Admin -> Configuration). The concrete `model` used for
    // logging and legacy provider objects is derived from the chain below.
    const requestedModel =
      typeof requestedModelRaw === 'string' && requestedModelRaw.trim()
        ? requestedModelRaw.trim()
        : undefined;
    // Validated here, ahead of the session, the credit check, the project lock, the Job
    // row and the provider-queue slot: an unoffered model must not cost any of those.
    // It used to be trimmed and nothing else, then handed to the chain and on to
    // `client(entry.model)`, so any authenticated member could run every build on a
    // model the operator never configured and never priced — and a nonexistent id came
    // back from DeepSeek as `request_rejected`, which reads as an outage (F-003).
    if (requestedModel && !isDeepSeekModel(requestedModel)) {
      return NextResponse.json(
        { success: false, error: unknownModelMessage(requestedModel) },
        { status: 400 },
      );
    }
    // The run's project, resolved once and required. A request with neither `projectId`
    // nor `context.projectId` used to run the whole build with `generationJob` null, which
    // skipped the provider-queue slot, the credit charge inside `markJobRunning`, the caps,
    // the heartbeat, the progress batcher and every terminal settle — a metered feature
    // turned off by omitting one field (F-035). See `readGenerationProjectId` for why this
    // is a refusal rather than a workspace-scoped meter. Validated with the prompt and the
    // model, before the session and before anything is acquired.
    const projectCheck = readGenerationProjectId(requestProjectId, context?.projectId);
    if (!projectCheck.ok) {
      return NextResponse.json({ success: false, error: projectCheck.message }, { status: 400 });
    }
    const projectId = projectCheck.projectId;

    const sessionUser = await getSessionUser();
    if (!sessionUser) {
      return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
    }

    // The project id comes from the request body, so the session gate above is
    // not the whole authorization: without this, any signed-in member could name
    // another member's project and have this handler charge the workspace, take
    // that project's lock away from its owner, open a Job on it and settle
    // generated code over its `lastCode`. `persistProjectGeneration`
    // (lib/projects/actions.ts) already refuses a non-owner for exactly that
    // reason; this is the same decision on the route that does the writing
    // (F-313). It runs before the rate limiter, the credit check and the lock:
    // a refusal that has already spent or locked something is not a refusal.
    const ownedProject = await prisma.project.findFirst({
      where: { id: projectId, deletedAt: null },
      select: { id: true, ownerId: true, phase: true },
    });
    if (!ownedProject) {
      return jsonError('Project not found', 'NOT_FOUND', 404);
    }
    if (sessionUser.id !== ownedProject.ownerId && sessionUser.role !== 'ADMIN') {
      return jsonError('Forbidden', 'FORBIDDEN', 403);
    }
    // Rate, not total. `checkCredits` bounds the month's spend and the
    // `one_active_job_per_project` index bounds concurrency per *project* — so a loop
    // creating a project and firing one generation each could spend the whole allowance as
    // fast as HTTP allows, with the spend ceiling (which trails by the job's own duration)
    // as the only backstop. Keyed on the member, ahead of the credit check and every
    // acquisition (F-010).
    if (!allowGenerationSubmit(sessionUser.id).allowed) {
      log.warn('generation.rate_limited', { userId: sessionUser.id });
      return jsonError(GENERATION_RATE_LIMIT_MESSAGE, 'RATE_LIMITED', 429);
    }
    const creditCheck = await checkCredits(WORKSPACE_ROW_ID, sessionUser.id, 'generation');
    if (!creditCheck.ok) return creditDeniedJson(creditCheck);

    // `holdProjectLock` rather than the hand-rolled acquire + heartbeat + release triple.
    // `acquireLock` is re-entrant for the same user, so when this user already held a live
    // lock on the project — their own audit or publish, or a hold leaked by an earlier run —
    // the old code took `ok: true`, started a second timer renewing a hold it did not own,
    // and then released the *other* feature's lock in its cleanup (security review NAV-03).
    // The hold knows whether it owns anything, so `release()` is a no-op on re-entry.
    const hold = await holdProjectLock(projectId, sessionUser.id, 'generation');
    if (!hold.ok) return lockConflictJson(hold);
    releaseGenerationLock = hold.release;
    // Aborted the moment a renewal proves this hold is gone. A generation writes
    // `Project.lastCode` minutes after it takes the lock, so from that moment another run
    // may be writing the same row: this one has to stop and refuse to persist rather than
    // finish under a lock that no longer protects the write (F-730).
    const lockLost = hold.lost;

    // Server-side override: the client's isEdit decision can be wrong when the
    // file map hasn't loaded yet (race on first build), the fetch 403'd (member
    // on teammate's project), or the browser is stale. The server always has the
    // truth — lastCode and phase — so override to prevent the model from
    // replacing an existing site with a brand-new one (F-665 pattern).
    //
    // `lastCode` used to ride along in the ownership select above so this could read it
    // as `Boolean(...)`. It is the entire `<file …>` serialisation of the site, bounded
    // only by `LAST_CODE_MAX_BYTES` (4 MB), so every send on an established project — a
    // one-line follow-up edit included — pulled the whole site body out of Postgres to
    // answer a yes/no, ahead of the rate limit, the credit check and any provider call.
    // Three things fix that. The answer is only needed when the client claimed a fresh
    // build, since forcing `isEdit` true is the only thing it is used for. `count`
    // answers "is there a body" without transferring one — `NOT null` plus `NOT ''` is
    // exactly what `Boolean(lastCode)` meant. And it sits here rather than beside the
    // ownership check because `isEdit` is first read by `createOrReuseJob` below: a
    // caller the rate limiter, the credit check or the lock is about to refuse must not
    // pay for a query first.
    if (!isEdit) {
      const serverHasSite =
        ownedProject.phase === 'COMPLETE' ||
        (await prisma.project.count({
          where: {
            id: projectId,
            deletedAt: null,
            AND: [{ NOT: { lastCode: null } }, { NOT: { lastCode: '' } }],
          },
        })) > 0;
      if (serverHasSite) {
        log.info('generation.isEdit_override', {
          projectId,
          userId: sessionUser.id,
          clientIsEdit: false,
          serverHasSite: true,
          phase: ownedProject.phase,
        });
        isEdit = true;
      }
    }

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

    // Open the SSE body before waiting for a provider slot. A first build
    // opened while another DeepSeek run still held the slot used to sit on the
    // client's local "Starting AI generation..." line for the whole wait,
    // because this handler did not return until `providerSlot.started` resolved.
    const encoder = new TextEncoder();
    const stream = new TransformStream();
    const writer = stream.writable.getWriter();
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
    const clientGone = new Promise<void>((resolve) => {
      if (request.signal.aborted) {
        resolve();
        return;
      }
      request.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    const writeChunk = async (chunk: Uint8Array) => {
      const written = writer
        .write(chunk)
        .catch((error: unknown) =>
          noteClientDisconnected(error instanceof Error ? error.message : String(error)),
        );
      await Promise.race([written, clientGone]);
    };
    const sendProgress = async (data: Record<string, unknown>) => {
      if (clientDisconnected) return;
      await writeChunk(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      if (
        !clientDisconnected &&
        (data.type === 'stream' || data.type === 'conversation' || data.type === 'status')
      ) {
        await writeChunk(encoder.encode(': keepalive\n\n'));
      }
    };

    (async () => {
      const runUsage = new RunUsage();
      let jobCancelled = new AbortController();
      let servedProvider = primaryProvider?.provider ?? null;
      let servedModel = primaryProvider?.model ?? null;
      try {
        await sendProgress({ type: 'status', message: WAITING_FOR_MODEL_STATUS });

        if (generationJob?.status === 'QUEUED' && primaryProvider) {
          providerSlot = getDefaultProviderQueue().acquire(primaryProvider.provider, {
            jobId: generationJob.id,
            onPosition: (n) => {
              void updateJobFields(generationJob!.id, { queuePosition: n });
            },
          });
          if (providerSlot.position > 0) {
            await updateJobFields(generationJob.id, { queuePosition: providerSlot.position });
            await sendProgress({
              type: 'status',
              message: queuePositionLabel(providerSlot.position),
            });
          }
          const started = await providerSlot.started;
          if (!started.ok) {
            // The waiter timed out without ever taking a slot, and `release()` decrements the
            // running count unconditionally — dropping the handle here is what keeps every
            // cleanup path from corrupting the queue counter.
            providerSlot = null;
            const message = started.errorMessage || QUEUE_TIMEOUT_MESSAGE;
            await sendProgress({ type: 'error', error: message });
            await releaseSetup({
              errorCode: 'queue_timeout',
              errorMessage: message,
            });
            return;
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
        jobCancelled = new AbortController();
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
            typeof firstFile[1] === 'string'
              ? firstFile[1].substring(0, 100) + '...'
              : 'not a string',
          );
        }

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
          // The paths this session's recorded edits actually wrote. This used to read
          // `msg.metadata.editedFiles`, which nothing in the codebase ever set, so the
          // "DO NOT RECREATE" section below could never fire.
          const recentlyCreatedFiles = [
            ...new Set(conversation.context.edits.flatMap((edit) => edit.targetFiles || [])),
          ];

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
          // The project's own brief, not this turn's prompt. An initial build's
          // prompt carries the approved plan JSON appended to it, and those extra
          // words re-scored the palette and the style — so the plan and the build
          // could commit to two different designs for the same project.
          prompt: generationProfile.initialPrompt || prompt,
          styleHint: styleHint || context?.styleName || context?.conversationContext?.style,
          // The style the user actually picked. Without it the brief fell out of a
          // keyword tie onto STYLES[0] and shipped Glassmorphism to almost every
          // prompt (F-829).
          designDirection: projectDirection,
          isEdit,
        }).brief;

        const memoryProjectId =
          (typeof requestProjectId === 'string' && requestProjectId) ||
          (typeof context?.projectId === 'string' && context.projectId) ||
          '';
        let memoryBlock = '';
        if (memoryProjectId) {
          try {
            memoryBlock = (await buildMemoryBlock(memoryProjectId)).block;
          } catch (error) {
            logError('generation.memory_block_failed', error, { projectId: memoryProjectId });
          }
        }
        // Whether this run writes files through tools or through parsed fences.
        // Resolved here rather than beside `streamOptions` because the output
        // contract is part of the cacheable prefix: the model has to be told
        // which one it is on before it is told anything else.
        const useTools = await agentToolsEnabled(model);
        // Stable prefix is byte-identical for the same stack + direction + ACTIVE
        // memory + output mode.
        const stablePrefix = buildStablePromptPrefix(projectStack, projectDirection, {
          memoryBlock,
          outputMode: useTools ? 'tools' : 'fences',
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
            // Items 1 and 5 used to be "USE TAILWIND PROPERLY - standard Tailwind
            // color classes" and "STANDARD CLASSES - bg-white, text-gray-900,
            // bg-blue-500, NOT bg-background". Both are gone: they contradicted
            // the stable prefix, which now *requires* the semantic tokens the
            // starter stylesheet defines. Per-request prose that fights the
            // cacheable prefix is the worst of both — it is not cached and it
            // wins, because it arrives last.
            contextParts.push('1. **NO PLACEHOLDERS** - Use real content, not lorem ipsum');
            contextParts.push(
              '2. **COMPLETE COMPONENTS** - Header, Hero, Features, Footer minimum',
            );
            contextParts.push('3. **VISUAL POLISH** - Shadows, hover states, transitions');
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
        // The model call can sit on reasoning tokens for a long time before the
        // first file. Leave "Planning..." up and the Code pane looks stuck.
        await sendProgress({ type: 'status', message: WAITING_FOR_MODEL_STATUS });

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

        /**
         * The turn's file state for the tool path.
         *
         * Built even when `useTools` is false, because it costs one object copy
         * and it keeps every downstream substitution below a plain ternary
         * rather than a nullable it has to guard.
         *
         * The base carries the starter kit, not just the project's stored files.
         * Starter files are deliberately kept out of `Project.lastCode` — a
         * non-empty `lastCode` is the product's evidence that a site exists — so
         * `backendFiles` alone does not contain `components/ui/button.tsx` or
         * `lib/utils.ts`, while the prompt's own ALREADY IN THE PROJECT rule and
         * both bundlers (via `withStarterFiles`) say they are there. Measured
         * live: the model read `components/ui/button.tsx`, `input.tsx`,
         * `label.tsx` and `tailwind.config.js`, was told "No file at ...", and
         * spent four of its steps finding that out — the setup for hand-rolling
         * a Button, which is exactly what naming those paths exists to prevent.
         *
         * Only the *base* widens. `writtenFiles()` still returns writes alone, so
         * the persist payload and `changedPaths` are unchanged and an untouched
         * starter file is never re-stored.
         */
        const toolStore = createGenerationFileStore({
          base: withStarterFiles(projectStack, backendFiles, projectDirection),
          stack: projectStack,
        });
        const agentStepBudget = useTools ? await maxAgentSteps() : 0;
        /**
         * Rearms the provider idle bound from inside a tool's `execute`.
         *
         * Set per attempt by the collect callback below, which is the only place
         * a `collectCtx` exists. Null until the first attempt starts, so the
         * optional call is real rather than defensive.
         */
        let toolProgress: (() => void) | null = null;
        /**
         * Per-tool call/refusal counts for this run, filled by the `notify`
         * closure below and written once as a quality signal when the run
         * finishes (`recordToolRefusalRates`).
         *
         * Counted here because this is the only place the results exist: a
         * refusal is *returned* to the model, never thrown, so it leaves no trace
         * in the job row, no trace in the logs, and reached the browser as one
         * `tool_result` frame that the workspace renders and discards.
         */
        const toolResults: ToolResultTally = {};

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

        if (useTools) {
          // `toolChoice: 'auto'`, never `'required'`: thinking mode rejects
          // `required` outright with "Thinking mode does not support this
          // tool_choice", which classifies as `malformed` and so would not even
          // fail over (measured — see MODEL_SUPPORTS_TOOLS).
          streamOptions.tools = buildGenerationTools({
            store: toolStore,
            notify: (event) => {
              // Both halves matter: the frame is what puts the write in the chat
              // and on the file rail, and `progress()` is what stops a step that
              // only calls tools from being reaped as a stalled stream.
              toolProgress?.();
              if (event.phase === 'result') countToolResult(toolResults, event.tool, event.ok);
              void sendProgress(
                event.phase === 'call'
                  ? { type: 'tool_call', tool: event.tool, path: event.path }
                  : {
                      type: 'tool_result',
                      tool: event.tool,
                      path: event.path,
                      ok: event.ok,
                      detail: event.detail,
                      // The whole file, once, on a successful write. The client's
                      // rail has no other source for it — tool arguments are not
                      // forwarded — so without this the Code pane showed every
                      // tool-written file as an empty body. Not a new cost: the
                      // fence path streams the same bytes as text deltas.
                      content: event.content,
                    },
              );
            },
          });
          streamOptions.toolChoice = 'auto';
          streamOptions.stopWhen = stepCountIs(agentStepBudget);
        }

        // One decision for every provider call this run makes — see `temperatureForModel`
        // for the two call sites that disagreed (F-041). Left off the object entirely for a
        // thinking-mode model, which rejects the option rather than ignoring it — so the
        // mode this request will actually be sent in is what decides, read from the same
        // `providerEnv` that builds the client.
        const thinking = thinkingEnabledFromEnv(providerEnv);
        const temperature = temperatureForModel(actualModel, { thinking });
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
        /**
         * Files the tool path removed this turn. Counted alongside `files` when
         * deciding whether the turn changed anything: a deletion leaves no file
         * behind, so a turn that only deleted would otherwise read as no-change.
         */
        let toolDeletions = 0;
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
              const nextOptions = {
                ...streamOptions,
                model: wrapReasoningModel(chatModelForEntry(entry, providerEnv, entry.model)),
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
              // A tool's own `execute` emits no stream part while it runs, so the
              // tools rearm the idle bound through this rather than through the
              // loop below. Rebound per attempt: a failover retry gets a new
              // collect context, and holding the old one would rearm a bound that
              // no longer governs anything.
              toolProgress = () => collectCtx.progress();
              generatedCode = '';
              files = [];
              const streamedFiles = new StreamedFileTracker();
              let isInTag = false;
              let conversationalBuffer = '';
              // Everything below sends `conversationalBuffer` straight to the client as the
              // assistant's chat message, and a real build put four `NEED_IMAGE: …` lines and
              // two `Skill: …` markers there — internal protocol, read verbatim by a paying
              // customer after their first build. The scrubber is stateful because the buffer
              // is flushed whenever a `<file …>` opener interrupts the prose, so a directive
              // can be cut in half by the flush; per-attempt because a failover retry starts a
              // fresh reply.
              const conversational = createConversationalScrubber();
              streamedReply.streamAttempts += 1;
              let thinkingStartedAt: number | null = null;
              let sentThinkingComplete = false;
              const finishThinking = async () => {
                if (thinkingStartedAt == null || sentThinkingComplete) return;
                sentThinkingComplete = true;
                const durationSec = Math.round((Date.now() - thinkingStartedAt) / 1000);
                await sendProgress({
                  type: 'thinking_complete',
                  duration: durationSec > 0 ? durationSec : undefined,
                });
              };

              // Stream the response and parse in real-time
              for await (const part of stream.fullStream || []) {
                // Deliberately no `break` on a disconnected client. Breaking
                // here threw away a build the moment someone reloaded the tab:
                // the loop stopped mid-site, the settle below never got a
                // complete reply, and the work — already paid for in tokens —
                // was lost. The site is persisted server-side, so finishing
                // the stream is what lets them come back to it. Writes to the
                // browser are already skipped while it is gone.
                const classified = classifyStreamPart(part);
                if (classified.kind === 'ignore') continue;
                // Every token rearms the idle bound — reasoning included. Waiting
                // on `textStream` alone treated a thinking-mode model as dead
                // (F-030) and left the Code pane on "Planning...".
                collectCtx.progress();
                if (classified.kind === 'reasoning') {
                  if (thinkingStartedAt == null) {
                    thinkingStartedAt = Date.now();
                    await sendProgress({ type: 'status', message: MODEL_THINKING_STATUS });
                  }
                  if (classified.text) {
                    await sendProgress({ type: 'thinking', text: classified.text });
                  }
                  continue;
                }
                if (classified.kind === 'reasoning-end') {
                  await finishThinking();
                  continue;
                }
                // Tool parts are handled before the text path: they carry no
                // reply text, and falling through would append `''` to the reply
                // and run the fence scanner over nothing. Reaching `progress()`
                // above is the point — a step that only writes files is
                // otherwise silent for as long as the model takes to write them.
                //
                // The `tool-input-*` parts carry the tool arguments as they
                // stream, which for `write_file` is the entire file. They are
                // deliberately not forwarded as `stream` frames: they are JSON
                // arguments, not prose, and chat shows the tool's own frames.
                if (
                  classified.kind === 'tool-call' ||
                  classified.kind === 'tool-result' ||
                  classified.kind === 'tool-error' ||
                  classified.kind === 'tool-input-start' ||
                  classified.kind === 'tool-input-delta' ||
                  classified.kind === 'tool-input-end' ||
                  classified.kind === 'step-finish'
                ) {
                  await finishThinking();
                  continue;
                }
                await finishThinking();
                const text = classified.text || '';
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
                    const speech = conversational.take(conversationalBuffer).trim();
                    conversationalBuffer = '';
                    // A flush that was nothing but protocol sends no frame at all — an empty
                    // `conversation` frame renders as an empty assistant bubble.
                    if (speech) {
                      await sendProgress({
                        type: 'conversation',
                        text: speech,
                      });
                    }
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
              await finishThinking();

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

              // Send any remaining conversational text. `finish` runs unconditionally, even
              // on an empty buffer: the scrubber may still be holding the front half of a
              // directive from the last flush, and dropping it on the floor here is how half
              // a token would reach the transcript on the next turn's re-read.
              const remaining = conversational.finish(conversationalBuffer).trim();
              if (remaining) {
                await sendProgress({
                  type: 'conversation',
                  text: remaining,
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
              //
              // `totalUsage`, never `usage`. The SDK documents `usage` as "the
              // token usage of the last step" and `totalUsage` as the sum across
              // steps. On the fence path there is exactly one step and the two
              // are identical, which is why this read was correct for years; on
              // the tool path a build is one step per `write_file` plus a
              // closing one, so `usage` reported only the closing prose — a
              // measured 338 output tokens for six files and ~430 lines of code.
              // Everything downstream is derived from this number:
              // `Job.estimatedCostUsd`, the `/admin/usage` figures, and
              // `Workspace.spendUsd`, which is the auto-pause spend ceiling. It
              // under-reports, and it under-reports silently.
              //
              // The text handed alongside is only the fallback when a provider
              // omits its own count, and on the tool path the code went out as
              // tool arguments rather than as streamed text — so that estimate
              // is low too. It is a fallback, not the normal path.
              runUsage.settle(
                await stream.totalUsage.catch(() => undefined),
                useTools
                  ? [generatedCode, ...Object.values(toolStore.writtenFiles())].join('\n')
                  : generatedCode,
              );

              // The budget is a cost guardrail, so hitting it is a warning on a
              // succeeded job rather than a failure: every file in the store went
              // through the same write gate as any other, so the partial site is
              // real work the user has already paid for. Deliberately no
              // `buildFix` retry either — an incomplete request very likely does
              // fail the build, and spending two repair generations on half a
              // brief is the opposite of a guardrail.
              if (useTools) {
                const stepCount = await stream.steps.then(
                  (steps) => steps.length,
                  // A rejected steps promise is not evidence the budget was hit.
                  () => 0,
                );
                if (exhaustedStepBudget(stepCount, agentStepBudget)) {
                  log.warn('generation.step_budget_exhausted', {
                    jobId: generationJob?.id ?? null,
                    steps: stepCount,
                    limit: agentStepBudget,
                    filesWritten: toolStore.writtenPaths().length,
                  });
                  await sendProgress({ type: 'warning', message: AGENT_STEP_BUDGET_MESSAGE });
                }
              }

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

        // From here on, the two paths are one. Everything downstream — the
        // owed-files classification, `stackShapeMismatch`, the build check, the
        // caps and the settle — reads `files`, so the tool writes are folded
        // into it once, here, rather than at each of those six call sites. The
        // store is authoritative on this path: `files` from the fence scanner is
        // empty by contract, because the reply is prose.
        if (useTools) {
          const writtenFiles = toolStore.writtenFiles();
          files = toolStore.writtenPaths().map((path) => ({ path, content: writtenFiles[path] }));
          // Once per distinct path, after the stream, never per tool call:
          // `JobCapTracker.addFile` aborts with `loop_detected` on the third
          // write to one path, and a legitimate write -> build -> rewrite cycle
          // reaches three easily. Iteration is bounded by the step budget
          // instead, which is the thing that actually costs money.
          for (const file of files) {
            const fileAbort = capTracker.addFile(file.path, file.content);
            jobProgress?.addFile(file.path, file.content);
            if (fileAbort) {
              await jobProgress?.flush();
              throw fileAbort;
            }
          }
          // A deletion is a change with no file to show for it, so it has to be
          // counted separately or `classifyReplyOutcome` below reads a turn that
          // removed a file as "changed nothing" and fails a run that did exactly
          // what was asked.
          toolDeletions = toolStore.deletedPaths().length;
        }

        // A reply can owe two things, and both are asked for in one corrective turn against
        // the provider that just answered. Files: the reply parsed to zero of them but
        // claimed a change, or pasted source that missed the `{path=…}` contract. Pictures:
        // it wrote its `NEED_IMAGE:` requests as prose instead of into a `src`, so the
        // site it did send has no image where one was asked for — the live cafe build,
        // eleven files with no `<img>` and an empty Assets tab. Buying those pictures
        // instead of asking for them back produced the same empty page with a bill on it,
        // so the repair is the same one owed files get: make the model put the token where
        // the contract says it goes, then let the file-side fulfilment place it.
        //
        // This is deliberately not failover. Failover answers "is this vendor working", and
        // a model that talked is a working vendor: walking the chain for it pays a second
        // provider to repeat the mistake. Credits were charged once for this job, at
        // `markJobRunning({ chargeCredits: true })` before the first call, and nothing here
        // charges again — the ask is part of the same job, and it reaches no image provider
        // at all. It happens at most once, whichever complaint prompted it: two consecutive
        // corrective streams on one build is a worse trade than reporting the second miss.
        //
        // `askedForFilesAgain` is named for the complaint it was written for and now marks
        // that single ask as spent, whatever was owed — it is what stops a model that likes
        // talking from being paid to talk in a loop.
        let askedForFilesAgain = false;
        /** Whether the ask that went out carried the pictures complaint, for the notice below. */
        let askedToPlaceImages = false;
        const correctiveEntry =
          (servedProvider && servedModel
            ? providerChain.find(
                (entry: ProviderEntry) =>
                  entry.provider === servedProvider && entry.model === servedModel,
              )
            : null) ??
          providerChain[0] ??
          null;
        // The corrective ask is fence-specific: it re-asks for `{path=…}` blocks.
        // On the tool path a file either went through `write_file` or the model
        // genuinely wrote none, and asking it to "use the fenced format" would
        // contradict the output contract it was given and buy a second
        // generation to do it.
        const owedFiles =
          !useTools &&
          classifyReplyOutcome({
            fileCount: files.length,
            reply: generatedCode,
            askedAgain: false,
          }) === 'ask_again';
        // A turn that changed nothing owes no pictures. "Which hero shot did you have in
        // mind? Something like NEED_IMAGE: …" is a question, which `classifyReplyOutcome`
        // reads as an answer — and starting a second generation over one is the same false
        // failure that classifier exists to stop. Files sent, or files owed, is the exact
        // complement of it here: the only other fileless outcome is a silent stream, which
        // has no prose to read a request out of.
        const owedImages =
          files.length > 0 || owedFiles ? imagesOwedByReply({ reply: generatedCode, files }) : [];
        if (
          correctiveEntry &&
          // Nobody is listening, so this would buy tokens for a reply no one reads and a
          // build no one asked to see — the same reason the first call is skipped above.
          !clientDisconnected &&
          (owedFiles || owedImages.length > 0)
        ) {
          askedForFilesAgain = true;
          askedToPlaceImages = owedImages.length > 0;
          log.warn('generation.missing_files_ask_again', {
            jobId: generationJob?.id ?? null,
            provider: correctiveEntry.provider,
            model: correctiveEntry.model,
            owedFiles,
            owedImages: owedImages.length,
            ...summarizeGenerationOutput(generatedCode),
          });
          // Recorded even when the ask then succeeds. Without it this class of miss is
          // invisible in /admin/jobs, and the only evidence we ever had of it was a user's
          // photograph of the chat. One step per complaint, under its own key, because
          // `recordJobStepFailure` merges by key and a page with no pictures and a reply
          // with no files are different faults to read on the row.
          if (owedFiles) {
            await recordJobStepFailure(generationJob?.id, {
              key: 'return-files',
              label: 'Return the changed files',
              error: MISSING_FILES_STEP_ERROR,
            });
          }
          if (owedImages.length > 0) {
            await recordJobStepFailure(generationJob?.id, {
              key: 'place-images',
              label: 'Place the requested images',
              error: MISSING_IMAGES_STEP_ERROR,
            });
          }
          // Plain words, never the protocol: the `NEED_IMAGE:` lines themselves are already
          // stripped out of the transcript, so naming them here would put back exactly what
          // the strip removes.
          await sendProgress({
            type: 'info',
            message: [
              owedFiles ? MISSING_FILES_ASKED_AGAIN : null,
              owedImages.length > 0 ? unplacedImagesAskedAgain(owedImages.length) : null,
            ]
              .filter(Boolean)
              .join(' '),
          });
          try {
            // A second full generation: the whole message list again, plus the
            // echo and the correction. It was previously free of charge in the
            // books because the usage read only ever looked at the main stream.
            //
            // One turn carrying both complaints, each with the contract it broke quoted
            // verbatim under it — `MISSING_FILES_CORRECTION` for the fenced output format,
            // `imagePlacementCorrection` for where a token has to sit. Restating either in
            // this file's own words is how two descriptions of one contract drift apart.
            const correction = [
              owedFiles ? MISSING_FILES_CORRECTION : null,
              owedImages.length > 0 ? imagePlacementCorrection(owedImages) : null,
            ]
              .filter(Boolean)
              .join('\n\n');
            const correctiveEcho = generatedCode.slice(0, CORRECTIVE_ECHO_CHARS);
            runUsage.willSend(`${promptTextForEstimate}\n${correctiveEcho}\n${correction}`);
            const capture = bindStreamErrorCapture();
            const corrective = capture.attach(
              streamText({
                ...streamOptions,
                model: wrapReasoningModel(
                  chatModelForEntry(correctiveEntry, providerEnv, correctiveEntry.model),
                ),
                maxOutputTokens: Math.min(outputTokenCap, maxOutputTokensForEntry(correctiveEntry)),
                // Decided from the entry that will actually serve this ask, not inherited
                // from `streamOptions`: the corrective entry need not be the model the main
                // call's decision was made for (F-041).
                temperature: temperatureForModel(correctiveEntry.model, { thinking }),
                messages: [
                  ...(streamOptions.messages ?? []),
                  // Its own words back, capped: the claim is what it has to answer for, and
                  // a reply that ran to tens of thousands of tokens must not be bought a
                  // second time as input.
                  { role: 'assistant', content: correctiveEcho },
                  { role: 'user', content: correction },
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
              // Adopted only when it produced what was owed, judged per complaint. Files
              // owed and files arrived is already answered by the branch above, and taking
              // them costs nothing because a reply that owed files had none. Pictures are
              // the case that can still miss: a model can obey "send the files" while
              // describing the images in prose a second time, and swapping the eleven files
              // the user watched arrive for whatever the nudge resent would leave the page
              // without a photograph anyway. So the first reply stands only when it was the
              // pictures alone that were owed — never when doing so would also throw away
              // the files this ask finally produced.
              const placedImages = imagesPlacedIn(correctedFiles, owedImages);
              if (!owedFiles && owedImages.length > 0 && placedImages === 0) {
                log.warn('generation.missing_images_ask_again_missed', {
                  jobId: generationJob?.id ?? null,
                  owedImages: owedImages.length,
                  correctedFiles: correctedFiles.length,
                  ...summarizeGenerationOutput(correctedCode),
                });
              } else {
                // Appended rather than substituted whenever the first reply produced files —
                // which is every pictures-only ask, where those files *are* the site and the
                // correction resends only the two or three that carry a token. `filesFromReply`
                // keys on the declared path and lets the later block win, so the corrected file
                // replaces its twin and the ones it did not resend survive; the settle re-parses
                // this same text, so the array and the stored map agree. With no files in the
                // first reply there is nothing to keep, and the corrected reply stands alone.
                if (files.length > 0) {
                  generatedCode = `${generatedCode}\n\n${correctedCode}`;
                } else {
                  generatedCode = correctedCode;
                }
                files = mergeGeneratedFiles(files, correctedFiles);
                // Counted against the job's caps exactly like the first pass: the file cap and
                // the per-path loop guard apply to the whole job, not per stream, and
                // `partialFiles` is what "keep what was built" recovers. Only the corrected
                // files, because the first reply's were counted as they streamed.
                for (const file of correctedFiles) {
                  const fileAbort = capTracker.addFile(file.path, file.content);
                  jobProgress?.addFile(file.path, file.content);
                  if (fileAbort) {
                    await jobProgress?.flush();
                    throw fileAbort;
                  }
                }
                await sendProgress({
                  type: 'info',
                  message: `The second ask returned ${correctedFiles.length} file${correctedFiles.length === 1 ? '' : 's'}.`,
                });
              }
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

        // Extract explanation, and only an explanation the model actually wrote.
        //
        // No prompt in `lib/stack-prompts/*` asks for an `<explanation>` block — the
        // output contract is fenced ```lang{path=…} files and prose — so this matched
        // nothing on every real run and the `'Code generated successfully!'` default it
        // used to carry is what shipped. It rode the `complete` frame, and the workspace
        // posts that as an `ai` message under a guard a non-empty default can never fail,
        // so every finished build closed with a canned sentence attributed to the model,
        // immediately after the model's own closing words: the duplicate closing line
        // F-053 removed, rebuilt out of a fallback value. Nothing is invented here now,
        // and `explanation` no longer rides the frame at all.
        //
        // When the tag *is* present its text reaches chat the way every other word the
        // model speaks does — one scrubbed `conversation` frame. That was the second half
        // of the bug: the `isInTag` gate in the stream loop keeps an `<explanation>` block
        // out of `conversationalBuffer`, so this extraction was the one route to the
        // transcript that `createConversationalScrubber` did not cover, and a
        // `NEED_IMAGE:` or `Skill:` directive written inside the block would have been
        // read verbatim by the user.
        const explanationMatch = generatedCode.match(/<explanation>([\s\S]*?)<\/explanation>/);
        if (explanationMatch) {
          const spoken = createConversationalScrubber().finish(explanationMatch[1]).trim();
          if (spoken) await sendProgress({ type: 'conversation', text: spoken });
        }

        // Validate generated code for truncation issues. Keyed to the fenced `{path=…}`
        // contract the prompt actually specifies: this used to count `<file path="` tags,
        // a shape no prompt asks for, so the warnings were always empty, the recovery
        // below was unreachable and a reply cut off mid-file shipped as a finished build.
        //
        // Skipped entirely on the tool path. There is no fence to be left
        // unclosed: a `write_file` call either arrived with complete content or
        // did not arrive, and the scanner run over a prose reply would either
        // find nothing (wasted) or match prose that looks like code and buy a
        // recovery generation to "complete" a file that was never truncated.
        const truncatedFiles = useTools ? [] : detectTruncatedFiles(generatedCode);
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

                // One call per truncated file, each with its own prompt. None of
                // them were counted: `collectRecoveredStreamText` drains the
                // stream and never touches usage.
                runUsage.willSend(completionPrompt);
                const capture = bindStreamErrorCapture();
                const completionResult = capture.attach(
                  streamText({
                    model: wrapReasoningModel(
                      chatModelForEntry(recoveryEntry, providerEnv, recoveryEntry.model),
                    ),
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
                    temperature: temperatureForModel(recoveryEntry.model, { thinking }),
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

        // Deterministic repairs, applied in place.
        //
        // The tool path applies these inside `GenerationFileStore.write`; this is
        // the fence path's half, and it has to rewrite the reply rather than the
        // parsed map because `settleStreamedGeneration` re-parses `generatedCode` —
        // a fix applied only to `files` would be thrown away at persist time. What
        // they remove: `import { Implant } from "lucide-react"` compiled, the build
        // check called it clean, and the preview died with "does not provide an
        // export named 'Implant'" as the first thing the user saw; and a raw <img>
        // on a stack whose prompt has asked for next/image for a long time.
        if (!useTools && files.length > 0) {
          const repaired = repairGeneratedFiles(
            Object.fromEntries(files.map((file) => [file.path, file.content])),
            projectStack,
          );
          if (hasRepairs(repaired.repairs)) {
            const rewritten = repairedPaths(repaired.repairs);
            for (const path of rewritten) {
              const next = replaceBlockInReply(generatedCode, path, repaired.files[path]);
              // A path with no block in the reply cannot be rewritten; leaving the
              // original is the honest outcome, and the build check still sees it.
              if (next !== null) generatedCode = next;
            }
            files = files.map((file) =>
              rewritten.has(file.path) ? { ...file, content: repaired.files[file.path] } : file,
            );
            for (const notice of describeRepairs(repaired.repairs)) {
              await sendProgress({ type: 'info', message: notice });
            }
          }
        } else if (useTools) {
          for (const notice of describeRepairs(toolStore.repairs())) {
            await sendProgress({ type: 'info', message: notice });
          }
        }

        // Recovery off is not silence: when nothing re-asks for the cut-off files, this
        // step is the only trace detection leaves where an operator looks. With recovery
        // on, the truncation-recovery step above already records the outcome, and a full
        // repair clears the warnings entirely.
        if (truncationWarnings.length > 0 && !appConfig.codeApplication.enableTruncationRecovery) {
          await recordJobStepFailure(generationJob?.id, {
            key: 'truncation-detected',
            label: 'Check the reply for cut-off files',
            error: truncationDetectedStepError(truncationWarnings),
          });
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
        // A departed client never got the corrective ask, so a reply that owed files
        // cannot discharge the debt here: counting the ask as spent classifies it as the
        // no-files failure it is, instead of settling success over an unchanged site.
        const hasSite = Object.keys(backendFiles).length > 0;
        const replyOutcome = classifyReplyOutcome({
          fileCount: files.length + toolDeletions,
          reply: generatedCode,
          askedAgain: askedForFilesAgain || clientDisconnected,
          hasSite: hasSite,
        });
        const chatAnswer = replyOutcome === 'answer' && hasSite;
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
                  // First builds only. The approved plan's routes are a contract
                  // the prompt states and nothing checked: a page the user agreed
                  // to and the model silently never wrote is linked from nowhere,
                  // so `missing-route` — which scrapes hrefs — cannot see it, and
                  // the site ships smaller than the plan. On an edit the same
                  // check would be wrong: a one-page edit legitimately does not
                  // rebuild the rest of the site.
                  ...(isEdit ? {} : await planContractForBuild(projectId)),
                  // Without this the static scan cannot see the starter kit and
                  // reports `@/lib/utils` as an unresolved import, spending a
                  // repair generation rewriting correct code.
                  designDirection: projectDirection,
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
                // On the tool path the store is the record of what was written;
                // `generatedCode` is prose and parses to nothing.
                producedFileMap: useTools ? toolStore.writtenFiles() : null,
                // The other half of the tool path's output. Kept out of
                // `producedFileMap` because a key there means "store this
                // content", and an empty string is a legal file rather than a
                // "remove this" sentinel.
                deletedPaths: useTools ? toolStore.deletedPaths() : null,
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
          // Stop / Start over settled the row between stream end and settle. That is the
          // person's own stop, not a persist failure: no step failure, no trackFailure,
          // and none of the "workspace never became ready" copy.
          if (streamSettle.errorCode === 'cancelled') {
            log.info('generation.settled_cancelled_elsewhere', {
              jobId: generationJob?.id ?? null,
            });
            await sendProgress({ type: 'info', message: CANCELLED_BEFORE_SAVING_LINE });
            return;
          }
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

        // The honest floor under the corrective ask: pictures the model described in words
        // and never placed. Reached whichever way that happened — the ask was skipped, the
        // ask failed, or the model wrote prose a second time — and `asked` is what keeps
        // the sentence from claiming a retry that never went out. Read off the final reply
        // and the final file list, so a correction that put the tokens in a `src` says
        // nothing here and the file-side fulfilment gets on with making them.
        //
        // Nothing bought these. A picture nothing references is spend with no product: the
        // round before this one fulfilled prose requests as real assets, up to six image
        // credits for a page that still had no photograph on it and a chat line asking the
        // customer to place them. So the person is told the truth instead of billed for
        // assets that are not on the page. Plain words, never the protocol: the
        // `NEED_IMAGE:` lines are stripped from the transcript, and naming them here would
        // put back exactly what the strip removes.
        //
        // The settle counts the same requests off the same final reply and says so itself
        // (`replyDescribedImagesNotice`), so this speaks only when that sentence did not
        // arrive — one fact, one line in the transcript. It is still logged either way,
        // because `asked` is the part only this side knows and it is what tells an operator
        // whether the corrective ask is working.
        const unplacedImages = imagesOwedByReply({ reply: generatedCode, files });
        if (unplacedImages.length > 0) {
          log.warn('generation.images_unplaced', {
            jobId: generationJob?.id ?? null,
            count: unplacedImages.length,
            asked: askedToPlaceImages,
            reportedBySettle: Boolean(streamSettle?.imageNotice),
          });
          if (!streamSettle?.imageNotice) {
            await sendProgress({
              type: 'warning',
              message: unplacedImagesNotice({
                count: unplacedImages.length,
                asked: askedToPlaceImages,
              }),
            });
          }
        }

        // What the settle made of the tokens that did reach a file: how many became real
        // pictures and how many no provider could serve. Deleting a request without saying
        // anything would trade one silent failure for another. `warning` when a picture is
        // genuinely missing, `info` otherwise: both land in chat as a system line
        // (`generation-runtime.ts`).
        if (streamSettle?.imageNotice) {
          log.info('generation.images_reported', {
            jobId: generationJob?.id ?? null,
            ...streamSettle.images,
          });
          await sendProgress({
            type: (streamSettle.images?.unfulfilled ?? 0) > 0 ? 'warning' : 'info',
            message: streamSettle.imageNotice,
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
        //
        // No `explanation` field: the workspace turns one into an `ai` chat message,
        // and the only value this frame ever carried was the canned default removed
        // above. What the model said is already in chat, sent as `conversation`
        // frames by the stream loop as it said it.
        await sendProgress({
          type: 'complete',
          generatedCode: shouldSendGeneratedCode(streamedReply) ? generatedCode : undefined,
          files: files.length,
          components: componentCount,
          model,
          warnings: truncationWarnings.length > 0 ? truncationWarnings : undefined,
          skillNames: injectedSkills.names,
          // Present only when the build check failed and the policy allows a repair
          // generation; the workspace runs one more pass with this instruction.
          buildFix: buildFix ?? undefined,
        });

        // What the model had to fight to produce that. Filed against the same
        // `GenerationEvent` the token spend is filed against — `usageEventId` was
        // pinned before the first call for exactly this reason (F-749), so a
        // follow-up that started while this run streamed cannot take the row.
        //
        // Awaited rather than detached: the completion frame has already gone
        // out, so nothing the user waits on is behind this, and a floating
        // promise on the tail of a request is the kind of write that silently
        // never happens. `withSignalGuard` swallows its own failures, so awaiting
        // it cannot turn a finished generation into a failed one.
        //
        // Success path only. A run that threw stopped mid tool sequence, and its
        // counts describe how far it got rather than what the prompt version made
        // the model do; mixing the two populations would move the rate whenever
        // the provider had a bad day.
        await recordToolRefusalRates(projectId, toolResults, usageEventId);

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
