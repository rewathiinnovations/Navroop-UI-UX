import { NextRequest, NextResponse } from 'next/server';
import { createGroq } from '@ai-sdk/groq';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { streamText } from 'ai';
import type { SandboxState } from '@/types/sandbox';
import { selectFilesForEdit, getFileContents, formatFilesForAI } from '@/lib/context-selector';
import { executeSearchPlan, formatSearchResultsForAI, selectTargetFile } from '@/lib/file-search-executor';
import { FileManifest } from '@/types/file-manifest';
import type { ConversationState, ConversationMessage, ConversationEdit } from '@/types/conversation';
import { appConfig } from '@/config/app.config';
import { buildUiUxProMaxBrief } from '@/lib/ui-ux-pro-max/build-design-brief';
import { getSessionUser } from '@/lib/auth';
import { ensureSandbox, SandboxBootError } from '@/lib/sandbox/manager';
import { looksLikeUrl } from '@/lib/projects/prompt';
import { attachGenerationInputTokens, logGenerationEvent } from '@/lib/usage-costs';
import { buildCachedMessages } from '@/lib/generation/prompt-cache';
import { selectFileContext } from '@/lib/generation/selective-context';
import { resolveInputTokens } from '@/lib/generation/token-estimate';
import { buildStablePromptPrefix, buildVolatilePromptSuffix, getStackPrompt } from '@/lib/stack-prompts';
import { resolveRequestGenerationProfile } from '@/lib/stack-resolve';
import { packageNameFromImport, shouldSkipPackageInstall } from '@/lib/stacks';
import { loadAssetManifest } from '@/lib/assets/load-manifest';
import { injectMatchedSkills } from '@/lib/skills/inject';
import { buildMemoryBlock } from '@/lib/memory/build-context';
import { creditDeniedJson } from '@/lib/plans/http';
import { checkCredits } from '@/lib/plans/limits';
import { WORKSPACE_ROW_ID } from '@/lib/storage/usage';
import { jsonError } from '@/lib/api/error-response';
import { withRequest } from '@/lib/api/with-request';
import { analyzeEditIntent } from '@/lib/generation/analyze-edit-intent';
import {
  NO_PROJECT_FILES_NOTICE,
  SANDBOX_READ_FAILED_NOTICE,
  shouldRetrySandboxFileRead,
} from '@/lib/generation/sandbox-read-notices';
import { readSandboxFiles } from '@/lib/sandbox/read-files';
import { log, logError } from '@/lib/logger';
import { trackFailure, trackStart, trackSuccess } from '@/lib/observability/track';
import { acquireLock, beginLockHeartbeat, releaseLock } from '@/lib/projects/lock';
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
  failoverNotice,
  getProviderApiKey,
  providerDisplayName,
  ProviderNotConfiguredError,
  requireUsableProviderChain,
  type ProviderEntry,
  type ProviderName,
} from '@/lib/ai/providers';
import { loadEffectiveProviderEnv } from '@/lib/ai/effective-env';
import { bindStreamErrorCapture, EmptyCompletionError, producedNoChanges } from '@/lib/ai/empty-completion';
import { sanitizeGenerationPath } from '@/lib/generation/parse-files';
import {
  collectRecoveredStreamText,
  truncationRecoveryOutcome,
  type TruncationRecoveryOutcome,
} from '@/lib/generation/truncation-recovery';
import { executeWithCompletionFailover, ProviderRunError, type ProviderAttempt } from '@/lib/ai/run';
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

const groq = createGroq({
  apiKey: process.env.AI_GATEWAY_API_KEY ?? process.env.GROQ_API_KEY,
  baseURL: isUsingAIGateway ? aiGatewayBaseURL : undefined,
});

const anthropic = createAnthropic({
  apiKey: process.env.AI_GATEWAY_API_KEY ?? process.env.ANTHROPIC_API_KEY,
  baseURL: isUsingAIGateway ? aiGatewayBaseURL : (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1'),
});

const googleGenerativeAI = createGoogleGenerativeAI({
  apiKey: process.env.AI_GATEWAY_API_KEY ?? process.env.GEMINI_API_KEY,
  baseURL: isUsingAIGateway ? aiGatewayBaseURL : undefined,
});

const openai = createOpenAI({
  apiKey: process.env.AI_GATEWAY_API_KEY ?? process.env.OPENAI_API_KEY,
  baseURL: isUsingAIGateway ? aiGatewayBaseURL : process.env.OPENAI_BASE_URL,
});

// Helper function to analyze user preferences from conversation history
function analyzeUserPreferences(messages: ConversationMessage[]): {
  commonPatterns: string[];
  preferredEditStyle: 'targeted' | 'comprehensive';
} {
  const userMessages = messages.filter(m => m.role === 'user');
  const patterns: string[] = [];
  
  // Count edit-related keywords
  let targetedEditCount = 0;
  let comprehensiveEditCount = 0;
  
  userMessages.forEach(msg => {
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
    preferredEditStyle: targetedEditCount > comprehensiveEditCount ? 'targeted' : 'comprehensive'
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
    console.error('[generate-ai-code-stream] Failed to report a lost settle:', summary, reportError);
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

function clientForEntry(
  entry: ProviderEntry,
  env: Record<string, string | undefined>,
) {
  const gateway = env.AI_GATEWAY_API_KEY?.trim();
  const apiKey = gateway || getProviderApiKey(entry, env);
  const gatewayUrl = gateway ? aiGatewayBaseURL : undefined;
  if (entry.provider === 'openai') {
    return createOpenAI({ apiKey, baseURL: gatewayUrl ?? env.OPENAI_BASE_URL });
  }
  if (entry.provider === 'anthropic') {
    return createAnthropic({
      apiKey,
      baseURL: gatewayUrl ?? (env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1'),
    });
  }
  if (entry.provider === 'google') {
    return createGoogleGenerativeAI({ apiKey, baseURL: gatewayUrl });
  }
  return createGroq({ apiKey, baseURL: gatewayUrl });
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
    const { prompt, model = appConfig.ai.defaultModel, context, isEdit = false, styleHint, projectId: requestProjectId, stack: requestStack, designDirection: requestDirection, idempotencyKey: requestIdempotencyKey } = await request.json();

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
    let lockHeld = false;
    let lockHeartbeat: { stop: () => void } | null = null;
    releaseGenerationLock = async () => {
      lockHeartbeat?.stop();
      lockHeartbeat = null;
      if (lockHeld && lockProjectId) {
        lockHeld = false;
        await releaseLock(lockProjectId, sessionUser.id);
      }
    };
    if (lockProjectId) {
      const lock = await acquireLock(lockProjectId, sessionUser.id, 'generation');
      if (!lock.ok) return lockConflictJson(lock);
      lockHeld = true;
      lockHeartbeat = beginLockHeartbeat(lockProjectId, sessionUser.id);
    }

    const idempotencyKey = typeof requestIdempotencyKey === 'string' && requestIdempotencyKey.trim()
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
    if (generationJob && (generationJob.status === 'RUNNING' || generationJob.status === 'SUCCEEDED')) {
      await releaseGenerationLock?.();
      return NextResponse.json({ job: toPublicJob(generationJob), reused: true });
    }
    let providerChain;
    let providerEnv: Record<string, string | undefined> = process.env;
    try {
      providerEnv = await loadEffectiveProviderEnv(sessionUser.id, process.env);
      providerChain = requireUsableProviderChain(providerEnv, { requestedModel: model });
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
      if (projectId) {
        try {
          await ensureSandbox(projectId, { allowEmpty: true });
        } catch (error) {
          if (error instanceof SandboxBootError && error.code === 'NO_CHECKPOINT') {
            // First edit of a project with no snapshot can still generate into an empty workspace.
          } else {
            const message =
              error instanceof Error
                ? `The workspace for this project could not be started. ${error.message}`
                : 'The workspace for this project could not be started';
            if (generationJob) {
              await failJob(generationJob.id, {
                errorCode: 'sandbox_unavailable',
                errorMessage: message,
              });
            }
            jobHeartbeat?.stop();
            providerSlot?.release();
            await releaseGenerationLock?.();
            return jsonError(message, 'SANDBOX_UNAVAILABLE', 503);
          }
        }
      }
    }
    
    // Initialize conversation state if not exists
    if (!global.conversationState) {
      global.conversationState = {
        conversationId: `conv-${Date.now()}`,
        startedAt: Date.now(),
        lastUpdated: Date.now(),
        context: {
          messages: [],
          edits: [],
          projectEvolution: { majorChanges: [] },
          userPreferences: {}
        }
      };
    }
    
    // Add user message to conversation history
    const userMessage: ConversationMessage = {
      id: `msg-${Date.now()}`,
      role: 'user',
      content: prompt,
      timestamp: Date.now(),
      metadata: {
        sandboxId: context?.sandboxId
      }
    };
    global.conversationState.context.messages.push(userMessage);
    
    // Clean up old messages to prevent unbounded growth
    if (global.conversationState.context.messages.length > 20) {
      // Keep only the last 15 messages
      global.conversationState.context.messages = global.conversationState.context.messages.slice(-15);
      console.log('[generate-ai-code-stream] Trimmed conversation history to prevent context overflow');
    }
    
    // Clean up old edits
    if (global.conversationState.context.edits.length > 10) {
      global.conversationState.context.edits = global.conversationState.context.edits.slice(-8);
    }
    
    // Debug: Show a sample of actual file content
    if (context?.currentFiles && Object.keys(context.currentFiles).length > 0) {
      const firstFile = Object.entries(context.currentFiles)[0];
      console.log('[generate-ai-code-stream] - sample file:', firstFile[0]);
      console.log('[generate-ai-code-stream] - sample content preview:', 
        typeof firstFile[1] === 'string' ? firstFile[1].substring(0, 100) + '...' : 'not a string');
    }
    
    if (!prompt) {
      return NextResponse.json({ 
        success: false, 
        error: 'Prompt is required' 
      }, { status: 400 });
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
        let sandboxReadWarned = false;
        
        if (isEdit) {
          console.log('[generate-ai-code-stream] Edit mode detected - starting agentic search workflow');
          console.log('[generate-ai-code-stream] Has fileCache:', !!global.sandboxState?.fileCache);
          console.log('[generate-ai-code-stream] Has manifest:', !!global.sandboxState?.fileCache?.manifest);
          
          const manifest: FileManifest | undefined = global.sandboxState?.fileCache?.manifest;
          
          if (manifest) {
            await sendProgress({ type: 'status', message: '🔍 Creating search plan...' });
            
            const fileContents = global.sandboxState.fileCache?.files || {};
            console.log('[generate-ai-code-stream] Files available for search:', Object.keys(fileContents).length);
            
            // STEP 1: Get search plan from AI
            try {
              const intent = await analyzeEditIntent({ prompt, manifest, model });

              if (intent.ok) {
                const searchPlan = intent.searchPlan;
                console.log('[generate-ai-code-stream] Search plan received:', searchPlan);
                
                await sendProgress({ 
                  type: 'status', 
                  message: `🔎 Searching for: "${searchPlan.searchTerms.join('", "')}"`
                });
                
                // STEP 2: Execute the search plan
                const searchExecution = executeSearchPlan(searchPlan, 
                  Object.fromEntries(
                    Object.entries(fileContents).map(([path, data]) => [
                      path.startsWith('/') ? path : `/home/user/app/${path}`,
                      data.content
                    ])
                  )
                );
                
                console.log('[generate-ai-code-stream] Search execution:', {
                  success: searchExecution.success,
                  resultsCount: searchExecution.results.length,
                  filesSearched: searchExecution.filesSearched,
                  time: searchExecution.executionTime + 'ms'
                });
                
                if (searchExecution.success && searchExecution.results.length > 0) {
                  // STEP 3: Select the best target file
                  const target = selectTargetFile(searchExecution.results, searchPlan.editType);
                  
                  if (target) {
                    await sendProgress({ 
                      type: 'status', 
                      message: `✅ Found code in ${target.filePath.split('/').pop()} at line ${target.lineNumber}`
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
                        searchTerms: searchPlan.searchTerms
                      }
                    };
                    
                    console.log('[generate-ai-code-stream] Surgical edit context created');
                  }
                } else {
                  // Search failed - fall back to old behavior but inform user
                  console.warn('[generate-ai-code-stream] Search found no results, falling back to broader context');
                  await sendProgress({ 
                    type: 'status', 
                    message: '⚠️ Could not find exact match, using broader search...'
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
                message: '⚠️ Search workflow error, falling back to keyword method...'
              });
              // Fall back to old method on any error if we have a manifest
              if (manifest) {
                editContext = selectFilesForEdit(prompt, manifest);
              }
            }
          } else {
            // Fall back to old method if AI analysis fails
            console.warn('[generate-ai-code-stream] AI intent analysis failed, falling back to keyword method');
            if (manifest) {
              editContext = selectFilesForEdit(prompt, manifest);
            } else {
              console.log('[generate-ai-code-stream] No manifest available for fallback');
              await sendProgress({ 
                type: 'status', 
                message: '⚠️ No file manifest available, will use broad context'
              });
            }
          }
          
          // If we got an edit context from any method, use its system prompt
          if (editContext) {
            enhancedSystemPrompt = editContext.systemPrompt;
            
            await sendProgress({ 
              type: 'status', 
              message: `Identified edit type: ${editContext.editIntent?.description || 'Code modification'}`
            });
          } else if (!manifest) {
            console.log('[generate-ai-code-stream] WARNING: No manifest available for edit mode!');
            
            // Try to fetch files from sandbox if we have one
            if (global.activeSandbox) {
              await sendProgress({ type: 'status', message: 'Fetching current files from sandbox...' });
              
              try {
                // Read files directly from sandbox
                const filesData = await readSandboxFiles();

                if (filesData.ok) {
                  const manifest = filesData.manifest;
                  console.log('[generate-ai-code-stream] Successfully fetched manifest from sandbox');

                  {
                    // Analyze edit intent with the manifest we just read
                    try {
                      const intent = await analyzeEditIntent({ prompt, manifest, model });

                      if (intent.ok) {
                        const searchPlan = intent.searchPlan;
                        console.log('[generate-ai-code-stream] Search plan received (after fetch):', searchPlan);
                        
                        // For now, fall back to keyword search since we don't have file contents for search execution
                        // This path happens when no manifest was initially available
                        let targetFiles: any[] = [];
                        if (!searchPlan || searchPlan.searchTerms.length === 0) {
                          console.warn('[generate-ai-code-stream] No target files after fetch, searching for relevant files');
                          
                          const promptLower = prompt.toLowerCase();
                          const allFilePaths = Object.keys(manifest.files);
                          
                          // Look for component names mentioned in the prompt
                          if (promptLower.includes('hero')) {
                            targetFiles = allFilePaths.filter(p => p.toLowerCase().includes('hero'));
                          } else if (promptLower.includes('header')) {
                            targetFiles = allFilePaths.filter(p => p.toLowerCase().includes('header'));
                          } else if (promptLower.includes('footer')) {
                            targetFiles = allFilePaths.filter(p => p.toLowerCase().includes('footer'));
                          } else if (promptLower.includes('nav')) {
                            targetFiles = allFilePaths.filter(p => p.toLowerCase().includes('nav'));
                          } else if (promptLower.includes('button')) {
                            targetFiles = allFilePaths.filter(p => p.toLowerCase().includes('button'));
                          }
                          
                          if (targetFiles.length > 0) {
                            console.log('[generate-ai-code-stream] Found target files by keyword search after fetch:', targetFiles);
                          }
                        }
                        
                        const allFiles = Object.keys(manifest.files)
                          .filter(path => !targetFiles.includes(path));
                        
                        editContext = {
                          primaryFiles: targetFiles,
                          contextFiles: allFiles,
                          systemPrompt: `
You are an expert senior software engineer performing a surgical, context-aware code modification. Your primary directive is **precision and preservation**.

Think of yourself as a surgeon making a precise incision, not a construction worker demolishing a wall.

## Search-Based Edit
Search Terms: ${searchPlan?.searchTerms?.join(', ') || 'keyword-based'}
Edit Type: ${searchPlan?.editType || 'UPDATE_COMPONENT'}
Reasoning: ${searchPlan?.reasoning || 'Modifying based on user request'}

Files to Edit: ${targetFiles.join(', ') || 'To be determined'}
User Request: "${prompt}"

## Your Mandatory Thought Process (Execute Internally):
Before writing ANY code, you MUST follow these steps:

1. **Understand Intent:**
   - What is the user's core goal? (adding feature, fixing bug, changing style?)
   - Does the conversation history provide extra clues?

2. **Locate the Code:**
   - First examine the Primary Files provided
   - Check the "ALL PROJECT FILES" list to find the EXACT file name
   - "nav" might be Navigation.tsx, NavBar.tsx, Nav.tsx, or Header.tsx
   - DO NOT create a new file if a similar one exists!

3. **Plan the Changes (Mental Diff):**
   - What is the *minimal* set of changes required?
   - Which exact lines need to be added, modified, or deleted?
   - Will this require new packages?

4. **Verify Preservation:**
   - What existing code, props, state, and logic must NOT be touched?
   - How can I make my change without disrupting surrounding code?

5. **Construct the Final Code:**
   - Only after completing steps above, generate the final code
   - Provide the ENTIRE file content with modifications integrated

## Critical Rules & Constraints:

**PRESERVATION IS KEY:** You MUST NOT rewrite entire components or files. Integrate your changes into the existing code. Preserve all existing logic, props, state, and comments not directly related to the user's request.

**MINIMALISM:** Only output files you have actually changed. If a file doesn't need modification, don't include it.

**COMPLETENESS:** Each file must be COMPLETE from first line to last:
- NEVER TRUNCATE - Include EVERY line
- NO ellipsis (...) to skip content
- ALL imports, functions, JSX, and closing tags must be present
- The file MUST be runnable

**SURGICAL PRECISION:**
- Change ONLY what's explicitly requested
- If user says "change background to green", change ONLY the background class
- 99% of the original code should remain untouched
- NO refactoring, reformatting, or "improvements" unless requested

**NO CONVERSATION:** Your output must contain ONLY the code. No explanations or apologies.

## EXAMPLES:

### CORRECT APPROACH for "change hero background to blue":
<thinking>
I need to change the background color of the Hero component. Looking at the file, I see the main div has 'bg-gray-900'. I will change ONLY this to 'bg-blue-500' and leave everything else exactly as is.
</thinking>

Then return the EXACT same file with only 'bg-gray-900' changed to 'bg-blue-500'.

### WRONG APPROACH (DO NOT DO THIS):
- Rewriting the Hero component from scratch
- Changing the structure or reorganizing imports
- Adding or removing unrelated code
- Reformatting or "cleaning up" the code

Remember: You are a SURGEON making a precise incision, not an artist repainting the canvas!`,
                          editIntent: {
                            type: searchPlan?.editType || 'UPDATE_COMPONENT',
                            targetFiles: targetFiles,
                            confidence: searchPlan ? 0.85 : 0.6,
                            description: searchPlan?.reasoning || 'Keyword-based file selection',
                            suggestedContext: []
                          }
                        };
                        
                        enhancedSystemPrompt = editContext.systemPrompt;
                        
                        await sendProgress({ 
                          type: 'status', 
                          message: `Identified edit type: ${editContext.editIntent.description}`
                        });
                      } else {
                        // Log and continue, as above: a missing plan costs
                        // precision, not the edit itself.
                        console.error('[generate-ai-code-stream] Failed to get search plan after fetch:', intent.error);
                        await recordJobStepFailure(generationJob?.id, {
                          key: 'analyze-edit-intent',
                          label: 'Plan the edit',
                          error: intent.error,
                        });
                      }
                    } catch (error) {
                      console.error('[generate-ai-code-stream] Error analyzing intent after fetch:', error);
                      await recordJobStepFailure(generationJob?.id, {
                        key: 'analyze-edit-intent',
                        label: 'Plan the edit',
                        error: error instanceof Error ? error.message : String(error),
                      });
                    }
                  }
                } else {
                  // Log and continue: the sandbox read is an attempt to recover
                  // context we do not have. Without it the model works from the
                  // prompt and the conversation alone, which is worse but still
                  // produces an edit.
                  console.error('[generate-ai-code-stream] Failed to read sandbox files:', filesData.error);
                  if (!sandboxReadWarned) {
                    await sendProgress({
                      type: 'warning',
                      message: SANDBOX_READ_FAILED_NOTICE,
                    });
                    sandboxReadWarned = true;
                  }
                  await recordJobStepFailure(generationJob?.id, {
                    key: 'read-sandbox-files',
                    label: 'Read current files',
                    error: filesData.error,
                  });
                }
              } catch (error) {
                console.error('[generate-ai-code-stream] Error fetching sandbox files:', error);
                if (!sandboxReadWarned) {
                  await sendProgress({
                    type: 'warning',
                    message: SANDBOX_READ_FAILED_NOTICE,
                  });
                  sandboxReadWarned = true;
                }
                await recordJobStepFailure(generationJob?.id, {
                  key: 'read-sandbox-files',
                  label: 'Read current files',
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            } else {
              console.log('[generate-ai-code-stream] No active sandbox to fetch files from');
              await sendProgress({ 
                type: 'warning', 
                message: NO_PROJECT_FILES_NOTICE,
              });
              sandboxReadWarned = true;
              await recordJobStepFailure(generationJob?.id, {
                key: 'read-sandbox-files',
                label: 'Read current files',
                error: 'No workspace was running for this project, so its current files could not be read.',
              });
            }
          }
        }
        
        // Build conversation context for system prompt
        let conversationContext = '';
        if (global.conversationState && global.conversationState.context.messages.length > 1) {
          console.log('[generate-ai-code-stream] Building conversation context');
          console.log('[generate-ai-code-stream] Total messages:', global.conversationState.context.messages.length);
          console.log('[generate-ai-code-stream] Total edits:', global.conversationState.context.edits.length);
          
          conversationContext = `\n\n## Conversation History (Recent)\n`;
          
          // Include only the last 3 edits to save context
          const recentEdits = global.conversationState.context.edits.slice(-3);
          if (recentEdits.length > 0) {
            console.log('[generate-ai-code-stream] Including', recentEdits.length, 'recent edits in context');
            conversationContext += `\n### Recent Edits:\n`;
            recentEdits.forEach(edit => {
              conversationContext += `- "${edit.userRequest}" → ${edit.editType} (${edit.targetFiles.map(f => f.split('/').pop()).join(', ')})\n`;
            });
          }
          
          // Include recently created files - CRITICAL for preventing duplicates
          const recentMsgs = global.conversationState.context.messages.slice(-5);
          const recentlyCreatedFiles: string[] = [];
          recentMsgs.forEach(msg => {
            if (msg.metadata?.editedFiles) {
              recentlyCreatedFiles.push(...msg.metadata.editedFiles);
            }
          });
          
          if (recentlyCreatedFiles.length > 0) {
            const uniqueFiles = [...new Set(recentlyCreatedFiles)];
            conversationContext += `\n### 🚨 RECENTLY CREATED/EDITED FILES (DO NOT RECREATE THESE):\n`;
            uniqueFiles.forEach(file => {
              conversationContext += `- ${file}\n`;
            });
            conversationContext += `\nIf the user mentions any of these components, UPDATE the existing file!\n`;
          }
          
          // Include only last 5 messages for context (reduced from 10)
          const recentMessages = recentMsgs;
          if (recentMessages.length > 2) { // More than just current message
            conversationContext += `\n### Recent Messages:\n`;
            recentMessages.slice(0, -1).forEach(msg => { // Exclude current message
              if (msg.role === 'user') {
                const truncatedContent = msg.content.length > 100 ? msg.content.substring(0, 100) + '...' : msg.content;
                conversationContext += `- "${truncatedContent}"\n`;
              }
            });
          }
          
          // Include only last 2 major changes
          const majorChanges = global.conversationState.context.projectEvolution.majorChanges.slice(-2);
          if (majorChanges.length > 0) {
            conversationContext += `\n### Recent Changes:\n`;
            majorChanges.forEach(change => {
              conversationContext += `- ${change.description}\n`;
            });
          }
          
          // Keep user preferences - they're concise
          const userPrefs = analyzeUserPreferences(global.conversationState.context.messages);
          if (userPrefs.commonPatterns.length > 0) {
            conversationContext += `\n### User Preferences:\n`;
            conversationContext += `- Edit style: ${userPrefs.preferredEditStyle}\n`;
          }
          
          // Limit total conversation context length
          if (conversationContext.length > 2000) {
            conversationContext = conversationContext.substring(0, 2000) + '\n[Context truncated to prevent length errors]';
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
        const stablePrefix = buildStablePromptPrefix(projectStack, projectDirection, { memoryBlock });
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
        let volatileSuffix = buildVolatilePromptSuffix({
          conversationContext,
          uiUxBrief,
          isEdit,
          editContext: promptEditContext,
          assetManifest,
        });
        // Keep getStackPrompt as the composed builder used by plan + this route.
        let systemPrompt = getStackPrompt(projectStack, projectDirection, {
          conversationContext,
          uiUxBrief,
          isEdit,
          editContext: promptEditContext,
          assetManifest,
        }, { memoryBlock });

        // If Morph Fast Apply is enabled (edit mode + MORPH_API_KEY), force <edit> block output
        const morphFastApplyEnabled = Boolean(isEdit && process.env.MORPH_API_KEY);
        if (morphFastApplyEnabled) {
          const morphRules = `

MORPH FAST APPLY MODE (EDIT-ONLY):
- Output edits as <edit> blocks, not full <file> blocks, for files that already exist.
- Format for each edit:
  <edit target_file="src/components/Header.jsx">
    <instructions>Describe the minimal change, single sentence.</instructions>
    <update>Provide the SMALLEST code snippet necessary to perform the change.</update>
  </edit>
- Only use <file> blocks when you must CREATE a brand-new file.
- Prefer ONE edit block for a simple change; multiple edits only if absolutely needed for separate files.
- Keep updates minimal and precise; do not rewrite entire files.
`;
          volatileSuffix += morphRules;
          systemPrompt += morphRules;
        }

        // Build full prompt with context
        let fullPrompt = prompt;
        if (context) {
          const contextParts = [];
          
          if (context.sandboxId) {
            contextParts.push(`Current sandbox ID: ${context.sandboxId}`);
          }
          
          if (context.structure) {
            contextParts.push(`Current file structure:\n${context.structure}`);
          }
          
          // Use backend file cache instead of frontend-provided files
          let backendFiles = global.sandboxState?.fileCache?.files || {};
          let hasBackendFiles = Object.keys(backendFiles).length > 0;
          
          console.log('[generate-ai-code-stream] Backend file cache status:');
          console.log('[generate-ai-code-stream] - Has sandboxState:', !!global.sandboxState);
          console.log('[generate-ai-code-stream] - Has fileCache:', !!global.sandboxState?.fileCache);
          console.log('[generate-ai-code-stream] - File count:', Object.keys(backendFiles).length);
          console.log('[generate-ai-code-stream] - Has manifest:', !!global.sandboxState?.fileCache?.manifest);
          
          // If no backend files and we're in edit mode, try to fetch from sandbox
          if (shouldRetrySandboxFileRead({
            hasBackendFiles,
            isEdit,
            hasActiveSandbox: Boolean(global.activeSandbox),
          })) {
            console.log('[generate-ai-code-stream] No backend files, attempting to fetch from sandbox...');
            
            try {
              const filesData = await readSandboxFiles();

              if (filesData.ok) {
                {
                  console.log('[generate-ai-code-stream] Successfully fetched', Object.keys(filesData.files).length, 'files from sandbox');
                  
                  // Initialize sandboxState if needed
                  if (!global.sandboxState) {
                    global.sandboxState = {
                      fileCache: {
                        files: {},
                        lastSync: Date.now(),
                        sandboxId: context?.sandboxId || 'unknown'
                      }
                    } as any;
                  } else if (!global.sandboxState.fileCache) {
                    global.sandboxState.fileCache = {
                      files: {},
                      lastSync: Date.now(),
                      sandboxId: context?.sandboxId || 'unknown'
                    };
                  }
                  
                  // Store files in cache
                  for (const [path, content] of Object.entries(filesData.files)) {
                    const normalizedPath = path.replace('/home/user/app/', '');
                    if (global.sandboxState.fileCache) {
                      global.sandboxState.fileCache.files[normalizedPath] = {
                        content: content as string,
                        lastModified: Date.now()
                      };
                    }
                  }
                  
                  if (filesData.manifest && global.sandboxState.fileCache) {
                    global.sandboxState.fileCache.manifest = filesData.manifest;
                    
                    // Now try to analyze edit intent with the fetched manifest
                    if (!editContext) {
                      console.log('[generate-ai-code-stream] Analyzing edit intent with fetched manifest');
                      try {
                        const intent = await analyzeEditIntent({
                          prompt,
                          manifest: filesData.manifest,
                          model,
                        });

                        if (intent.ok) {
                          console.log('[generate-ai-code-stream] Search plan received:', intent.searchPlan);
                          
                          // Create edit context from AI analysis
                          // Note: We can't execute search here without file contents, so fall back to keyword method
                          const fileContext = selectFilesForEdit(prompt, filesData.manifest);
                          editContext = fileContext;
                          enhancedSystemPrompt = fileContext.systemPrompt;
                          
                          console.log('[generate-ai-code-stream] Edit context created with', editContext.primaryFiles.length, 'primary files');
                        } else {
                          // Log and continue: same trade-off as the other two
                          // planning call sites.
                          console.error('[generate-ai-code-stream] Failed to get search plan:', intent.error);
                          await recordJobStepFailure(generationJob?.id, {
                            key: 'analyze-edit-intent',
                            label: 'Plan the edit',
                            error: intent.error,
                          });
                        }
                      } catch (error) {
                        console.error('[generate-ai-code-stream] Failed to analyze edit intent:', error);
                        await recordJobStepFailure(generationJob?.id, {
                          key: 'analyze-edit-intent',
                          label: 'Plan the edit',
                          error: error instanceof Error ? error.message : String(error),
                        });
                      }
                    }
                  }
                  
                  // Update variables
                  backendFiles = global.sandboxState.fileCache?.files || {};
                  hasBackendFiles = Object.keys(backendFiles).length > 0;
                  console.log('[generate-ai-code-stream] Updated backend cache with fetched files');
                }
              } else {
                // Log and continue: this is a best-effort attempt to recover a
                // file cache we do not have. The generation proceeds with the
                // context already assembled.
                console.error('[generate-ai-code-stream] Failed to read sandbox files:', filesData.error);
                if (!sandboxReadWarned) {
                  await sendProgress({
                    type: 'warning',
                    message: SANDBOX_READ_FAILED_NOTICE,
                  });
                  sandboxReadWarned = true;
                }
                await recordJobStepFailure(generationJob?.id, {
                  key: 'read-sandbox-files',
                  label: 'Read current files',
                  error: filesData.error,
                });
              }
            } catch (error) {
              console.error('[generate-ai-code-stream] Failed to fetch sandbox files:', error);
              await recordJobStepFailure(generationJob?.id, {
                key: 'read-sandbox-files',
                label: 'Read current files',
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
          
          // Include current file contents from backend cache
          if (hasBackendFiles) {
            // If we have edit context, use intelligent file selection
            if (editContext && editContext.primaryFiles.length > 0) {
              contextParts.push('\nEXISTING APPLICATION - TARGETED EDIT MODE');
              contextParts.push(`\n${editContext.systemPrompt || enhancedSystemPrompt}\n`);
              
              // Get contents of primary and context files
              const primaryFileContents = await getFileContents(editContext.primaryFiles, global.sandboxState!.fileCache!.manifest!);
              const contextFileContents = await getFileContents(editContext.contextFiles, global.sandboxState!.fileCache!.manifest!);
              const formattedFiles = formatFilesForAI(primaryFileContents, {});
              contextParts.push(formattedFiles);
              const selectedRest = selectFileContext({
                files: contextFileContents,
                userMessage: prompt,
                recentlyModifiedPaths: editContext.primaryFiles,
              });
              if (selectedRest.formatted) {
                contextParts.push(selectedRest.formatted);
              }
              
              contextParts.push('\nIMPORTANT: Only modify the files listed under "Files to Edit". The context files are provided for reference only.');
            } else {
              console.log('[generate-ai-code-stream] Selective file context (no edit-context primary set)');
              contextParts.push('\nEXISTING APPLICATION - TARGETED EDIT REQUIRED');
              contextParts.push('\nYou MUST analyze the user request and determine which specific file(s) to edit.');
              const recentPaths = (global.conversationState?.context.edits ?? [])
                .flatMap((edit) => edit.targetFiles || [])
                .slice(-12);
              const selected = selectFileContext({
                files: backendFiles,
                userMessage: prompt,
                recentlyModifiedPaths: recentPaths,
              });
              console.log(
                `[generate-ai-code-stream] Selective context: ${selected.fullPaths.length} full, ${selected.pathOnly.length} path-only, ~${selected.estimatedTokens} tokens`,
              );
              contextParts.push(selected.formatted);
              contextParts.push('\nEdit only the files required. Path-only entries are listed for orientation — do not regenerate them.');
            }
          } else if (context.currentFiles && Object.keys(context.currentFiles).length > 0) {
            console.log('[generate-ai-code-stream] Warning: Backend cache empty, using selective frontend files');
            contextParts.push('\nEXISTING APPLICATION - DO NOT REGENERATE FROM SCRATCH');
            const recentPaths = (global.conversationState?.context.edits ?? [])
              .flatMap((edit) => edit.targetFiles || [])
              .slice(-12);
            const selected = selectFileContext({
              files: context.currentFiles as Record<string, string>,
              userMessage: prompt,
              recentlyModifiedPaths: recentPaths,
              primaryPaths: editContext?.primaryFiles,
            });
            contextParts.push(selected.formatted);
            contextParts.push('\nThe listed full files already exist. Generate ONLY files that must change.');
          }
          
          // Add explicit edit mode indicator
          if (isEdit) {
            contextParts.push('\nEDIT MODE ACTIVE');
            contextParts.push('This is an incremental update to an existing application.');
            contextParts.push('DO NOT regenerate App.jsx, index.css, or other core files unless explicitly requested.');
            contextParts.push('ONLY create or modify the specific files needed for the user\'s request.');
            contextParts.push('\n⚠️ CRITICAL FILE OUTPUT FORMAT - VIOLATION = FAILURE:');
            contextParts.push('YOU MUST OUTPUT EVERY FILE IN THIS EXACT XML FORMAT:');
            contextParts.push('<file path="src/components/ComponentName.jsx">');
            contextParts.push('// Complete file content here');
            contextParts.push('</file>');
            contextParts.push('<file path="src/index.css">');
            contextParts.push('/* CSS content here */');
            contextParts.push('</file>');
            contextParts.push('\n❌ NEVER OUTPUT: "Generated Files: index.css, App.jsx"');
            contextParts.push('❌ NEVER LIST FILE NAMES WITHOUT CONTENT');
            contextParts.push('✅ ALWAYS: One <file> tag per file with COMPLETE content');
            contextParts.push('✅ ALWAYS: Include EVERY file you modified');
          } else if (!hasBackendFiles) {
            // First generation mode - make it beautiful!
            contextParts.push('\n🎨 FIRST GENERATION MODE - CREATE SOMETHING BEAUTIFUL!');
            contextParts.push('\nThis is the user\'s FIRST experience. Make it impressive:');
            contextParts.push('1. **USE TAILWIND PROPERLY** - Use standard Tailwind color classes');
            contextParts.push('2. **NO PLACEHOLDERS** - Use real content, not lorem ipsum');
            contextParts.push('3. **COMPLETE COMPONENTS** - Header, Hero, Features, Footer minimum');
            contextParts.push('4. **VISUAL POLISH** - Shadows, hover states, transitions');
            contextParts.push('5. **STANDARD CLASSES** - bg-white, text-gray-900, bg-blue-500, NOT bg-background');
            contextParts.push('\nCreate a polished, professional application that works perfectly on first load.');
            contextParts.push('\n⚠️ OUTPUT FORMAT:');
            contextParts.push('Use <file path="...">content</file> tags for EVERY file');
            contextParts.push('NEVER output "Generated Files:" as plain text');
          }
          
          // Add conversation context (scraped websites, etc)
          if (context.conversationContext) {
            if (context.conversationContext.scrapedWebsites?.length > 0) {
              contextParts.push('\nScraped Websites in Context:');
              context.conversationContext.scrapedWebsites.forEach((site: any) => {
                contextParts.push(`\nURL: ${site.url}`);
                contextParts.push(`Scraped: ${new Date(site.timestamp).toLocaleString()}`);
                if (site.content) {
                  // Include a summary of the scraped content
                  const contentPreview = typeof site.content === 'string' 
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
            if (morphFastApplyEnabled) {
              contextParts.push('\nOUTPUT FORMAT (REQUIRED IN MORPH MODE):');
              contextParts.push('<edit target_file="src/components/Component.jsx">');
              contextParts.push('<instructions>Minimal, precise instruction.</instructions>');
              contextParts.push('<update>// Smallest necessary snippet</update>');
              contextParts.push('</edit>');
              contextParts.push('\nIf you need to create a NEW file, then and only then output a full file:');
              contextParts.push('<file path="src/components/NewComponent.jsx">');
              contextParts.push('// Full file content when creating new files');
              contextParts.push('</file>');
            }
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
        
        // Determine which provider to use based on model
        const isAnthropic = model.startsWith('anthropic/');
        const isGoogle = model.startsWith('google/');
        const isOpenAI = model.startsWith('openai/');
        const isKimiGroq = model === 'moonshotai/kimi-k2-instruct-0905';
        const modelProvider = isAnthropic ? anthropic : 
                              (isOpenAI ? openai : 
                              (isGoogle ? googleGenerativeAI : 
                              (isKimiGroq ? groq : groq)));
        
        // Fix model name transformation for different providers
        let actualModel: string;
        if (isAnthropic) {
          actualModel = model.replace('anthropic/', '');
        } else if (isOpenAI) {
          actualModel = model.replace('openai/', '');
        } else if (isKimiGroq) {
          // Kimi on Groq - use full model string
          actualModel = 'moonshotai/kimi-k2-instruct-0905';
        } else if (isGoogle) {
          // Google uses specific model names - convert our naming to theirs  
          actualModel = model.replace('google/', '');
        } else {
          actualModel = model;
        }

        console.log(`[generate-ai-code-stream] Using provider: ${isAnthropic ? 'Anthropic' : isGoogle ? 'Google' : isOpenAI ? 'OpenAI' : 'Groq'}, model: ${actualModel}`);
        console.log(`[generate-ai-code-stream] AI Gateway enabled: ${isUsingAIGateway}`);
        console.log(`[generate-ai-code-stream] Model string: ${model}`);

        // Stable prefix first (cacheable). Volatile user + file context last.
        const streamOptions: any = {
          model: modelProvider(actualModel),
          messages: buildCachedMessages({
            stablePrefix,
            volatileUser: [injectedSkills.block, volatileSuffix, fullPrompt].filter(Boolean).join('\n\n'),
            enableAnthropicCache: isAnthropic,
          }),
          maxTokens: 8192, // Reduce to ensure completion
          stopSequences: [] // Don't stop early
          // Note: Neither Groq nor Anthropic models support tool/function calling in this context
          // We use XML tags for package detection instead
        };
        
        // Add temperature for non-reasoning models
        if (!model.startsWith('openai/gpt-5')) {
          streamOptions.temperature = 0.7;
        }
        
        // Add reasoning effort for GPT-5 models
        if (isOpenAI) {
          streamOptions.experimental_providerMetadata = {
            openai: {
              reasoningEffort: 'high'
            }
          };
        }
        
        let result: Awaited<ReturnType<typeof streamText>> | undefined;
        let generatedCode = '';
        let files: { path: string; content: string }[] = [];
        let currentFile = '';
        let currentFilePath = '';
        let componentCount = 0;
        let providersTried: string[] = [];
        try {
            const failover = await executeWithCompletionFailover(
              providerChain,
              async (entry, ctx) => {
                servedProvider = entry.provider;
                servedModel = entry.model;
                const prefixed =
                  entry.provider === 'openai'
                    ? `openai/${entry.model}`
                    : entry.provider === 'anthropic'
                      ? `anthropic/${entry.model}`
                      : entry.provider === 'google'
                        ? `google/${entry.model}`
                        : entry.model;
                const client = clientForEntry(entry, providerEnv);
                const actualModel = prefixed.includes('/') ? prefixed.split('/').slice(1).join('/') : entry.model;
                const nextOptions = {
                  ...streamOptions,
                  model: client(actualModel),
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
                currentFile = '';
                currentFilePath = '';
                let isInFile = false;
                let isInTag = false;
                let conversationalBuffer = '';
                let tagBuffer = '';
                packagesToInstall.length = 0;

        // Stream the response and parse in real-time
        for await (const textPart of stream.textStream || []) {
          if (clientDisconnected) break;
          const text = textPart || '';
          generatedCode += text;
          currentFile += text;
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
          const hasOpenTag = /<(file|package|packages|explanation|command|structure|template)\b/.test(text);
          const hasCloseTag = /<\/(file|package|packages|explanation|command|structure|template)>/.test(text);
          
          if (hasOpenTag) {
            // Send any buffered conversational text before the tag
            if (conversationalBuffer.trim() && !isInTag) {
              await sendProgress({ 
                type: 'conversation', 
                text: conversationalBuffer.trim()
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
            raw: true 
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
                  message: `Package detected: ${packageName}`
                });
              }
              lastIndex = packageMatch.index + packageMatch[0].length;
            }
          }
          
          // Keep unmatched portion in buffer for next iteration
          tagBuffer = searchText.substring(Math.max(0, lastIndex - 50)); // Keep last 50 chars
          
          // Check for file boundaries
          if (text.includes('<file path="')) {
            const pathMatch = text.match(/<file path="([^"]+)"/);
            if (pathMatch) {
              currentFilePath = pathMatch[1];
              isInFile = true;
              currentFile = text;
            }
          }
          
          // Check for file end
          if (isInFile && currentFile.includes('</file>')) {
            isInFile = false;
            const closed = currentFile.match(/<file path="[^"]+">([\s\S]*?)<\/file>/);
            if (jobProgress && currentFilePath) {
              const content = (closed?.[1] ?? '').trim();
              const fileAbort = capTracker.addFile(currentFilePath, content);
              jobProgress.addFile(currentFilePath, content);
              if (fileAbort) {
                await jobProgress.flush();
                throw fileAbort;
              }
            }
            
            // Send component progress update
            if (currentFilePath.includes('components/')) {
              componentCount++;
              const componentName = currentFilePath.split('/').pop()?.replace('.jsx', '') || 'Component';
              await sendProgress({ 
                type: 'component', 
                name: componentName,
                path: currentFilePath,
                index: componentCount
              });
            } else if (currentFilePath.includes('App.jsx')) {
              await sendProgress({ 
                type: 'app', 
                message: 'Generated main App.jsx',
                path: currentFilePath
              });
            }
            
            currentFile = '';
            currentFilePath = '';
          }
        }
        
        console.log('\n\n[generate-ai-code-stream] Streaming complete.');

        if (clientDisconnected) {
          // Whatever the model produced so far is already on the job row via jobProgress, so
          // the recovery panel can resume from it. The `finally` settles the job as abandoned.
          log.warn('generation.stopped_mid_stream', {
            jobId: generationJob?.id ?? null,
            reason: clientDisconnectReason,
            charsGenerated: generatedCode.length,
          });
          return { generatedCode, files, morphEditBlocks: 0, stop: true as const };
        }
        
        // Send any remaining conversational text
        if (conversationalBuffer.trim()) {
          await sendProgress({ 
            type: 'conversation', 
            text: conversationalBuffer.trim()
          });
        }
        
        // Also parse <packages> tag for multiple packages - ONLY for edits
        if (isEdit) {
          const packagesRegex = /<packages>([\s\S]*?)<\/packages>/g;
          let packagesMatch;
          while ((packagesMatch = packagesRegex.exec(generatedCode)) !== null) {
            const packagesContent = packagesMatch[1].trim();
            const packagesList = packagesContent.split(/[\n,]+/)
              .map(pkg => pkg.trim())
              .filter(pkg => pkg.length > 0);
            
            for (const packageName of packagesList) {
              if (!packagesToInstall.includes(packageName)) {
                packagesToInstall.push(packageName);
                console.log(`[generate-ai-code-stream] Package from <packages> tag: ${packageName}`);
                await sendProgress({ 
                  type: 'package', 
                  name: packageName,
                  message: `Package detected: ${packageName}`
                });
              }
            }
          }
        }
        
        // Function to extract packages from import statements
        function extractPackagesFromCode(content: string): string[] {
          const packages: string[] = [];
          // Match ES6 imports
          const importRegex = /import\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+\w+|\w+))*\s+from\s+)?['"]([^'"]+)['"]/g;
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
        
        // Parse files and send progress for each
        const fileRegex = /<file path="([^"]*)">([\s\S]*?)<\/file>/g;
        let match;
        
        while ((match = fileRegex.exec(generatedCode)) !== null) {
          const filePath = match[1];
          const content = match[2].trim();
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
                console.log(`[generate-ai-code-stream] Package detected from imports: ${pkg}`);
                await sendProgress({ 
                  type: 'package', 
                  name: pkg,
                  message: `Package detected from imports: ${pkg}`
                });
              }
            }
          }
          
          // Send progress for each file (reusing componentCount from streaming)
          if (filePath.includes('components/')) {
            const componentName = filePath.split('/').pop()?.replace('.jsx', '') || 'Component';
            await sendProgress({ 
              type: 'component', 
              name: componentName,
              path: filePath,
              index: componentCount
            });
          } else if (filePath.includes('App.jsx')) {
            await sendProgress({ 
              type: 'app', 
              message: 'Generated main App.jsx',
              path: filePath
            });
          }
        }

                const morphEditBlocks = (generatedCode.match(/<edit\s+target_file="/g) || []).length;
                const summary = summarizeGenerationOutput(generatedCode);
                log.info('generation.stream_complete', {
                  jobId: generationJob?.id ?? null,
                  provider: entry.provider,
                  model: entry.model,
                  chars: summary.chars,
                  preview: summary.preview,
                  fileOpen: summary.fileOpen,
                  fileClose: summary.fileClose,
                  markdownFences: summary.markdownFences,
                });
                return {
                  generatedCode,
                  files,
                  morphEditBlocks,
                  stop: clientDisconnected,
                };
              },
              (out) => out.stop || !producedNoChanges(out.files.length, out.morphEditBlocks),
              { circuit: getDefaultCircuit() },
            );
            servedProvider = failover.provider;
            servedModel = failover.model;
            generatedCode = failover.result.generatedCode;
            files = failover.result.files;
            providersTried = [...new Set(failover.attempts.map((row) => providerDisplayName(row.provider)))];
            if (generationJob) {
              await updateJobFields(generationJob.id, {
                provider: failover.provider,
                model: failover.model,
              });
              await recordProviderAttempts(generationJob.id, failover.attempts);
            }
            if (failover.failedOver) {
              const from = failover.attempts.find((row) => !row.ok)?.provider as ProviderName | undefined;
              if (from) {
                await sendProgress({
                  type: 'info',
                  message: failoverNotice(from, failover.provider),
                });
              }
            }
        } catch (streamError: unknown) {
            if (streamError instanceof JobCapError) throw streamError;
            const cause = streamError instanceof ProviderRunError ? streamError.causeError ?? streamError : streamError;
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

        if (clientDisconnected) {
          return;
        }
        
        // Extract explanation
        const explanationMatch = generatedCode.match(/<explanation>([\s\S]*?)<\/explanation>/);
        const explanation = explanationMatch ? explanationMatch[1].trim() : 'Code generated successfully!';
        
        // Validate generated code for truncation issues
        const truncationWarnings: string[] = [];
        
        // Skip ellipsis checking entirely - too many false positives with spread operators, loading text, etc.
        
        // Check for unclosed file tags
        const fileOpenCount = (generatedCode.match(/<file path="/g) || []).length;
        const fileCloseCount = (generatedCode.match(/<\/file>/g) || []).length;
        if (fileOpenCount !== fileCloseCount) {
          truncationWarnings.push(`Unclosed file tags detected: ${fileOpenCount} open, ${fileCloseCount} closed`);
        }
        
        // Check for files that seem truncated (very short or ending abruptly)
        const truncationCheckRegex = /<file path="([^"]+)">([\s\S]*?)(?:<\/file>|$)/g;
        let truncationMatch;
        while ((truncationMatch = truncationCheckRegex.exec(generatedCode)) !== null) {
          const filePath = truncationMatch[1];
          const content = truncationMatch[2];
          
          // Only check for really obvious HTML truncation - file ends with opening tag
          if (content.trim().endsWith('<') || content.trim().endsWith('</')) {
            truncationWarnings.push(`File ${filePath} appears to have incomplete HTML tags`);
          }
          
          // Skip "..." check - too many false positives with loading text, etc.
          
          // Only check for SEVERE truncation issues
          if (filePath.match(/\.(jsx?|tsx?)$/)) {
            // Only check for severely unmatched brackets (more than 3 difference)
            const openBraces = (content.match(/{/g) || []).length;
            const closeBraces = (content.match(/}/g) || []).length;
            const braceDiff = Math.abs(openBraces - closeBraces);
            if (braceDiff > 3) { // Only flag severe mismatches
              truncationWarnings.push(`File ${filePath} has severely unmatched braces (${openBraces} open, ${closeBraces} closed)`);
            }
            
            // Check if file is extremely short and looks incomplete
            if (content.length < 20 && content.includes('function') && !content.includes('}')) {
              truncationWarnings.push(`File ${filePath} appears severely truncated`);
            }
          }
        }
        
        // Handle truncation with automatic retry (if enabled in config)
        if (truncationWarnings.length > 0 && appConfig.codeApplication.enableTruncationRecovery) {
          console.warn('[generate-ai-code-stream] Truncation detected, attempting to fix:', truncationWarnings);
          
          await sendProgress({
            type: 'warning',
            message: 'Detected incomplete code generation. Attempting to complete...',
            warnings: truncationWarnings
          });
          
          // Try to fix truncated files automatically
          const truncatedFiles: string[] = [];
          const fileRegex = /<file path="([^"]+)">([\s\S]*?)(?:<\/file>|$)/g;
          let match;
          
          while ((match = fileRegex.exec(generatedCode)) !== null) {
            const filePath = match[1];
            const content = match[2];
            
            // Check if this file appears truncated - be more selective
            const hasEllipsis = content.includes('...') && 
                               !content.includes('...rest') && 
                               !content.includes('...props') &&
                               !content.includes('spread');
                               
            const endsAbruptly = content.trim().endsWith('...') || 
                                 content.trim().endsWith(',') ||
                                 content.trim().endsWith('(');
                                 
            const hasUnclosedTags = content.includes('</') && 
                                    !content.match(/<\/[a-zA-Z0-9]+>/) &&
                                    content.includes('<');
                                    
            const tooShort = content.length < 50 && filePath.match(/\.(jsx?|tsx?)$/);
            
            // Check for unmatched braces specifically
            const openBraceCount = (content.match(/{/g) || []).length;
            const closeBraceCount = (content.match(/}/g) || []).length;
            const hasUnmatchedBraces = Math.abs(openBraceCount - closeBraceCount) > 1;
            
            const isTruncated = (hasEllipsis && endsAbruptly) || 
                               hasUnclosedTags || 
                               (tooShort && !content.includes('export')) ||
                               hasUnmatchedBraces;
            
            if (isTruncated) {
              truncatedFiles.push(filePath);
            }
          }
          
          // If we have truncated files, try to regenerate them
          if (truncatedFiles.length > 0) {
            console.log('[generate-ai-code-stream] Attempting to regenerate truncated files:', truncatedFiles);

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
                : null) ?? providerChain[0] ?? null;
            let recoveryFailure: TruncationRecoveryOutcome | null = null;

            for (const filePath of truncatedFiles) {
              // One provider failure will repeat for every remaining file, so stop asking.
              if (recoveryFailure) break;
              await sendProgress({
                type: 'info',
                message: `Completing ${filePath}...`
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
                        content: 'You are completing a truncated file. Provide the complete, working file content.'
                      },
                      { role: 'user', content: completionPrompt }
                    ],
                    temperature: recoveryEntry.model.startsWith('gpt-5')
                      ? undefined
                      : appConfig.ai.defaultTemperature,
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

                // Replace the truncated file in the generatedCode
                const filePattern = new RegExp(
                  `<file path="${filePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}">[\\s\\S]*?(?:</file>|$)`,
                  'g'
                );
                generatedCode = generatedCode.replace(
                  filePattern,
                  `<file path="${filePath}">\n${cleanContent}\n</file>`
                );

                console.log(`[generate-ai-code-stream] Successfully completed ${filePath}`);
              } catch (completionError) {
                console.error(`[generate-ai-code-stream] Failed to complete ${filePath}:`, completionError);
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
              // Clear the warnings only when every truncated file was actually rewritten.
              truncationWarnings.length = 0;
              await sendProgress({
                type: 'info',
                message: `Completed ${truncatedFiles.length} truncated file${truncatedFiles.length === 1 ? '' : 's'}.`
              });
            }
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
          outputTokens = usage && typeof usage === 'object' && 'outputTokens' in usage
            ? Number((usage as { outputTokens?: number }).outputTokens)
            : undefined;
          if (usageProjectId) {
            await attachGenerationInputTokens(usageProjectId, inputTokens);
          }
        } catch (tokenError) {
          logError('generation.tokens_failed', tokenError);
        }

        // A run that produced neither a <file> block nor a Morph <edit> block changed
        // nothing. That used to end as a 200 with `files: 0` and a SUCCEEDED job, which told
        // the user their request had been carried out when it had not.
        const morphEditBlocks = (generatedCode.match(/<edit\s+target_file="/g) || []).length;
        const hadNoChanges = producedNoChanges(files.length, morphEditBlocks);
        const noChangeReason = hadNoChanges
          ? describeNoChanges({
              isEdit,
              hasProjectFiles: Object.keys(global.sandboxState?.fileCache?.files || {}).length > 0,
              hasManifest: Boolean(global.sandboxState?.fileCache?.manifest),
              providersTried,
            })
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
              noChangeReason,
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
          trackFailure('generation.failure', new Error(streamSettle.errorCode || 'sandbox_unavailable'), {
            action: 'generation',
            stack: projectStack,
            model,
            durationMs: Date.now() - startedAt,
          });
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
        
        // Track edit in conversation history
        if (isEdit && editContext && global.conversationState) {
          const editRecord: ConversationEdit = {
            timestamp: Date.now(),
            userRequest: prompt,
            editType: editContext.editIntent.type,
            targetFiles: editContext.primaryFiles,
            confidence: editContext.editIntent.confidence,
            outcome: 'success' // Assuming success if we got here
          };
          
          global.conversationState.context.edits.push(editRecord);
          
          // Track major changes
          if (editContext.editIntent.type === 'ADD_FEATURE' || files.length > 3) {
            global.conversationState.context.projectEvolution.majorChanges.push({
              timestamp: Date.now(),
              description: editContext.editIntent.description,
              filesAffected: editContext.primaryFiles
            });
          }
          
          // Update last updated timestamp
          global.conversationState.lastUpdated = Date.now();
          
          console.log('[generate-ai-code-stream] Updated conversation history with edit:', editRecord);
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
            ? error.causeError ?? error
            : error && typeof error === 'object' && 'cause' in error
              ? (error as { cause: unknown }).cause
              : error;
        const honest =
          cap?.message ??
          (isToolValidationError ? errorMessage : providerFailureMessage(cause, servedProvider));
        if (isToolValidationError) {
          console.error('[generate-ai-code-stream] Tool call validation error - this may be due to the AI model sending incorrect parameters');
          await sendProgress({ 
            type: 'warning', 
            message: 'Package installation tool encountered an issue. Packages will be detected from imports instead.'
          });
        } else {
          await sendProgress({ 
            type: 'error', 
            error: honest 
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
        // disconnect skipped the release, which is what stops `lockHeartbeat`, and the
        // project lock then renewed itself every 60 seconds indefinitely. Cleanup that must
        // happen runs first; the close is last and cannot skip anything.
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
        'Connection': 'keep-alive',
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