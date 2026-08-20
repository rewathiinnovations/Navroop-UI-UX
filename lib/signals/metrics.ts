import { prisma } from '@/lib/db';
import { getActivePromptVersion } from '@/lib/prompts/version';
import {
  QUALITY_SIGNAL_KINDS,
  SIGNAL_DEFINITIONS,
  composeKindStat,
  composeOverallScore,
  type QualitySignalKind,
} from './score';

export {
  QUALITY_SCORE_WEIGHTS,
  QUALITY_SIGNAL_KINDS,
  SIGNAL_DEFINITIONS,
  MIN_KIND_SAMPLES,
  MIN_OVERALL_SAMPLES,
} from './score';

export type QualityMetricsQuery = {
  from: Date;
  to: Date;
  promptVersion?: string;
};

export type KindMetric = {
  kind: QualitySignalKind;
  label: string;
  definition: string;
  mean: number | null;
  n: number;
  trend: number | null;
};

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The most recent prompt versions the history table can show. Every stack-prompt
 * edit rolls a new version, so this list grows with normal development and the
 * page used to render all of them — each costing two full scans of
 * `QualitySignal` (F-732).
 */
const MAX_VERSION_ROWS = 25;

type Aggregate = { kind: string; promptVersion: string; mean: number; n: number };

/**
 * One grouped query, not a row scan.
 *
 * `getQualityMetrics` used to `findMany` every signal row in the range with no
 * `take` and reduce in JavaScript, and `getPromptVersionHistory` called it —
 * plus `getOverallQualityScore`, which called it again — once per prompt
 * version, all concurrently. V versions cost 2V unbounded scans per page load
 * (F-732). Postgres now returns one row per (kind, promptVersion).
 */
async function aggregate(where: {
  from: Date;
  to: Date;
  promptVersion?: string;
}): Promise<Aggregate[]> {
  const grouped = await prisma.qualitySignal.groupBy({
    by: ['kind', 'promptVersion'],
    where: {
      createdAt: { gte: where.from, lt: where.to },
      ...(where.promptVersion ? { promptVersion: where.promptVersion } : {}),
    },
    _avg: { value: true },
    _count: { _all: true },
  });
  return grouped.map((row) => ({
    kind: row.kind,
    promptVersion: row.promptVersion,
    mean: row._avg.value ?? 0,
    n: row._count._all,
  }));
}

function meanOf(rows: Aggregate[]): number | null {
  const total = rows.reduce((sum, row) => sum + row.n, 0);
  if (total === 0) return null;
  return rows.reduce((sum, row) => sum + row.mean * row.n, 0) / total;
}

/** Builds the eight per-kind metrics from already-aggregated rows. */
function metricsFrom(
  all: Aggregate[],
  recent: Aggregate[],
  prior: Aggregate[],
): Record<QualitySignalKind, KindMetric> {
  const result = {} as Record<QualitySignalKind, KindMetric>;
  for (const kind of QUALITY_SIGNAL_KINDS) {
    const rows = all.filter((row) => row.kind === kind);
    const n = rows.reduce((sum, row) => sum + row.n, 0);
    const composed = composeKindStat(meanOf(rows), n);
    const recentMean = meanOf(recent.filter((row) => row.kind === kind));
    const priorMean = meanOf(prior.filter((row) => row.kind === kind));
    result[kind] = {
      kind,
      label: SIGNAL_DEFINITIONS[kind].label,
      definition: SIGNAL_DEFINITIONS[kind].definition,
      mean: composed?.mean ?? null,
      n,
      trend: recentMean != null && priorMean != null ? recentMean - priorMean : null,
    };
  }
  return result;
}

function overallFrom(metrics: Record<QualitySignalKind, KindMetric>): number | null {
  return composeOverallScore(
    Object.fromEntries(
      Object.entries(metrics).map(([kind, row]) => [kind, { mean: row.mean, n: row.n }]),
    ),
  );
}

/** Three grouped queries: the range, the last week, and the week before it. */
async function aggregateWindows(query: QualityMetricsQuery) {
  const recentFrom = new Date(query.to.getTime() - WEEK_MS);
  const priorFrom = new Date(query.to.getTime() - 2 * WEEK_MS);
  const [all, recent, prior] = await Promise.all([
    aggregate(query),
    aggregate({ from: recentFrom, to: query.to, promptVersion: query.promptVersion }),
    aggregate({ from: priorFrom, to: recentFrom, promptVersion: query.promptVersion }),
  ]);
  return { all, recent, prior };
}

export async function getQualityMetrics(
  query: QualityMetricsQuery,
): Promise<Record<QualitySignalKind, KindMetric>> {
  const windows = await aggregateWindows(query);
  return metricsFrom(windows.all, windows.recent, windows.prior);
}

export async function getOverallQualityScore(query: QualityMetricsQuery): Promise<number | null> {
  return overallFrom(await getQualityMetrics(query));
}

export async function getQualitySummary(from: Date, to: Date) {
  // Was a `findMany` of every generation in the range, materialised only to
  // count rows and distinct days (F-732). Postgres counts both.
  const [totals] = await prisma.$queryRaw<Array<{ total: bigint; days: bigint }>>`
    SELECT COUNT(*)::bigint AS total,
           COUNT(DISTINCT date_trunc('day', "createdAt"))::bigint AS days
    FROM "GenerationEvent"
    WHERE "createdAt" >= ${from} AND "createdAt" < ${to}
  `;
  const version = await getActivePromptVersion();
  return {
    totalGenerations: Number(totals?.total ?? 0),
    activeDays: Number(totals?.days ?? 0),
    promptVersionLabel: version.label,
    promptVersionHash: version.hash,
  };
}

export async function getPromptVersionHistory(from: Date, to: Date) {
  const versions = await prisma.promptVersion.findMany({
    orderBy: { createdAt: 'desc' },
    take: MAX_VERSION_ROWS,
  });
  // One set of grouped queries for every version at once — the aggregate is
  // already keyed by `promptVersion`, so each row is a filter, not a query.
  const windows = await aggregateWindows({ from, to });
  return versions
    .map((version) => {
      const pick = (rows: Aggregate[]) => rows.filter((row) => row.promptVersion === version.hash);
      const metrics = metricsFrom(pick(windows.all), pick(windows.recent), pick(windows.prior));
      return {
        id: version.id,
        hash: version.hash,
        label: version.label,
        isActive: version.isActive,
        createdAt: version.createdAt.toISOString(),
        overall: overallFrom(metrics),
        metrics,
        sampleCount: Object.values(metrics).reduce((sum, row) => sum + row.n, 0),
      };
    })
    .reverse();
}

/**
 * Read-only. `settleIdleProjects()` — a write — used to be the first statement
 * here, so every GET of /admin/quality mutated data, twice if two admins opened
 * the page at once (F-732). It is maintenance work and now runs on the daily
 * thin-checkpoints cron.
 */
export async function getQualityDashboard(from: Date, to: Date) {
  const [summary, windows, versions] = await Promise.all([
    getQualitySummary(from, to),
    aggregateWindows({ from, to }),
    getPromptVersionHistory(from, to),
  ]);
  const metrics = metricsFrom(windows.all, windows.recent, windows.prior);
  return { summary, metrics, overall: overallFrom(metrics), versions };
}
