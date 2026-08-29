import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The quality pipeline behind /admin/quality.
 *
 * Four defects, one theme — the dashboard asserted things the pipeline had not
 * measured:
 *   F-760  `type_safety` was collected, stored and charted but carried no
 *          weight, so a project whose type-check failed still scored 1.0.
 *   F-816  the collector fabricated `{ impact: 'moderate' }` per violation
 *          because the production caller never passed axe's own impacts, so a
 *          critical violation was penalised as a moderate one.
 *   F-705  a check that could not run contributed no findings, which the
 *          collector read as "clean" and recorded as a perfect score.
 *   F-732/F-817  the page ran a write on render and 2×N unbounded scans.
 */

const prisma = vi.hoisted(() => ({
  qualitySignal: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    createMany: vi.fn(),
    update: vi.fn(),
    groupBy: vi.fn(),
  },
  generationEvent: { findFirst: vi.fn(), findMany: vi.fn(), groupBy: vi.fn() },
  promptVersion: { findMany: vi.fn() },
  $queryRaw: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ prisma }));
vi.mock('@/lib/prompts/version', () => ({
  stampActivePromptHash: async () => 'active'.padEnd(64, '0'),
  getActivePromptVersion: async () => ({ hash: 'active'.padEnd(64, '0'), label: 'v1' }),
}));

import { maybeSettleFollowups, recordCodeAuditSignals } from '@/lib/signals/collect';
import { getQualityDashboard } from '@/lib/signals/metrics';
import {
  QUALITY_SCORE_WEIGHTS,
  QUALITY_SIGNAL_KINDS,
  a11yScoreFromAxe,
  composeOverallScore,
  typeSafetyScore,
} from '@/lib/signals/score';

const EVENT = {
  id: 'gen-1',
  promptVersion: 'v2'.padEnd(64, '0'),
  createdAt: new Date('2026-08-01'),
};

function createdSignals() {
  return prisma.qualitySignal.create.mock.calls.map((call) => call[0].data);
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.generationEvent.findFirst.mockResolvedValue(EVENT);
  prisma.generationEvent.findMany.mockResolvedValue([]);
  prisma.generationEvent.groupBy.mockResolvedValue([]);
  prisma.qualitySignal.findFirst.mockResolvedValue(null);
  prisma.qualitySignal.findMany.mockResolvedValue([]);
  prisma.qualitySignal.groupBy.mockResolvedValue([]);
  prisma.qualitySignal.create.mockImplementation(async (args: { data: unknown }) => args.data);
  prisma.qualitySignal.createMany.mockResolvedValue({ count: 0 });
  prisma.promptVersion.findMany.mockResolvedValue([]);
  prisma.$queryRaw.mockResolvedValue([{ total: 0n, days: 0n }]);
});

describe('F-760 — every collected signal carries weight', () => {
  it('weights every kind that is collected, and the weights still sum to 1', () => {
    expect(Object.keys(QUALITY_SCORE_WEIGHTS).sort()).toEqual([...QUALITY_SIGNAL_KINDS].sort());
    const sum = Object.values(QUALITY_SCORE_WEIGHTS).reduce((total, weight) => total + weight, 0);
    expect(Math.abs(sum - 1)).toBeLessThan(1e-9);
  });

  it('a project whose type-check failed cannot score 1.0', () => {
    const stats = Object.fromEntries(
      QUALITY_SIGNAL_KINDS.map((kind) => [
        kind,
        { mean: kind === 'type_safety' ? typeSafetyScore(7) : 1, n: 10 },
      ]),
    );
    const overall = composeOverallScore(stats);
    expect(overall).not.toBeNull();
    // Was exactly 1: `type_safety` was absent from the weights map, so
    // `composeOverallScore` skipped it and a perfect-everything-else project
    // read 100% however badly it type-checked.
    expect(overall!).toBeLessThan(1);
    expect(overall!).toBeGreaterThan(0.8);
  });
});

describe('F-816 — axe impacts reach the score', () => {
  it('records a critical violation as critical, not as moderate', async () => {
    await recordCodeAuditSignals({
      projectId: 'p1',
      codeAuditId: 'audit-1',
      axeViolations: [{ impact: 'critical' }],
    });

    const [signal] = createdSignals();
    expect(signal.kind).toBe('a11y_score');
    expect(signal.value).toBe(a11yScoreFromAxe([{ impact: 'critical' }]));
    expect(signal.value).not.toBe(a11yScoreFromAxe([{ impact: 'moderate' }]));
    expect(signal.rawValue).toMatchObject({ impacts: ['critical'], violations: 1 });
  });

  it('distinguishes "axe ran and found nothing" from "axe did not run"', async () => {
    await recordCodeAuditSignals({ projectId: 'p1', codeAuditId: 'clean', axeViolations: [] });
    expect(createdSignals().map((row) => row.kind)).toEqual(['a11y_score']);
    expect(createdSignals()[0].value).toBe(1);

    prisma.qualitySignal.create.mockClear();
    await recordCodeAuditSignals({ projectId: 'p1', codeAuditId: 'no-axe', axeViolations: null });
    expect(createdSignals()).toEqual([]);
  });
});

describe('F-705 — a check that did not run records nothing', () => {
  it('writes no type_safety or build_success signal when neither ran', async () => {
    await recordCodeAuditSignals({
      projectId: 'p1',
      codeAuditId: 'audit-2',
      axeViolations: [{ impact: 'minor' }],
      tsErrors: null,
      buildOk: null,
    });
    expect(createdSignals().map((row) => row.kind)).toEqual(['a11y_score']);
  });

  it('records the real counts when the checks did run', async () => {
    await recordCodeAuditSignals({
      projectId: 'p1',
      codeAuditId: 'audit-3',
      tsErrors: 3,
      buildOk: false,
    });
    const byKind = Object.fromEntries(createdSignals().map((row) => [row.kind, row.value]));
    expect(byKind.type_safety).toBe(typeSafetyScore(3));
    expect(byKind.build_success).toBe(0);
  });
});

describe('F-817 — collector query count does not grow with the work', () => {
  async function settleWith(eventCount: number) {
    vi.clearAllMocks();
    prisma.qualitySignal.findFirst.mockResolvedValue(null);
    prisma.qualitySignal.findMany.mockResolvedValue([]);
    prisma.qualitySignal.create.mockImplementation(async (args: { data: unknown }) => args.data);
    prisma.qualitySignal.createMany.mockResolvedValue({ count: eventCount });
    prisma.generationEvent.findMany.mockResolvedValue(
      Array.from({ length: eventCount }, (_, index) => ({
        id: `gen-${index}`,
        createdAt: new Date('2026-08-01T00:00:00Z'),
        promptVersion: 'v2'.padEnd(64, '0'),
      })),
    );
    await maybeSettleFollowups('p1', new Date('2026-08-02T00:00:00Z'));
    return (
      prisma.qualitySignal.findFirst.mock.calls.length +
      prisma.qualitySignal.findMany.mock.calls.length +
      prisma.qualitySignal.create.mock.calls.length +
      prisma.qualitySignal.createMany.mock.calls.length +
      prisma.generationEvent.findMany.mock.calls.length
    );
  }

  it('settles two generations and twenty in the same number of queries', async () => {
    const small = await settleWith(2);
    const large = await settleWith(20);
    // Was 2 per event — a whole-history scan plus a create, in series.
    expect(large).toBe(small);
    expect(large).toBeLessThanOrEqual(6);
  });

  it('inserts the settled revert_rate rows in one batch', async () => {
    await settleWith(20);
    expect(prisma.qualitySignal.createMany).toHaveBeenCalledTimes(1);
    expect(prisma.qualitySignal.createMany.mock.calls[0][0].data).toHaveLength(20);
  });

  it('bounds the idle sweep instead of reading every generation ever written', () => {
    const source = readFileSync('lib/signals/collect.ts', 'utf8');
    const sweep = source.slice(source.indexOf('export async function settleIdleProjects'));
    expect(sweep).toContain('take: limit');
    expect(sweep).toMatch(/createdAt: \{ gte:/);
  });
});

describe('F-732 — /admin/quality is a read', () => {
  it('performs no write of any kind while rendering', async () => {
    const boom = () => {
      throw new Error('the dashboard render must not write');
    };
    prisma.qualitySignal.create.mockImplementation(boom);
    prisma.qualitySignal.createMany.mockImplementation(boom);
    prisma.qualitySignal.update.mockImplementation(boom);
    // A project with an unsettled generation old enough to settle: the render
    // used to await `settleIdleProjects()` as its first statement, which would
    // reach the writes above.
    prisma.generationEvent.findMany.mockResolvedValue([
      { projectId: 'p1', id: 'gen-1', createdAt: new Date('2026-07-02'), promptVersion: 'v2' },
    ]);
    // Carries both shapes on purpose: the settle sweep's `(projectId, _max)` and
    // the cost panel's `(promptVersion, _sum, _count)`, because one mock answers
    // whichever `generationEvent.groupBy` the render runs. The assertion below is
    // what separates them.
    prisma.generationEvent.groupBy.mockResolvedValue([
      {
        projectId: 'p1',
        _max: { createdAt: new Date('2026-07-02') },
        promptVersion: null,
        _sum: { estimatedCost: null, inputTokens: null },
        _count: { _all: 1 },
      },
    ]);

    await expect(
      getQualityDashboard(new Date('2026-07-01'), new Date('2026-08-01')),
    ).resolves.toBeTruthy();

    expect(prisma.qualitySignal.create).not.toHaveBeenCalled();
    expect(prisma.qualitySignal.createMany).not.toHaveBeenCalled();
    expect(prisma.qualitySignal.update).not.toHaveBeenCalled();
    // The settle pass is a write and belongs to the daily cron; the render must
    // not even go looking for projects to settle. Named by its grouping rather
    // than by the table: the cost panel groups the same table by `promptVersion`,
    // and a blanket "never touches generationEvent.groupBy" would forbid a read.
    const groupings = prisma.generationEvent.groupBy.mock.calls.map(
      (call: [{ by: string[] }]) => call[0].by,
    );
    expect(groupings).not.toContainEqual(['projectId']);
    expect(prisma.generationEvent.findMany).not.toHaveBeenCalled();
  });

  it('aggregates in SQL and does not scan signal rows, however many versions exist', async () => {
    prisma.promptVersion.findMany.mockResolvedValue(
      Array.from({ length: 12 }, (_, index) => ({
        id: `v${index}`,
        hash: `hash-${index}`,
        label: `v${index}`,
        isActive: index === 11,
        createdAt: new Date('2026-07-02'),
      })),
    );

    await getQualityDashboard(new Date('2026-07-01'), new Date('2026-08-01'));

    // Three windows for the dashboard, three shared by every prompt version —
    // not 2 unbounded findMany scans per version.
    expect(prisma.qualitySignal.groupBy).toHaveBeenCalledTimes(6);
    expect(prisma.qualitySignal.findMany).not.toHaveBeenCalled();
  });

  it('caps the prompt-version history', async () => {
    prisma.promptVersion.findMany.mockResolvedValue([]);
    await getQualityDashboard(new Date('2026-07-01'), new Date('2026-08-01'));
    const args = prisma.promptVersion.findMany.mock.calls[0][0];
    expect(typeof args.take).toBe('number');
  });
});

describe('the audit hands the collector measurements, not finding counts', () => {
  it('passes the scan signals through instead of `metrics`', () => {
    const source = readFileSync('lib/audit/actions.ts', 'utf8');
    const call = source.slice(
      source.indexOf('recordCodeAuditSignals({'),
      source.indexOf('recordCodeAuditSignals({') + 400,
    );
    expect(call).toContain('...scanned.signals');
    expect(call).not.toContain('metrics: scanned.metrics');
    expect(call).not.toContain("item.id === 'bundle:build-failed'");
  });
});
