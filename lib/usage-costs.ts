import { z } from 'zod';
import { log } from '@/lib/logger';
import { prisma } from '@/lib/db';
import { stampActivePromptHash } from '@/lib/prompts/version';
import { maybeSettleFollowups } from '@/lib/signals/collect';
import { calculateEventCost } from './consumption/cost';
import { loadOperatorTokenRate } from './consumption/rates';
import type { GenerationEventKind } from './usage-estimates';

export {
  AI_GENERATION_ESTIMATE,
  FIRECRAWL_SCRAPE_ESTIMATE,
  IMAGE_GENERATION_ESTIMATE,
  PLAN_GENERATION_ESTIMATE,
  type GenerationEventKind,
} from './usage-estimates';
export { calculateEventCost } from './consumption/cost';

export type LogGenerationEventInput = {
  projectId: string;
  userId: string;
  kind: GenerationEventKind;
  isUrlClone: boolean;
  inputTokens?: number | null;
  outputTokens?: number | null;
  provider?: string | null;
  model?: string | null;
};

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
  try {
    await maybeSettleFollowups(input.projectId);
    const promptVersion = await stampActivePromptHash();
    // Priced at the same rate `recordJobUsage` used for the job row: two
    // different numbers for one generation is how /admin/usage and /admin/jobs
    // came to disagree.
    const rate = await loadOperatorTokenRate();
    const created = await prisma.generationEvent.create({
      data: {
        projectId: input.projectId,
        userId: input.userId,
        kind: input.kind,
        estimatedCost: calculateEventCost(input.kind, input.isUrlClone, {
          tokensIn: input.inputTokens,
          tokensOut: input.outputTokens,
          provider: input.provider,
          model: input.model,
          rate,
        }),
        promptVersion,
        ...(input.inputTokens != null ? { inputTokens: input.inputTokens } : {}),
      },
      select: { id: true },
    });
    return created.id;
  } catch (error) {
    console.error('[usage] Failed to log generation event', error);
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
    prisma.generationEvent.count({ where }),
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
    prisma.generationEvent.groupBy({
      by: ['userId'],
      where,
      _count: { _all: true },
      _sum: { estimatedCost: true },
    }),
    prisma.generationEvent.groupBy({
      by: ['userId', 'projectId'],
      where,
    }),
  ]);

  const projectIdsByUser = new Map<string, string[]>();
  for (const row of projectPairs) {
    const list = projectIdsByUser.get(row.userId) ?? [];
    list.push(row.projectId);
    projectIdsByUser.set(row.userId, list);
  }

  const allProjectIds = [...new Set(projectPairs.map((row) => row.projectId))];
  const [users, projects] = await Promise.all([
    grouped.length
      ? prisma.user.findMany({
          where: { id: { in: grouped.map((row) => row.userId) } },
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

  return grouped
    .map((row) => {
      const user = userById.get(row.userId);
      const projectIds = projectIdsByUser.get(row.userId) ?? [];
      return {
        userId: row.userId,
        name: user?.name ?? '',
        email: user?.email ?? '',
        projectCount: projectIds.length,
        generationCount: row._count._all,
        estimatedCost: decimalToNumber(row._sum.estimatedCost),
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
