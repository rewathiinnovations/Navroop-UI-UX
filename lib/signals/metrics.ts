import { prisma } from '@/lib/db';
import { getActivePromptVersion } from '@/lib/prompts/version';
import { settleIdleProjects } from './collect';
import {
  QUALITY_SCORE_WEIGHTS,
  QUALITY_SIGNAL_KINDS,
  SIGNAL_DEFINITIONS,
  composeKindMetric,
  composeOverallScore,
  type QualitySignalKind,
} from './score';

export { QUALITY_SCORE_WEIGHTS, QUALITY_SIGNAL_KINDS, SIGNAL_DEFINITIONS, MIN_KIND_SAMPLES, MIN_OVERALL_SAMPLES } from './score';

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

function avg(values: number[]) {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export async function getQualityMetrics(query: QualityMetricsQuery): Promise<Record<QualitySignalKind, KindMetric>> {
  const where = {
    createdAt: { gte: query.from, lt: query.to },
    ...(query.promptVersion ? { promptVersion: query.promptVersion } : {}),
  };
  const rows = await prisma.qualitySignal.findMany({
    where,
    select: { kind: true, value: true, createdAt: true },
  });

  const byKind = new Map<string, { value: number; createdAt: Date }[]>();
  for (const row of rows) {
    const list = byKind.get(row.kind) ?? [];
    list.push({ value: row.value, createdAt: row.createdAt });
    byKind.set(row.kind, list);
  }

  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const recentFrom = new Date(query.to.getTime() - weekMs);
  const priorFrom = new Date(query.to.getTime() - 2 * weekMs);

  const result = {} as Record<QualitySignalKind, KindMetric>;
  for (const kind of QUALITY_SIGNAL_KINDS) {
    const samples = byKind.get(kind) ?? [];
    const composed = composeKindMetric(samples.map((sample) => sample.value));
    const recent = samples.filter((sample) => sample.createdAt >= recentFrom).map((sample) => sample.value);
    const prior = samples
      .filter((sample) => sample.createdAt >= priorFrom && sample.createdAt < recentFrom)
      .map((sample) => sample.value);
    const recentMean = avg(recent);
    const priorMean = avg(prior);
    result[kind] = {
      kind,
      label: SIGNAL_DEFINITIONS[kind].label,
      definition: SIGNAL_DEFINITIONS[kind].definition,
      mean: composed?.mean ?? null,
      n: samples.length,
      trend: recentMean != null && priorMean != null ? recentMean - priorMean : null,
    };
  }
  return result;
}

export async function getOverallQualityScore(query: QualityMetricsQuery): Promise<number | null> {
  const metrics = await getQualityMetrics(query);
  return composeOverallScore(
    Object.fromEntries(Object.entries(metrics).map(([kind, row]) => [kind, { mean: row.mean, n: row.n }])),
  );
}

export async function getQualitySummary(from: Date, to: Date) {
  const events = await prisma.generationEvent.findMany({
    where: { createdAt: { gte: from, lt: to } },
    select: { createdAt: true },
  });
  const days = new Set(events.map((event) => event.createdAt.toISOString().slice(0, 10)));
  const version = await getActivePromptVersion();
  return {
    totalGenerations: events.length,
    activeDays: days.size,
    promptVersionLabel: version.label,
    promptVersionHash: version.hash,
  };
}

export async function getPromptVersionHistory(from: Date, to: Date) {
  const versions = await prisma.promptVersion.findMany({
    orderBy: { createdAt: 'asc' },
  });
  return Promise.all(
    versions.map(async (version) => {
      const metrics = await getQualityMetrics({ from, to, promptVersion: version.hash });
      const sampleCount = Object.values(metrics).reduce((sum, row) => sum + row.n, 0);
      return {
        id: version.id,
        hash: version.hash,
        label: version.label,
        isActive: version.isActive,
        createdAt: version.createdAt.toISOString(),
        overall: await getOverallQualityScore({ from, to, promptVersion: version.hash }),
        metrics,
        sampleCount,
      };
    }),
  );
}

export async function getQualityDashboard(from: Date, to: Date) {
  await settleIdleProjects();
  const [summary, metrics, overall, versions] = await Promise.all([
    getQualitySummary(from, to),
    getQualityMetrics({ from, to }),
    getOverallQualityScore({ from, to }),
    getPromptVersionHistory(from, to),
  ]);
  return { summary, metrics, overall, versions };
}
