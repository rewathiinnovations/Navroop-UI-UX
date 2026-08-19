import { NextRequest, NextResponse } from 'next/server';
import { createOpenAI } from '@ai-sdk/openai';
import { streamText } from 'ai';
import type { SandboxState } from '@/types/sandbox';
import { selectFilesForEdit, getFileContents, formatFilesForAI } from '@/lib/context-selector';
import {
  executeSearchPlan,
  formatSearchResultsForAI,
  selectTargetFile,
} from '@/lib/file-search-executor';
import { FileManifest } from '@/types/file-manifest';
import type {
  ConversationState,
  ConversationMessage,
  ConversationEdit,
} from '@/types/conversation';
import { appConfig } from '@/config/app.config';
import { buildUiUxProMaxBrief } from '@/lib/ui-ux-pro-max/build-design-brief';
import { getSessionUser } from '@/lib/auth';
import { looksLikeUrl } from '@/lib/projects/prompt';
import { attachGenerationInputTokens, logGenerationEvent } from '@/lib/usage-costs';
import { buildCachedMessages } from '@/lib/generation/prompt-cache';
import { filesFromReply, replaceBlockInReply } from '@/lib/generation/parse-blocks';

/** Markdown code fence, kept in a constant so prompt strings stay readable. */
const FENCE = '```';
import { conversationStateFor } from '@/lib/generation/conversation-state';
import { StreamedFileTracker } from '@/lib/generation/stream-file-tracker';
import { selectFileContext } from '@/lib/generation/selective-context';
import { resolveInputTokens } from '@/lib/generation/token-estimate';
import { buildStablePromptPrefix, buildVolatilePromptSuffix } from '@/lib/stack-prompts';
import { resolveRequestGenerationProfile } from '@/lib/stack-resolve';
import { packageNameFromImport, shouldSkipPackageInstall, stackShapeMismatch } from '@/lib/stacks';
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
import { analyzeEditIntent } from '@/lib/generation/analyze-edit-intent';
import { log, logError } from '@/lib/logger';
import { trackFailure, trackStart, trackSuccess } from '@/lib/observability/track';
import { holdProjectLock } from '@/lib/projects/lock';
import { lockConflictJson } from '@/lib/projects/lock-http';
import { beginJobHeartbeat, createOrReuseJob, failJob, markJobRunning } from '@/lib/jobs/lifecycle';
import { settleStreamedGeneration } from '@/lib/jobs/settle-generation';
import { createProgressBatcher } from '@/lib/jobs/progress';
import { ensureJobSettled } from '@/lib/jobs/settle';
import { recordJobStepFailure } from '@/lib/jobs/step-failure';
import { getJob, updateJobFields } from '@/lib/jobs/store';
import { toPublicJob } from '@/lib/jobs/types';
import { getRequestId } from '@/lib/request-context';
import { JobCapError, JobCapTracker } from '@/lib/consumption/caps';
import { getPlanCaps } from '@/lib/consumption/plan-caps';
import { recordJobUsage } from '@/lib/consumption/record';
import { getDefaultCircuit } from '@/lib/ai/circuit';
import { jobErrorCodeForProviderFailure, providerFailureMessage } from '@/lib/ai/failover';
import { getDefaultProviderQueue, QUEUE_TIMEOUT_MESSAGE } from '@/lib/ai/queue';
import {
  getProviderApiKey,
  maxOutputTokensForEntry,
  modelIdForEntry,
  providerConcurrency,
  providerDisplayName,
  ProviderNotConfiguredError,
  requireUsableProviderChain,
  type ProviderEntry,
  type ProviderName,
} from '@/lib/ai/providers';
import { loadEffectiveProviderEnv } from '@/lib/ai/effective-env';
import { clientForEntry } from '@/lib/ai/client-for-entry';
import { bindStreamErrorCapture, EmptyCompletionError } from '@/lib/ai/empty-completion';
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
import { describeNoChanges } from '@/lib/generation/no-changes';
import { summarizeGenerationOutput } from '@/lib/generation/output-summary';

// Force dynamic route to enable streaming
export const dynamic = 'force-dynamic';

// Check if we're using Vercel AI Gateway
const isUsingAIGateway = !!process.env.AI_GATEWAY_API_KEY;
const aiGatewayBaseURL = 'https://ai-gateway.vercel.sh/v1';

log.info('generation.provider_config', {
  isUsingAIGateway,
  hasGroqKey: !!process.env.GROQ_API_KEY,
  hasAIGatewayKey: !!process.env.AI_GATEWAY_API_KEY,
});

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

declare global {
  var sandboxState: SandboxState;
  var conversationState: ConversationState | null;
}

export async function POST(request: NextRequest) {
  return withRequest(request, () => generateAiCodeStream(request));
}

async function generateAiCodeStream(request: NextRequest) {
  const startedAt = Date.now();
  let releaseGenerationLock: (() => Promise<void>) | null = null;
  let generationJob: Awaited<ReturnType<typeof createOrReuseJob>> | null = null;
  let jobHeartbeat: { stop: () => void } | null = null;
  let jobProgress: ReturnType<typeof createProgressBatcher> | null = null;
  let providerSlot: ReturnType<ReturnType<typeof getDefaultProviderQueue>['acquire']> | null = null;
  try {
    const {
      prompt,
      model: requestedModelRaw,
      context,
      isEdit = false,
      styleHint,
      projectId: requestProjectId,
      stack: requestStack,
      designDirection: requestDirection,
      idempotencyKey: requestIdempotencyKey,
    } = await request.json();
    // Explicit only: defaulting this to appConfig.ai.defaultModel pushed that
    // model to the front of the chain and demoted the configured primary
    // (AI_PRIMARY_* / Admin -> Configuration). The concrete `model` used for
    // logging and legacy provider objects is derived from the chain below.
    const requestedModel =
      typeof requestedModelRaw === 'string' && requestedModelRaw.trim()
        ? requestedModelRaw.trim()
        : undefined;

    const sessionUser = await getSessionUser();
    if (!sessionUser) {
      return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
    }
    const creditCheck = await checkCredits(WORKSPACE_ROW_ID, sessionUser.id, 'generation');
    if (!creditCheck.ok) return creditDeniedJson(creditCheck);

    const lockProjectId =
      (typeof requestProjectId === 'string' && requestProjectId) ||
      (typeof context?.projectId === 'string' && context.projectId) ||
      '';
    // `holdProjectLock` rather than the hand-rolled acquire + heartbeat + release triple.
    // `acquireLock` is re-entrant for the same user, so when this user already held a live
    // lock on the project — their own audit or publish, or a hold leaked by an earlier run —
    // the old code took `ok: true`, started a second timer renewing a hold it did not own,
    // and then released the *other* feature's lock in its cleanup (security review NAV-03).
    // The hold knows whether it owns anything, so `release()` is a no-op on re-entry.
    if (lockProjectId) {
      const hold = await holdProjectLock(lockProjectId, sessionUser.id, 'generation');
      if (!hold.ok) return lockConflictJson(hold);
      releaseGenerationLock = hold.release;
    }

    const idempotencyKey =
      typeof requestIdempotencyKey === 'string' && requestIdempotencyKey.trim()
        ? requestIdempotencyKey.trim()
        : null;
    generationJob = lockProjectId
      ? await createOrReuseJob({
          projectId: lockProjectId,
          workspaceId: WORKSPACE_ROW_ID,
          userId: sessionUser.id,
          kind: isEdit ? 'FOLLOWUP' : 'BUILD',
          inputPrompt: typeof prompt === 'string' ? prompt : null,
          idempotencyKey,
          requestId: getRequestId(),
        })
      : null;
    if (
      generationJob &&
      (generationJob.status === 'RUNNING' || generationJob.status === 'SUCCEEDED')
    ) {
      await releaseGenerationLock?.();
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
          : 'No AI provider is configured — set GEMINI_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, or GROQ_API_KEY on the server.';
      if (generationJob) {
        await failJob(generationJob.id, {
          errorCode: 'provider_not_configured',
          errorMessage: message,
        });
      }
      await releaseGenerationLock?.();
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
        await failJob(generationJob.id, {
          errorCode: 'queue_timeout',
          errorMessage: started.errorMessage || QUEUE_TIMEOUT_MESSAGE,
        });
        await releaseGenerationLock?.();
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
    // A live heartbeat hides the row from the staleness reaper. Tie it to the request so a
    // client that disconnects stops vouching for work nobody is reading: the row goes stale
    // within a minute instead of sitting RUNNING until the 20-minute hard timeout.
    jobHeartbeat = generationJob
      ? beginJobHeartbeat(generationJob.id, { signal: request.signal })
      : null;
    jobProgress = generationJob ? createProgressBatcher(generationJob.id) : null;
    const planCaps = await getPlanCaps(WORKSPACE_ROW_ID);
    const capTracker = new JobCapTracker(planCaps);
    let servedProvider = primaryProvider?.provider ?? null;
    let servedModel = primaryProvider?.model ?? null;

    const generationProfile = await resolveRequestGenerationProfile({
      stack: requestStack,
      designDirection: requestDirection,
      projectId: requestProjectId || context?.projectId,
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

    if (isEdit) {
      const projectId =
        (typeof requestProjectId === 'string' && requestProjectId) ||
        (typeof context?.projectId === 'string' && context.projectId) ||
        '';
      if (sessionUser && projectId) {
        await logGenerationEvent({
          projectId,
          userId: sessionUser.id,
          kind: 'followup',
          isUrlClone: looksLikeUrl(String(prompt || '')),
        });
      }
    }

    // Resolve this run's conversation state.
    //
    // Without project scoping the shared state carried the previous project's
    // "RECENTLY CREATED/EDITED FILES (DO NOT RECREATE)" list — Next.js app/
    // files — into a fresh REACT project's first build, and the model updated
    // that phantom tree instead of following the stack prompt. Everything below
    // reads `conversation`, never the global, so an overlapping request for
    // another project cannot swap this run's history out mid-stream.
    const conversationProjectId =
      (typeof requestProjectId === 'string' && requestProjectId) ||
      (typeof context?.projectId === 'string' && context.projectId) ||
      null;
    const conversation = conversationStateFor(conversationProjectId, sessionUser.id);
    log.info('generation.conversation_state', {
      requestId: getRequestId(),
      projectId: conversationProjectId,
      conversationId: conversation.conversationId,
      messages: conversation.context.messages.length,
    });
    // The publish to `global.conversationState` happens after the trims below, and what
    // it publishes is a shallow view rather than this run's own state object. See the
    // comment there.

    // Add user message to conversation history
    const userMessage: ConversationMessage = {
      id: `msg-${Date.now()}`,
      role: 'user',
      content: prompt,
      timestamp: Date.now(),
      metadata: {
        sandboxId: context?.sandboxId,
      },
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

    // `global.conversationState` still has three server-side readers — checkpoint labels
    // (`lib/checkpoints/actions.ts`), memory extraction (`lib/memory/extract.ts`) and the
    // follow-up prompt context (`lib/projects/plan.ts`) — so not publishing at all made a
    // checkpoint saved right after a build lose the prompt it was named for. What is
    // published is a shallow view, never this run's registry entry: /api/conversation-state
    // `clear-old` (the workspace POSTs it on every mount) does
    // `context.messages = context.messages.slice(-5)`, and applied to the live object that
    // truncated project A's history mid-run because someone else opened a tab. Every
    // container the endpoint reassigns a property on is copied here; the arrays themselves
    // are shared, so an edit this run pushes later is still visible to those readers.
    global.conversationState = {
      ...conversation,
      context: {
        ...conversation.context,
        projectEvolution: { ...conversation.context.projectEvolution },
      },
    };

    // Debug: Show a sample of actual file content
    if (context?.currentFiles && Object.keys(context.currentFiles).length > 0) {
      const firstFile = Object.entries(context.currentFiles)[0];
      console.log('[generate-ai-code-stream] - sample file:', firstFile[0]);
      console.log(
        '[generate-ai-code-stream] - sample content preview:',
        typeof firstFile[1] === 'string' ? firstFile[1].substring(0, 100) + '...' : 'not a string',
      );
    }

    if (!prompt) {
      return NextResponse.json(
        {
          success: false,
          error: 'Prompt is required',
        },
        { status: 400 },
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
      try {
        // Send initial status
        await sendProgress({ type: 'status', message: 'Initializing AI...' });

        // No keep-alive needed - sandbox provisioned for 10 minutes

        // Check if we have a file manifest for edit mode
        let editContext = null;
        let enhancedSystemPrompt = '';

        if (isEdit) {
          console.log(
            '[generate-ai-code-stream] Edit mode detected - starting agentic search workflow',
          );
          console.log('[generate-ai-code-stream] Has fileCache:', !!global.sandboxState?.fileCache);
          console.log(
            '[generate-ai-code-stream] Has manifest:',
            !!global.sandboxState?.fileCache?.manifest,
          );

          const manifest: FileManifest | undefined = global.sandboxState?.fileCache?.manifest;

          if (manifest) {
            await sendProgress({ type: 'status', message: '🔍 Creating search plan...' });

            const fileContents = global.sandboxState.fileCache?.files || {};
            console.log(
              '[generate-ai-code-stream] Files available for search:',
              Object.keys(fileContents).length,
            );

            // STEP 1: Get search plan from AI
            try {
              const intent = await analyzeEditIntent({ prompt, manifest, model });

              if (intent.ok) {
                const searchPlan = intent.searchPlan;
                console.log('[generate-ai-code-stream] Search plan received:', searchPlan);

                await sendProgress({
                  type: 'status',
                  message: `🔎 Searching for: "${searchPlan.searchTerms.join('", "')}"`,
                });

                // STEP 2: Execute the search plan
                const searchExecution = executeSearchPlan(
                  searchPlan,
                  Object.fromEntries(
                    Object.entries(fileContents).map(([path, data]) => [
                      path.startsWith('/') ? path : `/home/user/app/${path}`,
                      data.content,
                    ]),
                  ),
                );

                console.log('[generate-ai-code-stream] Search execution:', {
                  success: searchExecution.success,
                  resultsCount: searchExecution.results.length,
                  filesSearched: searchExecution.filesSearched,
                  time: searchExecution.executionTime + 'ms',
                });

                if (searchExecution.success && searchExecution.results.length > 0) {
                  // STEP 3: Select the best target file
                  const target = selectTargetFile(searchExecution.results, searchPlan.editType);

                  if (target) {
                    await sendProgress({
                      type: 'status',
                      message: `✅ Found code in ${target.filePath.split('/').pop()} at line ${target.lineNumber}`,
                    });

                    console.log('[generate-ai-code-stream] Target selected:', target);

                    // Create surgical edit context with exact location
                    // normalizedPath would be: target.filePath.replace('/home/user/app/', '');
                    // fileContent available but not used in current implementation
                    // const fileContent = fileContents[normalizedPath]?.content || '';

                    // Build enhanced context with search results
                    enhancedSystemPrompt = `
${formatSearchResultsForAI(searchExecution.results)}

SURGICAL EDIT INSTRUCTIONS:
You have been given the EXACT location of the code to edit.
- File: ${target.filePath}
- Line: ${target.lineNumber}
- Reason: ${target.reason}

Make ONLY the change requested by the user. Do not modify any other code.
User request: "${prompt}"`;

                    // Set up edit context with just this one file
                    editContext = {
                      primaryFiles: [target.filePath],
                      contextFiles: [],
                      systemPrompt: enhancedSystemPrompt,
                      editIntent: {
                        type: searchPlan.editType,
                        description: searchPlan.reasoning,
                        targetFiles: [target.filePath],
                        confidence: 0.95, // High confidence since we found exact location
                        searchTerms: searchPlan.searchTerms,
                      },
                    };

                    console.log('[generate-ai-code-stream] Surgical edit context created');
                  }
                } else {
                  // Search failed - fall back to old behavior but inform user
                  console.warn(
                    '[generate-ai-code-stream] Search found no results, falling back to broader context',
                  );
                  await sendProgress({
                    type: 'status',
                    message: '⚠️ Could not find exact match, using broader search...',
                  });
                }
              } else {
                // Log and continue. The plan only narrows the edit to a file
                // and a line; without it the model still edits, it just sees a
                // broader slice of the project. Aborting the user's generation
                // over a planning miss would be the bigger failure.
                console.error('[generate-ai-code-stream] Failed to get search plan:', intent.error);
                await sendProgress({
                  type: 'warning',
                  message: 'Could not plan a targeted edit; using broader context for this change.',
                });
                await recordJobStepFailure(generationJob?.id, {
                  key: 'analyze-edit-intent',
                  label: 'Plan the edit',
                  error: intent.error,
                });
              }
            } catch (error) {
              console.error('[generate-ai-code-stream] Error in agentic search workflow:', error);
              await recordJobStepFailure(generationJob?.id, {
                key: 'analyze-edit-intent',
                label: 'Plan the edit',
                error: error instanceof Error ? error.message : String(error),
              });
              await sendProgress({
                type: 'status',
                message: '⚠️ Search workflow error, falling back to keyword method...',
              });
              // Fall back to old method on any error if we have a manifest
              if (manifest) {
                editContext = selectFilesForEdit(prompt, manifest);
              }
            }
          } else {
            // Fall back to old method if AI analysis fails
            console.warn(
              '[generate-ai-code-stream] AI intent analysis failed, falling back to keyword method',
            );
            if (manifest) {
              editContext = selectFilesForEdit(prompt, manifest);
            } else {
              console.log('[generate-ai-code-stream] No manifest available for fallback');
              await sendProgress({
                type: 'status',
                message: '⚠️ No file manifest available, will use broad context',
              });
            }
          }

          // If we got an edit context from any method, use its system prompt
          if (editContext) {
            enhancedSystemPrompt = editContext.systemPrompt;

            await sendProgress({
              type: 'status',
              message: `Identified edit type: ${editContext.editIntent?.description || 'Code modification'}`,
            });
          }
        }

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
        const injectedSkills = await injectMatchedSkills(prompt, conversationContext || '');
        if (injectedSkills.names.length > 0) {
          await sendProgress({ type: 'skills', names: injectedSkills.names });
        }
        const promptEditContext = editContext
          ? {
              editIntent: {
                type: String(editContext.editIntent?.type ?? ''),
                confidence: Number(editContext.editIntent?.confidence ?? 0),
              },
              primaryFiles: editContext.primaryFiles ?? [],
            }
          : null;
        const assetProjectId =
          (typeof requestProjectId === 'string' && requestProjectId) ||
          (typeof context?.projectId === 'string' && context.projectId) ||
          '';
        const assetManifest = await loadAssetManifest(assetProjectId || null);
        // The model call sends `stablePrefix` as the system message and this as the
        // volatile user turn (see buildCachedMessages), so the composed getStackPrompt
        // string had no reader here once the Morph branch that appended to it was gone.
        const volatileSuffix = buildVolatilePromptSuffix({
          conversationContext,
          uiUxBrief,
          isEdit,
          editContext: promptEditContext,
          assetManifest,
        });

        // No Morph fast-apply branch here. It told the model to answer in `<edit>` blocks
        // instead of fenced files, and nothing has applied those since the apply route was
        // deleted: `parseMorphEdits` / `applyMorphEditToFile` have no production caller. So
        // with a Morph key saved in Admin -> Configuration, every follow-up edit reported
        // SUCCEEDED with an explanation in chat and left the project's files untouched.
        // Until an applier exists, the one output contract is the fenced `{path=…}` block
        // that `filesFromReply` parses.

        // Build full prompt with context.
        //
        // Entered when there is a project even if the client sent no `context` at all.
        // Gating the whole block on `context` was a second way a request could talk its
        // way out of the file load below: omit the object and the project's stored code
        // was never read, so the model was asked to satisfy the prompt with no sight of
        // the site it was about to overwrite. Request-supplied fields stay optional; the
        // project id is what decides whether this runs.
        let fullPrompt = prompt;
        if (context || conversationProjectId) {
          const contextParts = [];

          if (context?.sandboxId) {
            contextParts.push(`Current sandbox ID: ${context.sandboxId}`);
          }

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
          let backendFiles: Record<string, string> = {};
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
          let hasBackendFiles = Object.keys(backendFiles).length > 0;

          console.log('[generate-ai-code-stream] - File count:', Object.keys(backendFiles).length);

          // Show the model the files it is being asked to change.
          if (hasBackendFiles) {
            contextParts.push('\nEXISTING APPLICATION - TARGETED EDIT REQUIRED');
            contextParts.push(
              '\nYou MUST analyze the user request and determine which specific file(s) to edit.',
            );
            if (editContext?.systemPrompt) {
              contextParts.push(`\n${editContext.systemPrompt}\n`);
            }
            // Selection reads `backendFiles` directly. It used to have a
            // second path that pulled contents out of a FileManifest, but a
            // manifest only ever came from a sandbox sync — the assertions on
            // it (`global.sandboxState!.fileCache!.manifest!`) would throw the
            // moment real files arrived here.
            const recentPaths = conversation.context.edits
              .flatMap((edit) => edit.targetFiles || [])
              .slice(-12);
            const selected = selectFileContext({
              files: backendFiles,
              userMessage: prompt,
              recentlyModifiedPaths: recentPaths,
              primaryPaths: editContext?.primaryFiles,
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
              primaryPaths: editContext?.primaryFiles,
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
              context.conversationContext.scrapedWebsites.forEach((site: any) => {
                contextParts.push(`\nURL: ${site.url}`);
                contextParts.push(`Scraped: ${new Date(site.timestamp).toLocaleString()}`);
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
            fullPrompt = `CONTEXT:\n${contextParts.join('\n')}\n\nUSER REQUEST:\n${prompt}`;
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

        // Track packages that need to be installed
        const packagesToInstall: string[] = [];

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

        // DeepSeek's thinking-mode model rejects a temperature.
        if (!actualModel.includes('-pro')) {
          streamOptions.temperature = 0.7;
        }
        let result: Awaited<ReturnType<typeof streamText>> | undefined;
        let generatedCode = '';
        let files: { path: string; content: string }[] = [];
        let componentCount = 0;
        let providersTried: string[] = [];
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
              const capture = bindStreamErrorCapture();
              return capture.attach(
                streamText({
                  ...nextOptions,
                  onError: capture.onError,
                }),
              );
            },
            async (stream, entry) => {
              result = stream;
              servedProvider = entry.provider;
              servedModel = entry.model;
              generatedCode = '';
              files = [];
              const streamedFiles = new StreamedFileTracker();
              let isInTag = false;
              let conversationalBuffer = '';
              let tagBuffer = '';
              packagesToInstall.length = 0;

              // Stream the response and parse in real-time
              for await (const textPart of stream.textStream || []) {
                // Deliberately no `break` on a disconnected client. Breaking
                // here threw away a build the moment someone reloaded the tab:
                // the loop stopped mid-site, the settle below never got a
                // complete reply, and the work — already paid for in tokens —
                // was lost. The site is persisted server-side, so finishing
                // the stream is what lets them come back to it. Writes to the
                // browser are already skipped while it is gone.
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

                // Combine with buffer for tag detection
                const searchText = tagBuffer + text;

                // Log streaming chunks to console
                process.stdout.write(text);

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

                // Stream the raw text for live preview
                await sendProgress({
                  type: 'stream',
                  text: text,
                  raw: true,
                });

                // Debug: Log every 100 characters streamed
                if (generatedCode.length % 100 < text.length) {
                  console.log(`[generate-ai-code-stream] Streamed ${generatedCode.length} chars`);
                }

                // Check for package tags in buffered text (ONLY for edits, not initial generation)
                let lastIndex = 0;
                if (isEdit) {
                  const packageRegex = /<package>([^<]+)<\/package>/g;
                  let packageMatch;

                  while ((packageMatch = packageRegex.exec(searchText)) !== null) {
                    const packageName = packageMatch[1].trim();
                    if (packageName && !packagesToInstall.includes(packageName)) {
                      packagesToInstall.push(packageName);
                      console.log(`[generate-ai-code-stream] Package detected: ${packageName}`);
                      await sendProgress({
                        type: 'package',
                        name: packageName,
                        message: `Package detected: ${packageName}`,
                      });
                    }
                    lastIndex = packageMatch.index + packageMatch[0].length;
                  }
                }

                // Keep unmatched portion in buffer for next iteration
                tagBuffer = searchText.substring(Math.max(0, lastIndex - 50)); // Keep last 50 chars

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

              // A dropped path is not silent. The log line is for us; the warning frame is
              // for the user, who would otherwise see one fewer file than the model claimed
              // to write with nothing anywhere saying why. The post-stream parse below drops
              // the same entries (`sanitizeGenerationPath(...)` then `continue`), so this is
              // the one place the drop is announced.
              if (streamedFiles.rejectedPaths.length > 0) {
                const rejectedPaths = [...streamedFiles.rejectedPaths];
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

              // Also parse <packages> tag for multiple packages - ONLY for edits
              if (isEdit) {
                const packagesRegex = /<packages>([\s\S]*?)<\/packages>/g;
                let packagesMatch;
                while ((packagesMatch = packagesRegex.exec(generatedCode)) !== null) {
                  const packagesContent = packagesMatch[1].trim();
                  const packagesList = packagesContent
                    .split(/[\n,]+/)
                    .map((pkg) => pkg.trim())
                    .filter((pkg) => pkg.length > 0);

                  for (const packageName of packagesList) {
                    if (!packagesToInstall.includes(packageName)) {
                      packagesToInstall.push(packageName);
                      console.log(
                        `[generate-ai-code-stream] Package from <packages> tag: ${packageName}`,
                      );
                      await sendProgress({
                        type: 'package',
                        name: packageName,
                        message: `Package detected: ${packageName}`,
                      });
                    }
                  }
                }
              }

              // Function to extract packages from import statements
              function extractPackagesFromCode(content: string): string[] {
                const packages: string[] = [];
                // Match ES6 imports
                const importRegex =
                  /import\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+\w+|\w+))*\s+from\s+)?['"]([^'"]+)['"]/g;
                let importMatch;

                while ((importMatch = importRegex.exec(content)) !== null) {
                  const importPath = importMatch[1];
                  if (!shouldSkipPackageInstall(projectStack, importPath)) {
                    const packageName = packageNameFromImport(importPath);

                    if (!packages.includes(packageName)) {
                      packages.push(packageName);
                    }
                  }
                }

                return packages;
              }

              // Parse files and send progress for each. The block parser carries
              // llamacoder's tolerances for how models actually break the fence
              // format — a glued opener, the path tag on the next line, a split
              // closing brace, a stream cut before the final fence.
              for (const [filePath, content] of Object.entries(filesFromReply(generatedCode))) {
                const safe = sanitizeGenerationPath(filePath);
                if (!safe.ok) continue;
                files.push({ path: safe.path, content });
                jobProgress?.addFile(safe.path, content);

                // Extract packages from file content - ONLY for edits
                if (isEdit) {
                  const filePackages = extractPackagesFromCode(content);
                  for (const pkg of filePackages) {
                    if (!packagesToInstall.includes(pkg)) {
                      packagesToInstall.push(pkg);
                      console.log(
                        `[generate-ai-code-stream] Package detected from imports: ${pkg}`,
                      );
                      await sendProgress({
                        type: 'package',
                        name: pkg,
                        message: `Package detected from imports: ${pkg}`,
                      });
                    }
                  }
                }

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
            // A parsed file is the only evidence a run changed anything: nothing applies
            // Morph `<edit>` blocks, so counting them here retried the wrong attempts and
            // let an edit that changed nothing pass as complete.
            (out) => out.stop || out.files.length > 0,
            { circuit: getDefaultCircuit() },
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
Original request: ${prompt}

Provide the complete file content without any truncation. Include all necessary imports, complete all functions, and close all tags properly.`;

                const recoveryClient = clientForEntry(recoveryEntry, providerEnv);
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
                    temperature: recoveryEntry.model.startsWith('gpt-5')
                      ? undefined
                      : appConfig.ai.defaultTemperature,
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
                // string a rejected call resolves to.
                const completedContent = await collectRecoveredStreamText(completionResult);

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

                console.log(`[generate-ai-code-stream] Successfully completed ${filePath}`);
              } catch (completionError) {
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

        const usageProjectId =
          (typeof requestProjectId === 'string' && requestProjectId) ||
          (typeof context?.projectId === 'string' && context.projectId) ||
          '';
        let inputTokens = 0;
        let outputTokens: number | undefined;
        try {
          const usage = await result?.usage;
          inputTokens = resolveInputTokens(
            usage,
            `${stablePrefix}\n${injectedSkills.block}\n${volatileSuffix}\n${fullPrompt}`,
          );
          outputTokens =
            usage && typeof usage === 'object' && 'outputTokens' in usage
              ? Number((usage as { outputTokens?: number }).outputTokens)
              : undefined;
          if (usageProjectId) {
            await attachGenerationInputTokens(usageProjectId, inputTokens);
          }
        } catch (tokenError) {
          logError('generation.tokens_failed', tokenError);
        }

        // A run that produced no file block changed nothing. That used to end as a 200 with
        // `files: 0` and a SUCCEEDED job, which told the user their request had been carried
        // out when it had not. Morph `<edit>` blocks used to count as evidence of a change
        // here; nothing has applied them since the apply route was deleted, so counting them
        // only let an edit that changed nothing report success. The prompt no longer asks
        // for them either, so a parsed file is the only evidence there is.
        const hadNoChanges = files.length === 0;
        const noChangeReason = hadNoChanges
          ? describeNoChanges({
              isEdit,
              hasProjectFiles: Object.keys(global.sandboxState?.fileCache?.files || {}).length > 0,
              hasManifest: Boolean(global.sandboxState?.fileCache?.manifest),
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

        let streamSettle: Awaited<ReturnType<typeof settleStreamedGeneration>> | null = null;
        if (generationJob) {
          await jobProgress?.flush();
          // The tokens were spent either way, so they are recorded either way.
          const estimatedCostUsd = await recordJobUsage({
            jobId: generationJob.id,
            workspaceId: WORKSPACE_ROW_ID,
            tokensIn: inputTokens,
            tokensOut: outputTokens,
            provider: servedProvider,
            model: servedModel,
          });
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

        trackSuccess('generation.success', {
          action: 'generation',
          stack: projectStack,
          model,
          inputTokens,
          outputTokens,
          durationMs: Date.now() - startedAt,
        });

        // Send completion with packages info
        await sendProgress({
          type: 'complete',
          generatedCode,
          explanation,
          files: files.length,
          components: componentCount,
          model,
          packagesToInstall: packagesToInstall.length > 0 ? packagesToInstall : undefined,
          warnings: truncationWarnings.length > 0 ? truncationWarnings : undefined,
          skillNames: injectedSkills.names,
        });

        // Track edit in conversation history. Writes land on the state this
        // request resolved, never on whatever the process global points at by
        // now — another project's request may have taken it over mid-stream.
        if (isEdit && editContext) {
          const editRecord: ConversationEdit = {
            timestamp: Date.now(),
            userRequest: prompt,
            editType: editContext.editIntent.type,
            targetFiles: editContext.primaryFiles,
            confidence: editContext.editIntent.confidence,
            outcome: 'success', // Assuming success if we got here
          };

          conversation.context.edits.push(editRecord);

          // Track major changes
          if (editContext.editIntent.type === 'ADD_FEATURE' || files.length > 3) {
            conversation.context.projectEvolution.majorChanges.push({
              timestamp: Date.now(),
              description: editContext.editIntent.description,
              filesAffected: editContext.primaryFiles,
            });
          }

          // Update last updated timestamp
          conversation.lastUpdated = Date.now();

          console.log(
            '[generate-ai-code-stream] Updated conversation history with edit:',
            editRecord,
          );
        }
      } catch (error) {
        console.error('[generate-ai-code-stream] Stream processing error:', error);

        const errorMessage = error instanceof Error ? error.message : String(error);
        // Reaching this catch means the work stopped, whatever the reason. The tool-validation
        // branch used to only warn and then fall out of the block, leaving the job RUNNING
        // with nothing left to settle it.
        const isToolValidationError = errorMessage.includes('tool call validation failed');
        const cap = error instanceof JobCapError ? error : null;
        const cause =
          error instanceof ProviderRunError
            ? (error.causeError ?? error)
            : error && typeof error === 'object' && 'cause' in error
              ? (error as { cause: unknown }).cause
              : error;
        const honest =
          cap?.message ??
          (isToolValidationError ? errorMessage : providerFailureMessage(cause, servedProvider));
        if (isToolValidationError) {
          console.error(
            '[generate-ai-code-stream] Tool call validation error - this may be due to the AI model sending incorrect parameters',
          );
          await sendProgress({
            type: 'warning',
            message:
              'Package installation tool encountered an issue. Packages will be detected from imports instead.',
          });
        } else {
          await sendProgress({
            type: 'error',
            error: honest,
          });
        }
        if (generationJob) {
          try {
            await failJob(generationJob.id, {
              errorCode:
                cap?.errorCode ??
                (isToolValidationError
                  ? 'tool_call_validation_failed'
                  : jobErrorCodeForProviderFailure(cause)),
              errorMessage: honest,
              tokensOut: cap?.tokensOut,
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

    // Return the stream with proper headers for streaming support
    return new Response(stream.readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Transfer-Encoding': 'chunked',
        'Content-Encoding': 'none', // Prevent compression that can break streaming
        'X-Accel-Buffering': 'no', // Disable nginx buffering
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
    });
  } catch (error) {
    jobHeartbeat?.stop();
    providerSlot?.release();
    if (generationJob) {
      const cap = error instanceof JobCapError ? error : null;
      try {
        await failJob(generationJob.id, {
          errorCode: cap?.errorCode ?? jobErrorCodeForProviderFailure(error),
          errorMessage: cap?.message ?? providerFailureMessage(error),
          tokensOut: cap?.tokensOut,
        });
      } catch (settleError) {
        await reportSettleFailure({
          jobId: generationJob.id,
          intended: 'failed',
          error: settleError,
        });
      }
    }
    await releaseGenerationLock?.();
    trackFailure('generation.failure', error, {
      action: 'generation',
      durationMs: Date.now() - startedAt,
    });
    return jsonError((error as Error).message || 'Generation failed', 'GENERATION_FAILED', 500);
  }
}
