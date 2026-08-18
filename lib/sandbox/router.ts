/**
 * Provider selection.
 *
 * Multiple configs are for genuinely different providers or legitimately
 * separate accounts (dev vs prod). Creating several free accounts with one
 * provider to extend a free allowance breaks that provider's terms and risks
 * all being closed at once.
 */

import { DEFAULT_IDLE_MINUTES } from './minutes';
import {
  DRIVER_CAPABILITIES,
  DRIVER_COST_MODELS,
  NoProviderAvailableError,
  type CreditType,
  type RoutingStrategy,
  type SandboxDriverId,
} from './provider';
import { budgetExhausted, estimateRunCostUsd, hasUsableCredit, remainingCreditUsd } from './credits';
import { resolveStickyProvider } from './sticky';
import { getRoutingStrategy, listProviderConfigs, type StoredProviderConfig } from './store';
import { prisma } from '@/lib/db';

export type ProviderCandidate = {
  id: string;
  name: string;
  driver: SandboxDriverId;
  isActive: boolean;
  priority: number;
  weight: number;
  creditType: CreditType;
  creditRemainingUsd: number | null;
  creditTotalUsd: number | null;
  monthlyBudgetUsd: number | null;
  monthlyMinutesLimit: number | null;
  minutesUsed: number;
  spendUsd: number;
  healthStatus: string;
  lastCheckedAt: Date | null;
  consecutiveFails: number;
  downUntil: Date | null;
  periodStart: Date;
  creditResetsAt: Date | null;
  config: {
    cpu?: number;
    memoryGiB?: number;
    region?: string;
    timeoutMs?: number;
  };
  /** English reason for this pick — set by rankAndSelect, never persisted on the row. */
  selectionReason?: string;
  /**
   * Eligible rows that beat the pick on cost/credit/priority but lost on health.
   * Empty on sticky. Not every considered row — only the "obvious skip" cases.
   */
  outrankedEligible?: Array<{ configId: string; name: string; reason: string }>;
};

export type RankInput = {
  candidates: ProviderCandidate[];
  strategy: RoutingStrategy;
  requireLivePreview?: boolean;
  stickyConfigId?: string | null;
  now?: Date;
  estimateSeconds?: number;
  roundRobinCursor?: number;
  costModelFor?: (driver: SandboxDriverId) => { cpuPerSecUsd: number; memPerGibSecUsd: number };
};

const TIER: Record<CreditType, number> = {
  recurring_monthly: 1,
  one_time: 2,
  paid: 3,
};

function isDown(row: ProviderCandidate, now: Date) {
  if (row.healthStatus === 'down' && row.downUntil && row.downUntil.getTime() > now.getTime()) {
    return true;
  }
  if (row.healthStatus === 'down' && !row.downUntil && row.lastCheckedAt) {
    return row.lastCheckedAt.getTime() + 10 * 60_000 > now.getTime();
  }
  return row.healthStatus === 'down' && !row.lastCheckedAt;
}

export function exclusionReason(
  row: ProviderCandidate,
  opts: { requireLivePreview?: boolean; now: Date; estimateUsd: number },
): string | null {
  if (!row.isActive) return 'inactive';
  if (isDown(row, opts.now)) return 'down';
  if (budgetExhausted(row.spendUsd, row.monthlyBudgetUsd)) return 'over budget';
  if (row.monthlyMinutesLimit != null && row.minutesUsed >= row.monthlyMinutesLimit) {
    return 'over minute limit';
  }
  if (opts.requireLivePreview && !DRIVER_CAPABILITIES[row.driver]?.publicPreviewUrl) {
    return 'capability mismatch: live preview needs a public URL';
  }
  if (row.creditType !== 'paid' && !hasUsableCredit(row.creditType, row.creditRemainingUsd)) {
    return 'no remaining credit';
  }
  const remaining = remainingCreditUsd(row.creditRemainingUsd);
  if (row.creditType !== 'paid' && Number.isFinite(remaining) && remaining < opts.estimateUsd) {
    return 'remaining credit below estimated run cost';
  }
  return null;
}

function estimateFor(row: ProviderCandidate, seconds: number, costModelFor: RankInput['costModelFor']) {
  const model = costModelFor?.(row.driver) ?? DRIVER_COST_MODELS[row.driver];
  const cpu = row.config.cpu ?? 1;
  const memoryGiB = row.config.memoryGiB ?? 1;
  return estimateRunCostUsd(model, cpu, memoryGiB, seconds);
}

/**
 * unknown is eligible (a first boot must be possible before anything is probed).
 * It is not preferred over a known-healthy row, and a degraded row is not
 * preferred over unknown just because it is cheaper.
 */
function healthRank(status: string) {
  if (status === 'healthy') return 0;
  if (status === 'degraded') return 2;
  return 1;
}

function compareHealth(a: ProviderCandidate, b: ProviderCandidate) {
  return healthRank(a.healthStatus) - healthRank(b.healthStatus);
}

function sortFreeFirst(a: ProviderCandidate, b: ProviderCandidate) {
  const tier = TIER[a.creditType] - TIER[b.creditType];
  if (tier !== 0) return tier;
  const health = compareHealth(a, b);
  if (health !== 0) return health;
  if (a.creditType === 'one_time') {
    const left = remainingCreditUsd(a.creditRemainingUsd);
    const right = remainingCreditUsd(b.creditRemainingUsd);
    if (left !== right) return left - right;
  }
  return a.priority - b.priority;
}

/** Shared health English — Next pick and Job skip lines use the same facts. */
function healthFact(status: string) {
  if (status === 'healthy') return 'known healthy (create, echo, and shutdown succeeded)';
  if (status === 'degraded') return 'last create/echo/shutdown failed';
  return 'not checked yet — still eligible so a first boot can run';
}

export function describeProviderSelection(opts: {
  pick: ProviderCandidate;
  strategy: RoutingStrategy;
  sticky?: boolean;
}) {
  const { pick, strategy, sticky } = opts;
  if (sticky) {
    return `Sticky — using this project's stored provider (${pick.name}).`;
  }
  const health =
    pick.healthStatus === 'degraded'
      ? `${healthFact('degraded')}; no healthier eligible row`
      : healthFact(pick.healthStatus);
  if (strategy === 'free_first') {
    const tier =
      pick.creditType === 'recurring_monthly'
        ? 'monthly free credit'
        : pick.creditType === 'one_time'
          ? 'smallest eligible one-time pool in this health band'
          : 'paid credit';
    return `${pick.name} — ${tier}; ${health}.`;
  }
  if (strategy === 'priority') {
    return `${pick.name} — highest priority in the healthiest eligible band; ${health}.`;
  }
  if (strategy === 'cheapest') {
    return `${pick.name} — lowest estimated run cost in the healthiest eligible band; ${health}.`;
  }
  return `${pick.name} — round-robin among the healthiest eligible band; ${health}.`;
}

const MAX_OUTRANKED = 5;

function beatsOnStrategyKey(
  row: ProviderCandidate,
  pick: ProviderCandidate,
  opts: { strategy: RoutingStrategy; estimateSeconds: number; costModelFor?: RankInput['costModelFor'] },
) {
  if (opts.strategy === 'free_first') {
    const tier = TIER[row.creditType] - TIER[pick.creditType];
    if (tier < 0) return true;
    if (tier > 0) return false;
    if (row.creditType === 'one_time') {
      return remainingCreditUsd(row.creditRemainingUsd) < remainingCreditUsd(pick.creditRemainingUsd);
    }
    return false;
  }
  if (opts.strategy === 'cheapest') {
    return estimateFor(row, opts.estimateSeconds, opts.costModelFor) < estimateFor(pick, opts.estimateSeconds, opts.costModelFor);
  }
  if (opts.strategy === 'priority') {
    return row.priority < pick.priority;
  }
  return false;
}

export function describeOutrankedEligible(opts: {
  eligible: ProviderCandidate[];
  pick: ProviderCandidate;
  strategy: RoutingStrategy;
  estimateSeconds: number;
  costModelFor?: RankInput['costModelFor'];
}): Array<{ configId: string; name: string; reason: string }> {
  return opts.eligible
    .filter((row) => row.id !== opts.pick.id)
    .filter(
      (row) =>
        healthRank(row.healthStatus) > healthRank(opts.pick.healthStatus) &&
        beatsOnStrategyKey(row, opts.pick, opts),
    )
    .slice(0, MAX_OUTRANKED)
    .map((row) => ({
      configId: row.id,
      name: row.name,
      reason: `${row.name} — ${healthFact(row.healthStatus)}.`,
    }));
}

function withReason(
  pick: ProviderCandidate,
  strategy: RoutingStrategy,
  extra: { sticky?: boolean; eligible?: ProviderCandidate[]; input?: RankInput } = {},
): ProviderCandidate {
  const estimateSeconds = extra.input?.estimateSeconds ?? DEFAULT_IDLE_MINUTES * 60;
  return {
    ...pick,
    selectionReason: describeProviderSelection({ pick, strategy, sticky: extra.sticky }),
    outrankedEligible: extra.sticky
      ? []
      : describeOutrankedEligible({
          eligible: extra.eligible ?? [],
          pick,
          strategy,
          estimateSeconds,
          costModelFor: extra.input?.costModelFor,
        }),
  };
}

function pickRoundRobin(eligible: ProviderCandidate[], cursor: number) {
  const expanded: ProviderCandidate[] = [];
  for (const row of eligible) {
    const copies = Math.max(1, Math.floor(row.weight || 1));
    for (let i = 0; i < copies; i += 1) expanded.push(row);
  }
  return expanded[cursor % expanded.length];
}

export function rankAndSelect(input: RankInput): ProviderCandidate {
  const now = input.now ?? new Date();
  const estimateSeconds = input.estimateSeconds ?? DEFAULT_IDLE_MINUTES * 60;
  const costModelFor = input.costModelFor;
  const exclusions: Array<{ id: string; name: string; reason: string }> = [];
  const eligible: ProviderCandidate[] = [];

  if (input.stickyConfigId) {
    const sticky = input.candidates.find((row) => row.id === input.stickyConfigId);
    if (sticky) return withReason(sticky, input.strategy, { sticky: true });
  }

  for (const row of input.candidates) {
    const estimateUsd = estimateFor(row, estimateSeconds, costModelFor);
    const reason = exclusionReason(row, {
      requireLivePreview: input.requireLivePreview,
      now,
      estimateUsd,
    });
    if (reason) {
      exclusions.push({ id: row.id, name: row.name, reason });
    } else {
      eligible.push(row);
    }
  }

  if (eligible.length === 0) {
    throw new NoProviderAvailableError(exclusions);
  }

  if (input.strategy === 'round_robin') {
    const best = Math.min(...eligible.map((row) => healthRank(row.healthStatus)));
    const band = eligible.filter((row) => healthRank(row.healthStatus) === best);
    return withReason(
      pickRoundRobin(
        [...band].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id)),
        input.roundRobinCursor ?? 0,
      ),
      input.strategy,
      { eligible, input },
    );
  }

  if (input.strategy === 'priority') {
    const pick = [...eligible].sort((a, b) => compareHealth(a, b) || a.priority - b.priority)[0];
    return withReason(pick, input.strategy, { eligible, input });
  }

  if (input.strategy === 'cheapest') {
    const pick = [...eligible].sort((a, b) => {
      const health = compareHealth(a, b);
      if (health !== 0) return health;
      const left = estimateFor(a, estimateSeconds, costModelFor);
      const right = estimateFor(b, estimateSeconds, costModelFor);
      if (left !== right) return left - right;
      return a.priority - b.priority;
    })[0];
    return withReason(pick, input.strategy, { eligible, input });
  }

  return withReason([...eligible].sort(sortFreeFirst)[0], input.strategy, { eligible, input });
}

function toCandidate(row: StoredProviderConfig): ProviderCandidate {
  const config = (row.config && typeof row.config === 'object' ? row.config : {}) as ProviderCandidate['config'] & {
    downUntil?: string;
  };
  return {
    id: row.id,
    name: row.name,
    driver: row.driver,
    isActive: row.isActive,
    priority: row.priority,
    weight: row.weight,
    creditType: row.creditType,
    creditRemainingUsd: row.creditRemainingUsd,
    creditTotalUsd: row.creditTotalUsd,
    monthlyBudgetUsd: row.monthlyBudgetUsd,
    monthlyMinutesLimit: row.monthlyMinutesLimit,
    minutesUsed: row.minutesUsed,
    spendUsd: row.spendUsd,
    healthStatus: row.healthStatus,
    lastCheckedAt: row.lastCheckedAt,
    consecutiveFails: row.consecutiveFails,
    downUntil: config.downUntil ? new Date(config.downUntil) : null,
    periodStart: row.periodStart,
    creditResetsAt: row.creditResetsAt,
    config,
  };
}

export async function selectProvider(opts: {
  workspaceId?: string;
  projectId?: string;
  requireLivePreview?: boolean;
  candidates?: ProviderCandidate[];
  strategy?: RoutingStrategy;
  now?: Date;
  estimateSeconds?: number;
  roundRobinCursor?: number;
}) {
  const strategy = opts.strategy ?? (await getRoutingStrategy());
  let stickyConfigId: string | null = null;
  if (opts.projectId) {
    const rows = await prisma.$queryRaw<
      Array<{ sandboxId: string | null; sandboxStatus: string | null; sandboxProviderConfigId: string | null }>
    >`
      SELECT "sandboxId", "sandboxStatus"::text AS "sandboxStatus", "sandboxProviderConfigId"
      FROM "Project"
      WHERE id = ${opts.projectId}
      LIMIT 1
    `;
    const project = rows[0];
    stickyConfigId = resolveStickyProvider({
      sandboxId: project?.sandboxId ?? null,
      sandboxStatus: project?.sandboxStatus ?? null,
      sandboxProviderConfigId: project?.sandboxProviderConfigId ?? null,
      strategyPickId: null,
    });
  }

  const candidates = opts.candidates ?? (await listProviderConfigs()).map(toCandidate);
  let cursor = opts.roundRobinCursor;
  if (cursor == null && strategy === 'round_robin') {
    cursor = await incrementRoundRobinCursor();
  }

  return rankAndSelect({
    candidates,
    strategy,
    requireLivePreview: opts.requireLivePreview,
    stickyConfigId,
    now: opts.now,
    estimateSeconds: opts.estimateSeconds,
    roundRobinCursor: cursor,
  });
}

async function incrementRoundRobinCursor() {
  const key = 'sandbox.roundRobinCursor';
  // Read-and-bump in one statement: a separate SELECT then UPDATE hands the same
  // cursor to two concurrent boots, which then pick the same provider.
  const rows = await prisma.$queryRaw<Array<{ value: string }>>`
    INSERT INTO "AppSetting" (key, value, "updatedAt")
    VALUES (${key}, '1', NOW())
    ON CONFLICT (key) DO UPDATE
    SET value = (
          (CASE WHEN "AppSetting".value ~ '^[0-9]+$' THEN "AppSetting".value::bigint ELSE 0 END) + 1
        )::text,
        "updatedAt" = NOW()
    RETURNING value
  `;
  const next = Number.parseInt(rows[0]?.value || '1', 10) || 1;
  return next - 1;
}

export { toCandidate };
