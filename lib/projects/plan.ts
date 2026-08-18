import { AsyncLocalStorage } from 'node:async_hooks';
import { generateObject, generateText } from 'ai';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { getSessionUser, type SessionUser } from '@/lib/auth';
import { clientForEntry } from '@/lib/ai/client-for-entry';
import { loadEffectiveProviderEnv } from '@/lib/ai/effective-env';
import { completeWithProviderFailover } from '@/lib/ai/plan-complete';
import {
  jobErrorCodeForProviderFailure,
  providerFailureMessage,
  shouldFailover,
} from '@/lib/ai/failover';
import { modelIdForEntry } from '@/lib/ai/providers';
import { ProviderRunError, type ProviderAttempt } from '@/lib/ai/run';
import { appConfig } from '@/config/app.config';
import { buildUiUxProMaxBrief } from '@/lib/ui-ux-pro-max/build-design-brief';
import { looksLikeUrl } from '@/lib/projects/prompt';
import { parseWithZod, refinePlanSchema, followUpPlanSchema } from '@/lib/projects/schema';
import { logGenerationEvent } from '@/lib/usage-costs';
import { buildCachedMessages } from '@/lib/generation/prompt-cache';
import { resolveInputTokens } from '@/lib/generation/token-estimate';
import { buildStablePromptPrefix, getStackPrompt } from '@/lib/stack-prompts';
import { getStack } from '@/lib/stacks';
import { resolveDirectionId } from '@/lib/design/directions';
import { getCurrentProjectFiles } from '@/lib/github/current-files';
import { injectMatchedSkills } from '@/lib/skills/inject';
import { buildMemoryBlock } from '@/lib/memory/build-context';
import { revertApprovedPlan } from '@/lib/projects/plan-compensate';
import { planRetryKind } from '@/lib/projects/plan-retry';

type ActionErr = {
  ok: false;
  error: string;
  status: number;
  details?: unknown;
};
type ActionOk<T> = { ok: true; data: T };
type ActionResult<T> = ActionOk<T> | ActionErr;

export type PlanTrigger = 'initial' | 'followup';

export type PlanContent = {
  summary: string;
  pages: { name: string; description: string }[];
  keyFeatures: string[];
};

export type GenerationStart = {
  projectId: string;
  userId: string;
  promptContext: string;
  kind: PlanTrigger;
};

export type PlanCompleter = (input: {
  promptContext: string;
  systemPrompt: string;
  stablePrefix?: string;
}) => Promise<PlanContent>;

const planContentSchema = z.object({
  summary: z.string().min(1),
  pages: z.array(
    z.object({
      name: z.string().min(1),
      description: z.string().min(1),
    }),
  ).min(1),
  keyFeatures: z.array(z.string().min(1)).min(1),
});

const actorStore = new AsyncLocalStorage<SessionUser>();
let planCompleterOverride: PlanCompleter | null = null;
let lastGenerationStart: GenerationStart | null = null;

export function runWithActor<T>(user: SessionUser, fn: () => T): T {
  return actorStore.run(user, fn);
}

export function peekActor(): SessionUser | undefined {
  return actorStore.getStore();
}

/** Acceptance-script seam. Production uses the shared AI provider. */
export function setPlanCompleter(fn: PlanCompleter | null) {
  planCompleterOverride = fn;
}

function unauthorized(): ActionErr {
  return { ok: false, error: 'Sign in required', status: 401 };
}

function notFound(): ActionErr {
  return { ok: false, error: 'Project not found', status: 404 };
}

function forbidden(): ActionErr {
  return { ok: false, error: 'Forbidden', status: 403 };
}

function canMutate(user: SessionUser, ownerId: string) {
  return user.id === ownerId || user.role === 'ADMIN';
}

async function requireActor() {
  const stored = peekActor();
  if (stored) return { user: stored, err: null };
  const user = await getSessionUser();
  if (!user) return { user: null, err: unauthorized() as ActionErr };
  return { user, err: null };
}

function buildPlanSystemPrompt(
  promptContext: string,
  stack: string,
  designDirection?: string | null,
  extras?: { memoryBlock?: string },
) {
  const stackId = getStack(stack).id;
  const brief = buildUiUxProMaxBrief({ prompt: promptContext, isEdit: false });
  const stackPrompt = getStackPrompt(stackId, designDirection, {
    conversationContext: '',
    uiUxBrief: brief,
    isEdit: false,
  }, extras);
  return `${stackPrompt}

You are planning a website for the ${stackId} stack. Output a structured plan only. Do NOT write application code, file contents, markup, or diffs.

Return JSON only, matching:
{
  "summary": string,
  "pages": [{ "name": string, "description": string }],
  "keyFeatures": string[]
}`;
}

function parsePlanJson(raw: string): PlanContent {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  const jsonText = start >= 0 && end > start ? candidate.slice(start, end + 1) : candidate;
  return planContentSchema.parse(JSON.parse(jsonText));
}

async function defaultCompletePlan(input: {
  promptContext: string;
  systemPrompt: string;
  stablePrefix?: string;
}): Promise<{ content: PlanContent; provider: string; model: string; attempts: ProviderAttempt[] }> {
  const userPrompt = `Create a website plan (no code) for:\n\n${input.promptContext}`;
  // Planning selects and pays with the same keys as building: the effective-env
  // overlay (personal key -> org key -> process.env). Before this, the chain and
  // clients here saw process.env alone, so an admin-UI-only deployment could
  // build but never plan.
  const providerEnv = await loadEffectiveProviderEnv(peekActor()?.id ?? null, process.env);
  const failover = await completeWithProviderFailover({
    env: providerEnv,
    run: async (entry, ctx) => {
      const modelId = modelIdForEntry(entry);
      const client = clientForEntry(entry, providerEnv);
      const model = client(entry.model);
      const enableAnthropicCache = modelId.startsWith('anthropic/');
      const cached = input.stablePrefix
        ? buildCachedMessages({
            stablePrefix: input.stablePrefix,
            volatileUser: `${input.systemPrompt.replace(input.stablePrefix, '').trim()}\n\n${userPrompt}`,
            enableAnthropicCache,
          })
        : null;
      try {
        const result = cached
          ? await generateObject({
              model,
              schema: planContentSchema,
              messages: cached,
              abortSignal: ctx.signal,
            })
          : await generateObject({
              model,
              schema: planContentSchema,
              system: input.systemPrompt,
              prompt: userPrompt,
              abortSignal: ctx.signal,
            });
        return result.object;
      } catch (error) {
        // Provider-side failures (401 / 429 / 5xx / timeout) switch immediately.
        // A structured-output mismatch is a request-shape issue — try JSON text once.
        if (shouldFailover(error)) throw error;
        const result = cached
          ? await generateText({
              model,
              abortSignal: ctx.signal,
              messages: cached.map((message) => ({
                ...message,
                content:
                  message.role === 'user'
                    ? `${message.content}\n\nReturn ONLY valid JSON for the plan shape. No code.`
                    : message.content,
              })),
            })
          : await generateText({
              model,
              abortSignal: ctx.signal,
              system: input.systemPrompt,
              prompt: `${userPrompt}\n\nReturn ONLY valid JSON for the plan shape. No code.`,
            });
        return parsePlanJson(result.text);
      }
    },
  });
  return {
    content: failover.result,
    provider: failover.provider,
    model: failover.model,
    attempts: failover.attempts,
  };
}

async function completePlan(promptContext: string, systemPrompt: string, stablePrefix?: string) {
  if (planCompleterOverride) {
    const content = await planCompleterOverride({ promptContext, systemPrompt, stablePrefix });
    return { content, provider: null as string | null, model: null as string | null, attempts: [] as ProviderAttempt[] };
  }
  return defaultCompletePlan({ promptContext, systemPrompt, stablePrefix });
}

export function combineBuildContext(initialPrompt: string, content: PlanContent) {
  return `${initialPrompt}\n\nApproved plan:\n${JSON.stringify(content)}`;
}

export function peekLastGenerationStart() {
  return lastGenerationStart;
}

async function startLoggedGeneration(input: GenerationStart) {
  lastGenerationStart = input;
  await logGenerationEvent({
    projectId: input.projectId,
    userId: input.userId,
    kind: input.kind,
    isUrlClone: looksLikeUrl(input.promptContext),
  });
}

/** Same generation entry createProject uses when skipPlanning is true. */
export async function startInitialGeneration(input: {
  projectId: string;
  userId: string;
  promptContext: string;
}) {
  await startLoggedGeneration({ ...input, kind: 'initial' });
}

/** Same GenerationEvent entry the isEdit / mode=build follow-up path logs. */
export async function startFollowUpGeneration(input: {
  projectId: string;
  userId: string;
  promptContext: string;
}) {
  await startLoggedGeneration({ ...input, kind: 'followup' });
}

type ConversationMessageLite = { role?: string; content?: string };

function recentFollowUpMessages() {
  const state = (
    globalThis as {
      conversationState?: { context?: { messages?: ConversationMessageLite[] } };
    }
  ).conversationState;
  return state?.context?.messages?.slice(-20) ?? [];
}

/** File tree + recent messages from the same sources the isEdit follow-up path uses. */
export function buildFollowUpPromptContext(message: string, lastCode: string | null | undefined) {
  const files = getCurrentProjectFiles({ lastCode });
  const paths = Object.keys(files).sort();
  const recent = recentFollowUpMessages()
    .filter((entry) => entry.role === 'user' && typeof entry.content === 'string' && entry.content.trim())
    .map((entry) => {
      const text = entry.content!.trim();
      return `- "${text.length > 100 ? `${text.slice(0, 100)}...` : text}"`;
    });

  return [
    paths.length ? `Current file structure:\n${paths.join('\n')}` : '',
    recent.length ? `Recent messages:\n${recent.join('\n')}` : '',
    message,
  ]
    .filter(Boolean)
    .join('\n\n');
}

export async function applyCreateProjectPlanFlow(input: {
  projectId: string;
  userId: string;
  initialPrompt: string;
  skipPlanning: boolean;
}) {
  if (input.skipPlanning) {
    await startInitialGeneration({
      projectId: input.projectId,
      userId: input.userId,
      promptContext: input.initialPrompt,
    });
    return { plan: null };
  }
  const plan = await generatePlan(input.projectId, input.initialPrompt, 'initial', input.initialPrompt);
  return { plan };
}

export async function generatePlan(
  projectId: string,
  promptContext: string,
  trigger: PlanTrigger,
  sourceMessage: string,
) {
  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { id: true, ownerId: true, initialPrompt: true, stack: true, designDirection: true },
  });
  if (!project) {
    throw new Error('Project not found');
  }
  const { beginJobHeartbeat, createOrReuseJob, failJob, markJobRunning, succeedJob } = await import('@/lib/jobs/lifecycle');
  const { WORKSPACE_ROW_ID } = await import('@/lib/storage/usage');
  const planJob = await createOrReuseJob({
    projectId,
    workspaceId: WORKSPACE_ROW_ID,
    userId: project.ownerId,
    kind: 'PLAN',
    inputPrompt: sourceMessage,
  });
  if (planJob.status === 'QUEUED') {
    await markJobRunning(planJob.id, { chargeCredits: false, acquireProjectLock: false });
  }
  const planHeartbeat = beginJobHeartbeat(planJob.id);
  // Anything that throws after this point still has to stop the interval and settle
  // the job, or the PLAN job stays RUNNING with a fresh heartbeat (so the stale
  // reaper never sees it) until the 20-minute hard timeout.
  let jobSettled = false;

  try {
    const directionId = resolveDirectionId(project.designDirection);
    let memoryBlock = '';
    try {
      memoryBlock = (await buildMemoryBlock(projectId)).block;
    } catch (error) {
      console.warn('[memory] plan block failed', error);
    }
    const stablePrefix = buildStablePromptPrefix(project.stack, directionId, { memoryBlock });
    const injected = await injectMatchedSkills(sourceMessage, promptContext);
    let systemPrompt = buildPlanSystemPrompt(promptContext, project.stack, directionId, { memoryBlock });
    if (injected.block) {
      systemPrompt = `${stablePrefix}\n\n${injected.block}\n\n${systemPrompt.replace(stablePrefix, '').trim()}`;
    }
    let content;
    try {
      const completed = await completePlan(promptContext, systemPrompt, stablePrefix);
      content = completed.content;
      if (completed.provider) {
        const { getJob, updateJobFields } = await import('@/lib/jobs/store');
        await updateJobFields(planJob.id, {
          provider: completed.provider,
          model: completed.model,
        });
        if (completed.attempts.length > 0) {
          const current = await getJob(planJob.id);
          await updateJobFields(planJob.id, {
            resourceIds: {
              ...(current?.resourceIds ?? {}),
              providerAttempts: completed.attempts,
            },
          });
        }
      }
    } catch (error) {
      jobSettled = true;
      const cause = error instanceof ProviderRunError ? error.causeError ?? error : error;
      const attempts = error instanceof ProviderRunError ? error.attempts : [];
      if (attempts.length > 0) {
        const { getJob, updateJobFields } = await import('@/lib/jobs/store');
        const current = await getJob(planJob.id);
        await updateJobFields(planJob.id, {
          resourceIds: {
            ...(current?.resourceIds ?? {}),
            providerAttempts: attempts,
          },
        });
      }
      await failJob(planJob.id, {
        errorCode: jobErrorCodeForProviderFailure(cause),
        errorMessage: providerFailureMessage(cause),
        provider: attempts.find((row) => !row.ok)?.provider ?? null,
        model: attempts.find((row) => !row.ok)?.model ?? null,
      });
      throw error;
    }
    const latest = await prisma.projectPlan.findFirst({
      where: { projectId },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    const version = latest ? latest.version + 1 : 1;

    const created = await prisma.$transaction(async (tx) => {
      await tx.projectPlan.updateMany({
        where: { projectId, status: 'PENDING' },
        data: { status: 'SUPERSEDED' },
      });
      return tx.projectPlan.create({
        data: {
          projectId,
          version,
          content,
          status: 'PENDING',
          trigger,
          sourceMessage,
        },
      });
    });

    await logGenerationEvent({
      projectId,
      userId: project.ownerId,
      kind: 'plan',
      isUrlClone: false,
      inputTokens: resolveInputTokens(null, `${systemPrompt}\n${promptContext}`),
    });
    await succeedJob(planJob.id);
    jobSettled = true;

    return created;
  } catch (error) {
    if (!jobSettled) {
      jobSettled = true;
      await failJob(planJob.id, {
        errorCode: 'plan_failed',
        errorMessage: error instanceof Error ? error.message : 'Plan failed',
      }).catch((failError) => {
        console.warn('[plan] could not mark the plan job failed', failError);
      });
    }
    throw error;
  } finally {
    planHeartbeat.stop();
  }
}

export async function getLatestPlan(projectId: string) {
  const { user, err } = await requireActor();
  if (!user) return err;

  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { id: true },
  });
  if (!project) return notFound();

  const plan = await prisma.projectPlan.findFirst({
    where: { projectId },
    orderBy: [{ createdAt: 'desc' }, { version: 'desc' }],
  });

  return { ok: true as const, data: plan };
}

export async function refinePlan(projectId: string, feedback: string) {
  const { user, err } = await requireActor();
  if (!user) return err;

  const parsed = parseWithZod(refinePlanSchema, { feedback });
  if (!parsed.ok) return parsed;

  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { id: true, ownerId: true, phase: true, initialPrompt: true },
  });
  if (!project) return notFound();
  if (!canMutate(user, project.ownerId)) return forbidden();
  if (project.phase !== 'PLANNING') {
    return { ok: false as const, error: 'Project is not in PLANNING phase', status: 409 };
  }

  const previous = await prisma.projectPlan.findFirst({
    where: { projectId },
    orderBy: [{ createdAt: 'desc' }, { version: 'desc' }],
  });

  const promptContext = previous
    ? `Previous plan:\n${JSON.stringify(previous.content)}\n\nUser feedback:\n${parsed.data.feedback}`
    : `${project.initialPrompt}\n\nUser feedback:\n${parsed.data.feedback}`;

  const trigger: PlanTrigger = previous?.trigger === 'followup' ? 'followup' : 'initial';
  const sourceMessage = previous?.sourceMessage ?? project.initialPrompt;
  const plan = await generatePlan(projectId, promptContext, trigger, sourceMessage);
  return { ok: true as const, data: plan };
}

export async function requestFollowUpPlan(projectId: string, message: string) {
  const { user, err } = await requireActor();
  if (!user) return err;

  const parsed = parseWithZod(followUpPlanSchema, { message });
  if (!parsed.ok) return parsed;

  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { id: true, ownerId: true, phase: true, lastCode: true },
  });
  if (!project) return notFound();
  if (!canMutate(user, project.ownerId)) return forbidden();
  if (project.phase === 'PLANNING') {
    return { ok: false as const, error: 'A plan is already pending', status: 409 };
  }
  if (project.phase === 'BUILDING') {
    return { ok: false as const, error: 'A build is already in progress', status: 409 };
  }
  if (project.phase !== 'COMPLETE') {
    return { ok: false as const, error: 'A plan is already pending', status: 409 };
  }

  await prisma.project.update({
    where: { id: projectId },
    data: { phase: 'PLANNING' },
  });

  const promptContext = buildFollowUpPromptContext(parsed.data.message, project.lastCode);
  try {
    const plan = await generatePlan(projectId, promptContext, 'followup', parsed.data.message);
    return { ok: true as const, data: plan };
  } catch (error) {
    // The phase was moved to PLANNING before the plan existed. Without this rollback
    // a failed plan leaves the project in PLANNING with nothing pending, and every
    // later follow-up is refused with "A plan is already pending".
    await prisma.project
      .update({ where: { id: projectId }, data: { phase: 'COMPLETE' } })
      .catch((rollbackError) => {
        console.warn('[plan] could not roll the project phase back to COMPLETE', rollbackError);
      });
    throw error;
  }
}

export async function approvePlan(
  projectId: string,
  input: { idempotencyKey?: string | null } = {},
): Promise<ActionResult<{
  plan: Awaited<ReturnType<typeof generatePlan>>;
  phase: 'BUILDING';
}>> {
  const { user, err } = await requireActor();
  if (!user) return err;

  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { id: true, ownerId: true, phase: true, initialPrompt: true },
  });
  if (!project) return notFound();
  if (!canMutate(user, project.ownerId)) return forbidden();
  if (project.phase !== 'PLANNING') {
    return { ok: false, error: 'Project is not in PLANNING phase', status: 409 };
  }

  const pending = await prisma.projectPlan.findFirst({
    where: { projectId, status: 'PENDING' },
    orderBy: { version: 'desc' },
  });
  if (!pending) {
    return { ok: false, error: 'No pending plan to approve', status: 409 };
  }

  const content = planContentSchema.parse(pending.content);
  const approved = await prisma.$transaction(async (tx) => {
    const plan = await tx.projectPlan.update({
      where: { id: pending.id },
      data: { status: 'APPROVED' },
    });
    await tx.project.update({
      where: { id: projectId },
      data: { phase: 'BUILDING' },
    });
    return plan;
  });

  const trigger: PlanTrigger = pending.trigger === 'followup' ? 'followup' : 'initial';
  const instruction = trigger === 'initial' ? project.initialPrompt : pending.sourceMessage;
  const promptContext = combineBuildContext(instruction, content);
  const { createOrReuseJob } = await import('@/lib/jobs/lifecycle');
  const { WORKSPACE_ROW_ID } = await import('@/lib/storage/usage');
  try {
    await createOrReuseJob({
      projectId,
      workspaceId: WORKSPACE_ROW_ID,
      userId: user.id,
      kind: trigger === 'followup' ? 'FOLLOWUP' : 'BUILD',
      inputPrompt: promptContext,
      planVersion: pending.version,
      idempotencyKey: input.idempotencyKey ?? null,
    });
  } catch (error) {
    // No job exists, so nothing will ever move this project out of BUILDING.
    // Put the plan and the phase back so approving again just works. The revert is
    // best effort: it must not mask the reason the job could not be created.
    await revertApprovedPlan({ projectId, planId: pending.id }).catch((revertError) => {
      console.error(
        '[plan] approve compensation failed — project may be stuck in BUILDING',
        { projectId, planId: pending.id },
        revertError,
      );
    });
    throw error;
  }
  if (trigger === 'initial') {
    await startInitialGeneration({ projectId, userId: user.id, promptContext });
  } else {
    await startFollowUpGeneration({ projectId, userId: user.id, promptContext });
  }

  // TODO: set phase COMPLETE when generation reports a clean completion
  // signal. persistProjectGeneration maps generationStatus "ready" → COMPLETE.

  return { ok: true, data: { plan: approved, phase: 'BUILDING' } };
}

/**
 * Retry a failed PLAN using the recorded prompt. Reuses generatePlan (first
 * plan) or requestFollowUpPlan (a live site). Does not start a build.
 */
export async function retryFailedPlan(projectId: string, prompt: string) {
  const { user, err } = await requireActor();
  if (!user) return err;

  const source = String(prompt || '').trim();
  if (!source) {
    return { ok: false as const, error: 'A prompt is required to retry the plan', status: 400 };
  }

  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { id: true, ownerId: true, phase: true },
  });
  if (!project) return notFound();
  if (!canMutate(user, project.ownerId)) return forbidden();

  const kind = planRetryKind(project.phase);
  if (kind === 'blocked') {
    return { ok: false as const, error: 'A build is already in progress', status: 409 };
  }
  if (kind === 'followup') {
    return requestFollowUpPlan(projectId, source);
  }

  const plan = await generatePlan(projectId, source, 'initial', source);
  return { ok: true as const, data: plan };
}

export async function getApprovedPlanGenerationContext(projectId: string) {
  const plan = await prisma.projectPlan.findFirst({
    where: { projectId, status: 'APPROVED' },
    orderBy: { version: 'desc' },
  });
  if (!plan) return '';
  const parsed = planContentSchema.safeParse(plan.content);
  if (!parsed.success) return '';
  return combineBuildContext('', parsed.data).trim();
}
