import { AsyncLocalStorage } from 'node:async_hooks';
import { generateObject, generateText } from 'ai';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { pageSectionNames } from '@/lib/stacks/section-imports';
import { getSessionUser, type SessionUser } from '@/lib/auth';
import { chatModelForEntry } from '@/lib/ai/client-for-entry';
import { completeWithProviderFailover } from '@/lib/ai/plan-complete';
import {
  jobErrorCodeForProviderFailure,
  providerFailureMessage,
  shouldFailover,
} from '@/lib/ai/failover';
import { ProviderRunError, type ProviderAttempt } from '@/lib/ai/run';
import { buildUiUxProMaxBrief } from '@/lib/ui-ux-pro-max/build-design-brief';
import { looksLikeUrl, nameFromPlanSummary } from '@/lib/projects/prompt';
import {
  parseWithZod,
  refinePlanSchema,
  followUpPlanSchema,
  updatePlanContentSchema,
} from '@/lib/projects/schema';
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
import { peekConversationState } from '@/lib/generation/conversation-state';
import { writeAudit } from '@/lib/audit/log';
import { logError } from '@/lib/logger';
import { recordJobStepFailure } from '@/lib/jobs/step-failure';

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
  /**
   * The design commitment, made before any code exists. Lovable's first-message
   * prompt - "write what it evokes and what existing beautiful designs you can
   * draw inspiration from... list possible colors, gradients, animations, fonts"
   * - is what this vendors: a build that has already said where its one bold
   * moment lives produces it, while a build deciding mid-file produces the
   * template default. Optional because stored plans predate it.
   */
  designVision?: string;
  /**
   * `route` is optional because plans written before multi-page planning existed
   * are still in the database and still have to open. A missing route means
   * "the build decides", which is the old behaviour; a present one is a contract
   * the build must satisfy and `lib/validation/quality-check.ts` enforces.
   */
  pages: { name: string; route?: string; description: string; sections?: string[] }[];
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
  abortSignal?: AbortSignal;
}) => Promise<PlanContent>;

const planContentSchema = z.object({
  summary: z.string().min(1),
  designVision: z.string().min(1).optional(),
  pages: z
    .array(
      z.object({
        name: z.string().min(1),
        route: z.string().min(1).optional(),
        description: z.string().min(1),
        /**
         * Catalogue sections this page is built from, in order.
         *
         * Deliberately `string`, not an enum over the registry. A plan that fails to parse
         * costs the user a whole planning round, and this field arrives from a model on a
         * schema older stored plans predate — the same reason `route` is optional. Unknown
         * names are dropped where the list is read, not rejected here.
         */
        sections: z.array(z.string().min(1)).max(12).optional(),
      }),
    )
    .min(1),
  keyFeatures: z.array(z.string().min(1)).min(1),
});

const actorStore = new AsyncLocalStorage<SessionUser>();

/**
 * The plan-completer seam, scoped to one async context.
 *
 * It used to be `let planCompleterOverride` behind an exported `setPlanCompleter`: a
 * mutable module global that replaced the AI call for **every** user of the process, set
 * by anything that imported this file and never automatically unset (F-813). An
 * `AsyncLocalStorage` makes the substitution last exactly as long as the callback, so a
 * test that forgets to clear it cannot leak into concurrent traffic.
 */
const planCompleterStore = new AsyncLocalStorage<PlanCompleter>();

export function runWithActor<T>(user: SessionUser, fn: () => T): T {
  return actorStore.run(user, fn);
}

export function peekActor(): SessionUser | undefined {
  return actorStore.getStore();
}

/** Test seam. Production never enters it, so production always uses the AI provider. */
export function runWithPlanCompleter<T>(completer: PlanCompleter, fn: () => T): T {
  return planCompleterStore.run(completer, fn);
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
  // `designDirection` was missing here while the generation route passed it. The
  // plan therefore scored its own style with no direction to break ties, and
  // promised a design the build then did not produce.
  const brief = buildUiUxProMaxBrief({
    prompt: promptContext,
    designDirection,
    isEdit: false,
  }).brief;
  const stackPrompt = getStackPrompt(
    stackId,
    designDirection,
    {
      conversationContext: '',
      uiUxBrief: brief,
      isEdit: false,
    },
    extras,
  );
  return `${stackPrompt}

${PLAN_TASK}`;
}

/**
 * What a plan has to decide before a build starts.
 *
 * The plan used to say "pages" and get one, every time: a dental clinic, a
 * store and an internal dashboard all came back as a single Home route with
 * ten sections stacked on it. Nothing in the instruction said a site could
 * have more than one page, so nothing produced one — while the preview has
 * mounted a client router over every \`app/**\\/page.tsx\` since long before
 * that. The capability was there; the plan never asked for it.
 *
 * Routes are named here rather than left to the build for the same reason the
 * design system is: two calls that each decide it separately will disagree, and
 * a nav that links to a page nobody wrote is the failure a user meets first.
 * \`lib/validation/quality-check.ts\` fails a build whose links do not resolve,
 * so the route list is a contract, not a suggestion.
 */
const PLAN_TASK = `You are planning a website. Output a structured plan only. Do NOT write application code, file contents, markup, or diffs.

HOW MANY PAGES
Decide from what the site is, not from a habit of building one long page.
- A single marketing page is right for a one-service local business, a personal portfolio, a launch or waitlist page, or an event.
- Three to six routes is right for most real businesses: a clinic with distinct treatments, a restaurant with a menu and bookings, an agency with case studies, a school, a property firm.
- A store needs at least: home, product listing, a product detail route, cart, and checkout.
- An admin or dashboard product needs at least: an overview, one list/table screen, one detail screen, and settings.
- Never invent routes to hit a number. A page earns its place by holding content that does not belong on another page.

ROUTES
- Every page gets a \`route\`: "/" for home, "/shop", "/product/[slug]" for a detail page reached from a list.
- Use lowercase, hyphenated segments. A dynamic segment is in square brackets.
- Every route you list will be built as a real page and linked from the shared header or footer. Do not list a route you cannot describe content for.

EACH PAGE
\`description\` names the sections that page holds, in order, and what each one contains — real subject matter drawn from the user's brief, never "a hero section" on its own. One or two sentences.
\`sections\` lists the catalogue sections that page uses, in the order they appear, from: ${pageSectionNames().join(', ')}. List only what the page genuinely has; omit the field for a page whose layout none of them expresses. This is a commitment the build is checked against, so do not pad it.

KEY FEATURES
Concrete, checkable capabilities: what a visitor can do and what the page proves. Not styling adjectives, and not a restatement of the section list.

DESIGN VISION
Commit to the design in 3-5 sentences, before the pages: what the subject evokes and one or two real-world designs worth drawing from; where the ONE bold moment lives (usually the hero) and what it concretely is; how the design brief's palette and type get spent (which section surfaces alternate or invert, where the gradient appears, what the display headline says); and the motion story (what fades up on load, what reveals on scroll). Be specific enough that two builders reading it would produce the same page. This spends the DESIGN DIRECTION and the token block - it never contradicts them.

Return JSON only, matching:
{
  "summary": string,
  "designVision": string,
  "pages": [{ "name": string, "route": string, "description": string, "sections": string[] }],
  "keyFeatures": string[]
}`;

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
  abortSignal?: AbortSignal;
}): Promise<{
  content: PlanContent;
  provider: string;
  model: string;
  attempts: ProviderAttempt[];
}> {
  const userPrompt = `Create a website plan (no code) for:\n\n${input.promptContext}`;
  // Planning selects and pays with the same keys as building: the effective-env
  // overlay (personal key -> org key -> process.env). Before this, the chain and
  // clients here saw process.env alone, so an admin-UI-only deployment could
  // build but never plan. The helper owns that resolution now and hands the
  // store it selected from back as `ctx.env` (F-083).
  const failover = await completeWithProviderFailover({
    userId: peekActor()?.id ?? null,
    signal: input.abortSignal,
    run: async (entry, ctx) => {
      const model = chatModelForEntry(entry, ctx.env, entry.model);
      const cached = input.stablePrefix
        ? buildCachedMessages({
            stablePrefix: input.stablePrefix,
            volatileUser: `${input.systemPrompt.replace(input.stablePrefix, '').trim()}\n\n${userPrompt}`,
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

async function completePlan(
  promptContext: string,
  systemPrompt: string,
  stablePrefix?: string,
  abortSignal?: AbortSignal,
) {
  const override = planCompleterStore.getStore();
  if (override) {
    const content = await override({ promptContext, systemPrompt, stablePrefix, abortSignal });
    return {
      content,
      provider: null as string | null,
      model: null as string | null,
      attempts: [] as ProviderAttempt[],
    };
  }
  return defaultCompletePlan({ promptContext, systemPrompt, stablePrefix, abortSignal });
}

export function combineBuildContext(initialPrompt: string, content: PlanContent) {
  // The route list and the vision are repeated outside the JSON, as instructions
  // rather than data: a plan whose pages are only a field of a serialised object
  // reads as context, while a build told "these are the routes, build every one"
  // produces them - and `lib/validation/quality-check.ts` fails a nav link that
  // resolves to none of them, so the list is a contract, not a suggestion.
  const routes = content.pages
    .map((page) => (page.route ? `${page.route} (${page.name})` : null))
    .filter((entry): entry is string => entry !== null);
  const routeContract =
    routes.length > 0
      ? `\n\nROUTES TO BUILD - every one of these is a real page file, and the shared header links to them:\n${routes
          .map((route) => `- ${route}`)
          .join(
            '\n',
          )}\nDo not merge them onto one page, and do not add a route that is not on this list.`
      : '';
  // The same reasoning, applied to the section commitment, and for the same reason: it is
  // now enforced at blocking severity by `missing-section`, which drives a billed repair
  // generation. Left inside the serialised plan it would reach the builder in exactly the
  // form the comment above says does not produce output, so the checker would be stricter
  // than any instruction the builder ever received — the pipeline billing a repair for a
  // contract it never handed over as one.
  const sectionLines = content.pages
    .map((page) => {
      const sections = page.sections?.filter((name) => typeof name === 'string' && name.trim());
      if (!sections?.length) return null;
      return `- ${page.route ?? page.name}: ${sections.join(', ')}`;
    })
    .filter((entry): entry is string => entry !== null);
  const sectionContract =
    sectionLines.length > 0
      ? `\n\nSECTIONS PER PAGE - build each page from these, in this order, by calling use_section for every one:\n${sectionLines.join('\n')}\nAdding a section beyond the list is fine; leaving one out is not.`
      : '';
  // The user approved this design; the build spends it, it does not re-decide it.
  const visionContract = content.designVision
    ? `\n\nAPPROVED DESIGN VISION - build exactly this:\n${content.designVision}`
    : '';
  return `${initialPrompt}\n\nApproved plan:\n${JSON.stringify(content)}${visionContract}${routeContract}${sectionContract}`;
}

async function startLoggedGeneration(input: GenerationStart) {
  // No module-level copy of `input` is kept. It used to be assigned to a
  // `lastGenerationStart` global read only by an unwired acceptance script, which held the
  // full user prompt plus the approved plan JSON in memory for the life of the process
  // (F-813). The durable, per-project record is the GenerationEvent row written below.
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

/** File tree + recent messages from the same sources the isEdit follow-up path uses. */
export function buildFollowUpPromptContext(
  projectId: string,
  message: string,
  lastCode: string | null | undefined,
) {
  const files = getCurrentProjectFiles({ lastCode });
  const paths = Object.keys(files).sort();
  // The project's own keyed conversation, never the old process-global — that slot was
  // overwritten by whichever project generated or mounted last, so a follow-up plan here
  // could embed another user's prompt text as "Recent messages:". The generate route may
  // push a non-string content when the prompt was one (F-005), hence the typeof guard.
  const recent = (peekConversationState(projectId)?.context.messages.slice(-20) ?? [])
    .filter((entry) => entry.role === 'user' && typeof entry.content === 'string')
    .flatMap((entry) => {
      const text = entry.content.trim();
      if (!text) return [];
      return [`- "${text.length > 100 ? `${text.slice(0, 100)}...` : text}"`];
    });

  return [
    paths.length ? `Current file structure:\n${paths.join('\n')}` : '',
    recent.length ? `Recent messages:\n${recent.join('\n')}` : '',
    message,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Names the project from the plan's subject, once the plan exists.
 *
 * A project's name is written at insert, which is before any plan has been generated, so it
 * could only ever come from the raw prompt — which is how a project was called
 * `Build a landing page for "Chai Point", a` and published on
 * `build-a-landing-page-for-chai-point-a.navroop.app`. The plan for that same run already knew
 * the business ("A warm, minimal landing page for Chai Point, a small tea cafe in Bangalore"),
 * so the provisional name is replaced the moment the plan lands.
 *
 * `provisionalName` is in the WHERE, so the rename is the same statement that asserts the name
 * is still the generated one — never a read-then-write. A user who renamed the project while
 * the plan was in flight (the deferred path leaves them sitting in the workspace for the whole
 * call) keeps their name, and a project created with an explicit name passes `null` here and
 * is never touched at all. Nothing in here may throw: `createProject` deletes the row when this
 * flow rejects, so a failed cosmetic rename would destroy a project that planned successfully.
 */
async function renameFromPlan(input: {
  projectId: string;
  provisionalName: string | null | undefined;
  content: unknown;
}): Promise<string | null> {
  if (!input.provisionalName) return null;
  const parsed = planContentSchema.safeParse(input.content);
  if (!parsed.success) return null;
  const proposed = nameFromPlanSummary(parsed.data.summary);
  if (!proposed || proposed === input.provisionalName) return null;
  try {
    const { count } = await prisma.project.updateMany({
      where: { id: input.projectId, deletedAt: null, name: input.provisionalName },
      data: { name: proposed },
    });
    return count > 0 ? proposed : null;
  } catch (error) {
    logError('plan.rename_from_plan_failed', error, { projectId: input.projectId });
    return null;
  }
}

export async function applyCreateProjectPlanFlow(input: {
  projectId: string;
  userId: string;
  initialPrompt: string;
  skipPlanning: boolean;
  /** The name `createProject` derived from the prompt, or `null` when the user chose one. */
  provisionalName?: string | null;
}) {
  if (input.skipPlanning) {
    await startInitialGeneration({
      projectId: input.projectId,
      userId: input.userId,
      promptContext: input.initialPrompt,
    });
    return { plan: null, name: null as string | null };
  }
  const plan = await generatePlan(
    input.projectId,
    input.initialPrompt,
    'initial',
    input.initialPrompt,
  );
  const name = await renameFromPlan({
    projectId: input.projectId,
    provisionalName: input.provisionalName,
    content: plan.content,
  });
  return { plan, name };
}

export async function generatePlan(
  projectId: string,
  promptContext: string,
  trigger: PlanTrigger,
  sourceMessage: string,
  signal?: AbortSignal,
) {
  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { id: true, ownerId: true, initialPrompt: true, stack: true, designDirection: true },
  });
  if (!project) {
    throw new Error('Project not found');
  }
  const { beginJobHeartbeat, createOrReuseJob, failJob, markJobRunning, succeedJob } =
    await import('@/lib/jobs/lifecycle');
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
  const planCancelled = new AbortController();
  if (signal?.aborted) {
    planCancelled.abort(signal.reason);
  } else {
    signal?.addEventListener('abort', () => planCancelled.abort(signal.reason), { once: true });
  }
  const planHeartbeat = beginJobHeartbeat(planJob.id, {
    signal: signal,
    onInactive: () => planCancelled.abort(new Error('The plan was cancelled')),
  });
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
      // Memory is documented as always-on and inside the cacheable prefix. When it
      // vanishes the plan is generated without the workspace's durable context *and* the
      // prefix bytes change, so the prompt cache misses too — neither of which is visible
      // from stdout. It reaches Sentry with the project id now (F-814).
      logError('plan.memory_block_failed', error, { projectId });
    }
    const stablePrefix = buildStablePromptPrefix(project.stack, directionId, { memoryBlock });
    const injected = await injectMatchedSkills(sourceMessage, promptContext, project.ownerId);
    let systemPrompt = buildPlanSystemPrompt(promptContext, project.stack, directionId, {
      memoryBlock,
    });
    if (injected.block) {
      systemPrompt = `${stablePrefix}\n\n${injected.block}\n\n${systemPrompt.replace(stablePrefix, '').trim()}`;
    }
    let content;
    try {
      const completed = await completePlan(
        promptContext,
        systemPrompt,
        stablePrefix,
        planCancelled.signal,
      );
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
      const cause = error instanceof ProviderRunError ? (error.causeError ?? error) : error;
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
    /**
     * The version is allocated inside the transaction that inserts it, serialized by a
     * transaction-scoped advisory lock keyed on the project — the shape `withLimit` uses
     * for the plan ceilings. `MAX(version)` used to be read outside, so two concurrent
     * generations for one project read the same number and both inserted it (F-810), and
     * the `PENDING → SUPERSEDED` sweep raced separately, leaving two pending plans. Both
     * statements are now under the one lock, so the newest plan is the only pending one
     * and `orderBy: { version: 'desc' }` — which `approvePlan`, `getLatestPlan` and
     * template creation all rely on — picks a single unambiguous row.
     *
     * A future `@@unique([projectId, version])` would still be worth adding: it would turn
     * any writer that bypasses this path into an error at the insert instead of a silently
     * ambiguous ordering, and would let the allocation retry on conflict rather than
     * serialize. It needs a migration, so the lock carries the invariant for now.
     */
    const created = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`plan-version:${projectId}`}))`;
      const latest = await tx.projectPlan.findFirst({
        where: { projectId },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      await tx.projectPlan.updateMany({
        where: { projectId, status: 'PENDING' },
        data: { status: 'SUPERSEDED' },
      });
      return tx.projectPlan.create({
        data: {
          projectId,
          version: latest ? latest.version + 1 : 1,
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
        // The PLAN job is now stuck RUNNING with no settle, and stdout was the only
        // record of why. `/admin/jobs` needs an operator looking at it (F-814).
        logError('plan.job_fail_write_failed', failError, { projectId, jobId: planJob.id });
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

export async function refinePlan(projectId: string, feedback: string, signal?: AbortSignal) {
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
  const plan = await generatePlan(projectId, promptContext, trigger, sourceMessage, signal);
  return { ok: true as const, data: plan };
}

/**
 * Writes the user's manual edits onto a PENDING plan row. Unlike `refinePlan` this does
 * not call the AI provider: the person edited the plan in place, so saving those edits is
 * a direct content write, not another billed re-plan. Owner/ADMIN only, PENDING only —
 * an APPROVED plan is already the build's input and must not change under it, and a
 * stale row is refused rather than silently overwritten.
 */
export async function updatePlanContent(
  projectId: string,
  input: { planId: string; content: PlanContent },
) {
  const { user, err } = await requireActor();
  if (!user) return err;

  const parsed = parseWithZod(updatePlanContentSchema, input);
  if (!parsed.ok) return parsed;

  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { id: true, ownerId: true },
  });
  if (!project) return notFound();
  if (!canMutate(user, project.ownerId)) return forbidden();

  const plan = await prisma.projectPlan.findFirst({
    where: { id: parsed.data.planId, projectId, status: 'PENDING' },
    select: { id: true },
  });
  if (!plan) {
    return { ok: false as const, error: 'This plan is no longer pending', status: 409 };
  }

  await prisma.projectPlan.update({
    where: { id: plan.id },
    data: { content: parsed.data.content },
  });

  await writeAudit({
    actorId: user.id,
    actorEmail: user.email,
    action: 'project.plan_edit',
    targetType: 'project',
    targetId: projectId,
    after: { planId: plan.id },
  });

  const updated = await prisma.projectPlan.findUnique({ where: { id: plan.id } });
  return { ok: true as const, data: updated };
}

export async function requestFollowUpPlan(
  projectId: string,
  message: string,
  signal?: AbortSignal,
) {
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

  const promptContext = buildFollowUpPromptContext(
    projectId,
    parsed.data.message,
    project.lastCode,
  );
  try {
    const plan = await generatePlan(
      projectId,
      promptContext,
      'followup',
      parsed.data.message,
      signal,
    );
    return { ok: true as const, data: plan };
  } catch (error) {
    // The phase was moved to PLANNING before the plan existed. Without this rollback
    // a failed plan leaves the project in PLANNING with nothing pending, and every
    // later follow-up is refused with "A plan is already pending".
    await prisma.project
      .update({ where: { id: projectId }, data: { phase: 'COMPLETE' } })
      .catch((rollbackError) => {
        // The rollback is the only thing standing between the user and a project that
        // refuses every later follow-up with "A plan is already pending", so its failure
        // is an operator-visible event, not a stdout line (F-814).
        logError('plan.phase_rollback_failed', rollbackError, { projectId });
      });
    throw error;
  }
}

/**
 * Rolls the `approvePlan` claim back from inside its transaction. Not an error the caller
 * ever sees: it is converted to the 409 the route answers with.
 */
class NoPendingPlanError extends Error {}

export async function approvePlan(
  projectId: string,
  input: { idempotencyKey?: string | null } = {},
): Promise<
  ActionResult<{
    plan: Awaited<ReturnType<typeof generatePlan>>;
    phase: 'BUILDING';
  }>
> {
  const { user, err } = await requireActor();
  if (!user) return err;

  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { id: true, ownerId: true, initialPrompt: true },
  });
  if (!project) return notFound();
  if (!canMutate(user, project.ownerId)) return forbidden();

  /**
   * The phase transition is the mutex.
   *
   * The phase used to be read, asserted `PLANNING`, and only then written — nothing linked
   * the check to the write, so two concurrent approvals both passed the check, both
   * committed, and both started a generation off one plan (F-811). The only defence was
   * `idempotencyKey`, which is optional and comes from the request body, so any non-browser
   * client got two builds and two charges. `PLANNING` is now consumed by the same statement
   * that asserts it: the win is the returned row count, never a re-read, exactly as
   * `claimJobRun` states for the job layer.
   *
   * Everything the approval consists of is inside that claim's transaction, so a plan that
   * has gone (or does not parse) rolls the phase back rather than stranding the project in
   * BUILDING with nothing to build.
   */
  const claimed = await prisma
    .$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        UPDATE "Project"
        SET phase = 'BUILDING'::"ProjectPhase", "updatedAt" = NOW()
        WHERE id = ${projectId} AND "deletedAt" IS NULL AND phase = 'PLANNING'
        RETURNING id
      `;
      if (rows.length === 0) return null;

      const pending = await tx.projectPlan.findFirst({
        where: { projectId, status: 'PENDING' },
        orderBy: { version: 'desc' },
      });
      if (!pending) throw new NoPendingPlanError();
      const content = planContentSchema.parse(pending.content);
      const plan = await tx.projectPlan.update({
        where: { id: pending.id },
        data: { status: 'APPROVED' },
      });
      return { plan, pending, content };
    })
    .catch((error) => {
      if (error instanceof NoPendingPlanError) return 'no-plan' as const;
      throw error;
    });

  if (claimed === null) {
    return { ok: false, error: 'Project is not in PLANNING phase', status: 409 };
  }
  if (claimed === 'no-plan') {
    return { ok: false, error: 'No pending plan to approve', status: 409 };
  }
  const { plan: approved, pending, content } = claimed;

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
    await revertApprovedPlan({ projectId, planId: pending.id }).catch(async (revertError) => {
      // By its own comment this leaves the project stuck in BUILDING, and stdout was the
      // only place that said so (F-814). Sentry gets the exception; the project's PLAN job
      // gets a failed step, which is the row an operator reads in /admin/jobs.
      logError('plan.approve_compensation_failed', revertError, {
        projectId,
        planId: pending.id,
      });
      const planJob = await prisma.job
        .findFirst({
          where: { projectId, kind: 'PLAN' },
          orderBy: { createdAt: 'desc' },
          select: { id: true },
        })
        .catch(() => null);
      await recordJobStepFailure(planJob?.id, {
        key: 'approve-compensation',
        label: 'Roll back the approved plan',
        error:
          'The project is stuck in BUILDING: the plan was approved, no build job was created, and the rollback failed',
      });
    });
    throw error;
  }
  if (trigger === 'initial') {
    await startInitialGeneration({ projectId, userId: user.id, promptContext });
  } else {
    await startFollowUpGeneration({ projectId, userId: user.id, promptContext });
  }

  // COMPLETE is set by settleStreamedGeneration when the BUILD job finishes
  // with files — not here, where no code has been generated yet (F-665).

  return { ok: true, data: { plan: approved, phase: 'BUILDING' } };
}

/**
 * Retry a failed PLAN using the recorded prompt. Reuses generatePlan (first
 * plan) or requestFollowUpPlan (a live site). Does not start a build.
 */
export async function retryFailedPlan(projectId: string, prompt: string, signal?: AbortSignal) {
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
    return requestFollowUpPlan(projectId, source, signal);
  }

  const plan = await generatePlan(projectId, source, 'initial', source, signal);
  return { ok: true as const, data: plan };
}

/**
 * The routes the approved plan promised, for the validator to check against.
 *
 * `combineBuildContext` writes these into the build prompt under "ROUTES TO
 * BUILD" and its comment calls the list "a contract, not a suggestion" — but
 * nothing read the plan back afterwards, so the contract was prose. The
 * validator's `missing-route` only sees a *link* to a page that does not exist;
 * a promised page the model never wrote and never linked to is invisible to it.
 *
 * Never throws and never returns a partial answer as a whole one: an empty
 * array means "no contract to check", which is also what a missing plan, an
 * unparseable one, and a failed read all mean. Failing a generation because a
 * lookup for extra assurance failed would be strictly worse than not checking.
 */
export type ApprovedPlanContract = {
  routes: string[];
  pages: Array<{ route?: string; sections?: string[] }>;
};

export async function getApprovedPlanContract(projectId: string): Promise<ApprovedPlanContract> {
  const empty: ApprovedPlanContract = { routes: [], pages: [] };
  try {
    const plan = await prisma.projectPlan.findFirst({
      where: { projectId, status: 'APPROVED' },
      orderBy: { version: 'desc' },
      select: { content: true },
    });
    if (!plan) return empty;
    const parsed = planContentSchema.safeParse(plan.content);
    if (!parsed.success) return empty;
    return {
      routes: parsed.data.pages
        .map((page) => page.route?.trim())
        .filter((route): route is string => Boolean(route)),
      pages: parsed.data.pages.map((page) => ({ route: page.route, sections: page.sections })),
    };
  } catch {
    return empty;
  }
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
