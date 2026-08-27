import { z } from 'zod';
import { log } from '@/lib/logger';
import { prisma } from '@/lib/db';
import { accrueSpend } from '@/lib/plans/spend';
import { stampActivePromptHash } from '@/lib/prompts/version';
import { maybeSettleFollowups } from '@/lib/signals/collect';
import { WORKSPACE_ROW_ID } from '@/lib/storage/usage';
import { calculateEventCost, estimateTokenCost } from './consumption/cost';
import { loadOperatorTokenRate, reportRateSource } from './consumption/rates';
import type { GenerationEventKind } from './usage-estimates';

export {
  AI_GENERATION_ESTIMATE,
  FIRECRAWL_SCRAPE_ESTIMATE,
  IMAGE_GENERATION_ESTIMATE,
  PLAN_GENERATION_ESTIMATE,
  type GenerationEventKind,
} from './usage-estimates';
export { calculateEventCost } from './consumption/cost';

/**
 * ONE WRITER MOVES THE SPEND CEILING PER PROVIDER CALL.
 *
 * `Workspace.spendUsd` is what the documented 100 %-of-limit auto-pause
 * (`pauseReason=SPEND_LIMIT`) reads, so a call counted twice pauses a workspace that never
 * reached its limit and a call counted zero times lets one run past it. `recordJobUsage`
 * (lib/consumption/record.ts) is the writer whenever the call belongs to a Job row — it
 * prices the tokens and accrues them — and a build writes BOTH a job row and a
 * GenerationEvent. That is why accrual is not unconditional inside `logGenerationEvent`: it
 * is opt-in through `accrueToSpendCeiling`, and a caller may opt in only when its event row
 * is the sole record of the call.
 *
 * One caller passes it today: the URL-import section writer (lib/import/generate-sections.ts),
 * because nothing runs `recordJobUsage` for an IMPORT job. Two more are in exactly that
 * position and still do not, so their spend reaches /admin/usage and never reaches the
 * ceiling — `lib/projects/plan.ts`'s `kind: 'plan'` row and `lib/assets/generate-image.ts`'s
 * `kind: 'image'` row are each the only record their provider call has. They are named here
 * rather than left implied, because reading one worked example as the finished list is how
 * they went unnoticed while the three helper calls below were being closed. The other
 * `logGenerationEvent` in plan.ts — `startLoggedGeneration`, `initial`/`followup` — is the
 * opposite case and must keep its hands off: it announces a build that then records itself
 * through `recordJobUsage`, so accruing there would move the ceiling twice for one call.
 *
 * The provider calls that hold no Job row at all — memory extraction after every
 * generation, skill matching per message and per plan, URL-import segmentation — record
 * through {@link recordHelperCallUsage}, which is the same accrual plus an event row
 * whenever the call can be attributed to a project and a user. Those three wrote nothing
 * anywhere until now: a workspace doing 200 chat turns a day put several hundred extra
 * completions on the operator's invoice while `spendUsd` sat still, /admin/usage showed
 * none of it, and the auto-pause could not fire on any of it.
 */
export type LogGenerationEventInput = {
  projectId: string;
  userId: string;
  kind: GenerationEventKind;
  isUrlClone: boolean;
  inputTokens?: number | null;
  outputTokens?: number | null;
  provider?: string | null;
  model?: string | null;
  /**
   * Add this event's own `estimatedCost` to `Workspace.spendUsd`.
   *
   * Set it only when nothing else accounts for the same tokens. A caller that also runs
   * `recordJobUsage` must leave it off — the ceiling would then move twice for one call.
   */
  accrueToSpendCeiling?: boolean;
};

/**
 * A provider call the product makes on its own behalf, outside any Job row.
 *
 * The value is written to `GenerationEvent.kind` (a free-text column), so these read as
 * themselves on /admin/usage — `memory_extract · $0.0003 · 14:22` — rather than being
 * disguised as a build. They are deliberately NOT `GenerationEventKind`: the signal
 * collectors key off `BUILD_KINDS` (`initial` / `followup`) and the generate route pins its
 * pending event with the same two, so a helper row cannot become the generation a quality
 * signal or a token attribution is filed against.
 */
export const HELPER_CALL_KINDS = ['memory_extract', 'skill_match', 'import_segment'] as const;
export type HelperCallKind = (typeof HELPER_CALL_KINDS)[number];

/**
 * The kinds that mean "a generation happened".
 *
 * `satisfies` keeps it in step with `GenerationEventKind` rather than duplicating it. It is
 * what separates the two numbers on /admin/usage: cost sums every row, because every row is
 * money, while the Generations tile and the per-member Generations column count only these.
 * One chat turn is one generation and up to three charges — a tile reading 600 for 200 turns
 * would be a new wrong number bought with a fix for an old one.
 */
const GENERATION_KINDS = [
  'initial',
  'followup',
  'plan',
  'image',
] as const satisfies readonly GenerationEventKind[];

function isGenerationKind(kind: string): boolean {
  return (GENERATION_KINDS as readonly string[]).includes(kind);
}

/**
 * Move the ceiling, and say so out loud when it cannot be moved.
 *
 * Non-throwing on purpose: accounting must never be the reason a generation, an import or a
 * post-generation hook fails. Silence is not an option either — a missed accrual means the
 * workspace keeps spending past a limit an operator set, which is the failure this whole
 * seam exists to close.
 */
async function accrueRecordedSpend(
  usd: number,
  context: { kind: string; projectId?: string | null },
): Promise<void> {
  if (!(usd > 0)) return;
  await accrueSpend(WORKSPACE_ROW_ID, usd).catch((error) => {
    log.error('usage.spend_accrual_failed', {
      ...context,
      usd,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

const isoDateSchema = z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
  message: 'Must be an ISO date',
});

export const usageRangeQuerySchema = z.object({
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
});

export function decimalToNumber(value: { toString(): string } | number | null | undefined) {
  if (value == null) return 0;
  const n = typeof value === 'number' ? value : Number(value.toString());
  return Math.round(n * 10000) / 10000;
}

/**
 * Logging failure must never block generation.
 *
 * Returns the created event's id, or `null` when the write failed. The id is the only
 * safe handle on this row: `attachGenerationInputTokens` used to look up "the newest
 * event for the project" instead, which mis-attributes the count the moment two
 * generations in one project overlap (F-749).
 */
export async function logGenerationEvent(input: LogGenerationEventInput): Promise<string | null> {
  /** Held outside the try so a failed row can still move the ceiling — see the `finally`. */
  let estimatedCost: number | null = null;
  try {
    await maybeSettleFollowups(input.projectId);
    const promptVersion = await stampActivePromptHash();
    // Priced at the same rate `recordJobUsage` used for the job row: two
    // different numbers for one generation is how /admin/usage and /admin/jobs
    // came to disagree.
    const rate = await loadOperatorTokenRate();
    estimatedCost = calculateEventCost(input.kind, input.isUrlClone, {
      tokensIn: input.inputTokens,
      tokensOut: input.outputTokens,
      provider: input.provider,
      model: input.model,
      rate,
    });
    const created = await prisma.generationEvent.create({
      data: {
        projectId: input.projectId,
        userId: input.userId,
        kind: input.kind,
        estimatedCost,
        promptVersion,
        ...(input.inputTokens != null ? { inputTokens: input.inputTokens } : {}),
      },
      select: { id: true },
    });
    return created.id;
  } catch (error) {
    console.error('[usage] Failed to log generation event', error);
    return null;
  } finally {
    // The ceiling moves on the number written to the row, so /admin/usage and
    // `Workspace.spendUsd` cannot describe one call with two figures — and it moves even
    // when the create threw, because the tokens were spent either way and a failed
    // analytics write must not also be a hole in the spend limit.
    if (input.accrueToSpendCeiling && estimatedCost !== null) {
      await accrueRecordedSpend(estimatedCost, {
        kind: input.kind,
        projectId: input.projectId,
      });
    }
  }
}

export type HelperCallUsageInput = {
  kind: HelperCallKind;
  /** Absent while the call site cannot name one — the spend is still accrued. */
  projectId?: string | null;
  userId?: string | null;
  tokensIn: number;
  tokensOut: number;
  /** Provider calls covered, settled or charged from the prompt. 0 records nothing. */
  calls: number;
  estimatedCalls?: number;
  provider?: string | null;
  model?: string | null;
};

/**
 * Record a provider call that holds no Job row.
 *
 * Priced through `estimateTokenCost` — the same function and the same operator rate
 * `recordJobUsage` uses — then accrued, then written as a `GenerationEvent` when the call
 * knows which project and user it was made for. The order matters: the accrual is the half
 * that keeps the auto-pause honest, so it does not wait on an analytics row that may fail.
 *
 * `calls: 0` is the "nothing was sent" case (no provider configured, the chain refused
 * before the request went out) and records nothing at all. Every other outcome — including
 * a call the provider accepted and then failed, which billed for the prompt — is charged;
 * `RunUsage` is what call sites use to get those numbers right.
 *
 * Non-throwing: a caller must never lose its own work because the accounting failed.
 */
export async function recordHelperCallUsage(
  input: HelperCallUsageInput,
): Promise<{ usd: number; eventId: string | null }> {
  if (!(input.calls > 0)) return { usd: 0, eventId: null };
  try {
    const rate = await loadOperatorTokenRate();
    const { usd, source } = estimateTokenCost({
      tokensIn: input.tokensIn,
      tokensOut: input.tokensOut,
      provider: input.provider,
      model: input.model,
      rate,
    });
    reportRateSource(source, { provider: input.provider, model: input.model });
    // Asked BEFORE the write rather than inferred from its result. A null `eventId` has
    // two causes — nobody to attribute the call to, and a create that threw — and reading
    // them as one made a failed insert log `usage.helper_call_unattributed` on top of
    // `usage.helper_event_not_written`, a line whose whole claim ("this call site does not
    // know its project or its user") was false about the call that emitted it.
    const attributable = Boolean(input.projectId && input.userId);
    const eventId = attributable ? await writeHelperCallEvent(input, usd) : null;
    await accrueRecordedSpend(usd, { kind: input.kind, projectId: input.projectId });
    if (!attributable) {
      // The ceiling moved but no row on /admin/usage can explain it, because this call
      // site does not know its project or its user. `amount*` rather than `tokens*`: the
      // log scrubber redacts any field whose name contains `token`, so the counts would
      // print as `[Filtered]` and the line would carry nothing.
      log.info('usage.helper_call_unattributed', {
        kind: input.kind,
        usd,
        amountIn: input.tokensIn,
        amountOut: input.tokensOut,
        calls: input.calls,
        estimatedCalls: input.estimatedCalls ?? 0,
      });
    }
    return { usd, eventId };
  } catch (error) {
    log.error('usage.helper_call_not_recorded', {
      kind: input.kind,
      projectId: input.projectId ?? null,
      calls: input.calls,
      error: error instanceof Error ? error.message : String(error),
    });
    return { usd: 0, eventId: null };
  }
}

/**
 * The `GenerationEvent` row for a helper call, or null when the write failed. The caller
 * decides whether there is anyone to attribute the call to and does not call this otherwise;
 * the guard below is a second line of defence, since both columns are required and a create
 * missing either one throws at the database.
 *
 * No `promptVersion` and no `maybeSettleFollowups`: this row is not a generation of any
 * prompt version, and settling follow-up quality signals off a memory extraction would file
 * the build's signals against the wrong subject.
 */
async function writeHelperCallEvent(
  input: HelperCallUsageInput,
  usd: number,
): Promise<string | null> {
  if (!input.projectId || !input.userId) return null;
  try {
    const created = await prisma.generationEvent.create({
      data: {
        projectId: input.projectId,
        userId: input.userId,
        kind: input.kind,
        estimatedCost: usd,
        ...(input.tokensIn > 0 ? { inputTokens: input.tokensIn } : {}),
      },
      select: { id: true },
    });
    return created.id;
  } catch (error) {
    log.error('usage.helper_event_not_written', {
      kind: input.kind,
      projectId: input.projectId,
      usd,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export function defaultUsageRange(now = new Date()) {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { from, to };
}

function parseBound(value: string, edge: 'start' | 'end') {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split('-').map(Number);
    return edge === 'start'
      ? new Date(Date.UTC(year, month - 1, day))
      : new Date(Date.UTC(year, month - 1, day + 1));
  }
  return new Date(value);
}

/**
 * Attach measured input tokens to the event the run created.
 *
 * `updateMany` rather than `update`: the `inputTokens: null` guard makes the write
 * idempotent — `logGenerationEvent` already priced the event when the caller knew the
 * count up front, and overwriting that would leave `estimatedCost` and `inputTokens`
 * describing different generations — and the row count is how a miss becomes visible.
 * The old shape returned silently on both a missing row and an already-counted one.
 */
export async function attachGenerationInputTokens(
  eventId: string | null | undefined,
  inputTokens: number,
) {
  if (!eventId) {
    // `amount`, not `inputTokens`/`tokensIn`: the log scrubber redacts any field whose
    // name contains `token`, so both of those log as `[Filtered]` and the line carries
    // no count at all.
    log.warn('usage.input_tokens_unattributed', { amount: inputTokens });
    return;
  }
  try {
    const { count } = await prisma.generationEvent.updateMany({
      where: { id: eventId, inputTokens: null },
      data: { inputTokens },
    });
    if (count === 0) {
      // Either the event already carries a count (the caller passed one to
      // `logGenerationEvent`) or the row is gone. Both are benign; neither was reported.
      log.info('usage.input_tokens_not_applied', { eventId, amount: inputTokens });
    }
  } catch (error) {
    console.error('[usage] Failed to attach input tokens', error);
  }
}

export function parseUsageRange(searchParams: URLSearchParams) {
  const parsed = usageRangeQuerySchema.safeParse({
    from: searchParams.get('from') ?? undefined,
    to: searchParams.get('to') ?? undefined,
  });
  if (!parsed.success) {
    return {
      ok: false as const,
      error: 'Validation failed' as const,
      status: 400 as const,
      details: parsed.error.issues,
    };
  }

  const defaults = defaultUsageRange();
  const from = parsed.data.from ? parseBound(parsed.data.from, 'start') : defaults.from;
  const to = parsed.data.to ? parseBound(parsed.data.to, 'end') : defaults.to;
  if (!(from < to)) {
    return {
      ok: false as const,
      error: 'Validation failed' as const,
      status: 400 as const,
      details: [{ message: '`from` must be before `to`' }],
    };
  }
  return { ok: true as const, data: { from, to } };
}

function createdAtInRange(from: Date, to: Date) {
  return { createdAt: { gte: from, lt: to } };
}

export async function getUsageSummary(from: Date, to: Date) {
  const where = createdAtInRange(from, to);
  const [totalGenerations, costAgg, projectGroups] = await Promise.all([
    // Cost and projects sum every row; the Generations tile counts generations only. See
    // GENERATION_KINDS — a helper call is a charge, not a generation.
    prisma.generationEvent.count({ where: { ...where, kind: { in: [...GENERATION_KINDS] } } }),
    prisma.generationEvent.aggregate({ where, _sum: { estimatedCost: true } }),
    prisma.generationEvent.groupBy({ by: ['projectId'], where }),
  ]);

  return {
    totalProjects: projectGroups.length,
    totalGenerations,
    totalEstimatedCost: decimalToNumber(costAgg._sum.estimatedCost),
  };
}

export async function getUsageByMember(from: Date, to: Date) {
  const where = createdAtInRange(from, to);
  const [grouped, projectPairs] = await Promise.all([
    // Grouped by kind as well as member, so one query answers both columns: every kind is
    // summed into the cost, only GENERATION_KINDS are counted as generations. A second
    // filtered groupBy would be a second round trip for the same rows.
    prisma.generationEvent.groupBy({
      by: ['userId', 'kind'],
      where,
      _count: { _all: true },
      _sum: { estimatedCost: true },
    }),
    prisma.generationEvent.groupBy({
      by: ['userId', 'projectId'],
      where,
    }),
  ]);

  const totalsByUser = new Map<string, { generationCount: number; estimatedCost: number }>();
  for (const row of grouped) {
    const totals = totalsByUser.get(row.userId) ?? { generationCount: 0, estimatedCost: 0 };
    if (isGenerationKind(row.kind)) totals.generationCount += row._count._all;
    // Accumulated raw and rounded once at the end: rounding each kind first and adding the
    // roundings is a different number from the one the summary tile shows.
    totals.estimatedCost += Number(row._sum.estimatedCost?.toString() ?? 0);
    totalsByUser.set(row.userId, totals);
  }

  const projectIdsByUser = new Map<string, string[]>();
  for (const row of projectPairs) {
    const list = projectIdsByUser.get(row.userId) ?? [];
    list.push(row.projectId);
    projectIdsByUser.set(row.userId, list);
  }

  const allProjectIds = [...new Set(projectPairs.map((row) => row.projectId))];
  const memberIds = [...totalsByUser.keys()];
  const [users, projects] = await Promise.all([
    memberIds.length
      ? prisma.user.findMany({
          where: { id: { in: memberIds } },
          select: { id: true, name: true, email: true },
        })
      : Promise.resolve([]),
    allProjectIds.length
      ? prisma.project.findMany({
          where: { id: { in: allProjectIds } },
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
  ]);
  const userById = new Map(users.map((user) => [user.id, user]));
  const projectById = new Map(projects.map((project) => [project.id, project]));

  return [...totalsByUser.entries()]
    .map(([userId, totals]) => {
      const user = userById.get(userId);
      const projectIds = projectIdsByUser.get(userId) ?? [];
      return {
        userId,
        name: user?.name ?? '',
        email: user?.email ?? '',
        projectCount: projectIds.length,
        generationCount: totals.generationCount,
        estimatedCost: decimalToNumber(totals.estimatedCost),
        projects: projectIds.map((id) => ({
          id,
          name: projectById.get(id)?.name || 'Untitled',
        })),
      };
    })
    .sort((a, b) => b.estimatedCost - a.estimatedCost || a.email.localeCompare(b.email));
}

export async function getProjectUsageEvents(projectId: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true },
  });
  if (!project) return null;

  const events = await prisma.generationEvent.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    select: {
      kind: true,
      estimatedCost: true,
      createdAt: true,
      user: { select: { name: true } },
    },
  });

  return events.map((event) => ({
    kind: event.kind,
    cost: decimalToNumber(event.estimatedCost),
    createdAt: event.createdAt,
    userName: event.user.name,
  }));
}
