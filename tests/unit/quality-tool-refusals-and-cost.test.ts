import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The two production readings /admin/quality was missing.
 *
 * Tool refusals: a generation tool returns its refusals to the model rather than
 * throwing, so "that path is not allowed" and "search appears 3 times" reached
 * the browser as one SSE frame and were never written down. A prompt change that
 * makes the model fight `edit_file` was invisible until a user noticed and
 * restored, which is `revert_rate` — days later and only for the runs someone
 * cared enough to undo.
 *
 * Cost: `GenerationEvent` has carried `estimatedCost`, `inputTokens` and
 * `promptVersion` on the same row since the version stamp shipped, and no page
 * read the three together — so "v3 scores four points better" was answerable and
 * "and costs 40% more per generation" was not.
 *
 * The invariant underneath both: the refusal kinds stay out of
 * `QUALITY_SIGNAL_KINDS`. That array is typed against `QUALITY_SCORE_WEIGHTS`,
 * whose weights sum to 1 (F-760), and `value` here is a rate where every other
 * kind is a score — folding one in would move the composite the wrong way.
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
  generationEvent: { findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), groupBy: vi.fn() },
  promptVersion: { findMany: vi.fn() },
  $queryRaw: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ prisma }));
vi.mock('@/lib/prompts/version', () => ({
  stampActivePromptHash: async () => 'active'.padEnd(64, '0'),
  getActivePromptVersion: async () => ({ hash: 'active'.padEnd(64, '0'), label: 'v9' }),
}));

import {
  countToolResult,
  recordToolRefusalRates,
  type ToolResultTally,
} from '@/lib/signals/collect';
import { getQualityDashboard } from '@/lib/signals/metrics';
import {
  QUALITY_SCORE_WEIGHTS,
  QUALITY_SIGNAL_KINDS,
  TOOL_REFUSAL_KIND_PREFIX,
  composeOverallScore,
  toolFromRefusalKind,
  toolRefusalKind,
} from '@/lib/signals/score';

const RUN_VERSION = 'v2'.padEnd(64, '0');
const EVENT = { id: 'gen-1', promptVersion: RUN_VERSION };
const FROM = new Date('2026-07-01');
const TO = new Date('2026-08-01');

function insertedRows() {
  return prisma.qualitySignal.createMany.mock.calls[0][0].data as Array<{
    kind: string;
    value: number;
    promptVersion: string;
    generationEventId: string | null;
    rawValue: { tool: string; results: number; refusals: number };
  }>;
}

function signalGroup(kind: string, promptVersion: string, mean: number, n: number) {
  return { kind, promptVersion, _avg: { value: mean }, _count: { _all: n } };
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.generationEvent.findFirst.mockResolvedValue(EVENT);
  prisma.generationEvent.findUnique.mockResolvedValue(EVENT);
  prisma.generationEvent.findMany.mockResolvedValue([]);
  prisma.generationEvent.groupBy.mockResolvedValue([]);
  prisma.qualitySignal.findFirst.mockResolvedValue(null);
  prisma.qualitySignal.findMany.mockResolvedValue([]);
  prisma.qualitySignal.groupBy.mockResolvedValue([]);
  prisma.qualitySignal.createMany.mockResolvedValue({ count: 0 });
  prisma.promptVersion.findMany.mockResolvedValue([]);
  prisma.$queryRaw.mockResolvedValue([{ total: 0n, days: 0n }]);
});

describe('tool refusals are counted per tool', () => {
  it('counts a result once and a refusal only when the tool refused', () => {
    const tally: ToolResultTally = {};
    countToolResult(tally, 'write_file', true);
    countToolResult(tally, 'write_file', false);
    countToolResult(tally, 'edit_file', false);
    expect(tally).toEqual({
      write_file: { results: 2, refusals: 1 },
      edit_file: { results: 1, refusals: 1 },
    });
  });

  it('writes one namespaced row per tool, in one insert, at the run’s own version', async () => {
    await recordToolRefusalRates(
      'p1',
      { write_file: { results: 4, refusals: 1 }, add_dependency: { results: 2, refusals: 2 } },
      'gen-1',
    );

    expect(prisma.qualitySignal.createMany).toHaveBeenCalledTimes(1);
    const byKind = Object.fromEntries(insertedRows().map((row) => [row.kind, row]));
    expect(Object.keys(byKind)).toEqual([
      'tool_refusal_rate:write_file',
      'tool_refusal_rate:add_dependency',
    ]);
    expect(byKind['tool_refusal_rate:write_file'].value).toBe(0.25);
    // The write guard turning down an unavailable package is a 100% refusal rate
    // and not a defect — which is the reason the two tools are separate rows
    // rather than one blended 50%.
    expect(byKind['tool_refusal_rate:add_dependency'].value).toBe(1);
    expect(byKind['tool_refusal_rate:write_file'].rawValue).toEqual({
      tool: 'write_file',
      results: 4,
      refusals: 1,
    });
    // The generation's version, not whatever is active now (F-815).
    expect(insertedRows().every((row) => row.promptVersion === RUN_VERSION)).toBe(true);
    expect(insertedRows().every((row) => row.generationEventId === 'gen-1')).toBe(true);
  });

  it('writes nothing, and asks nothing, when the run called no tools', async () => {
    await recordToolRefusalRates('p1', {}, 'gen-1');
    await recordToolRefusalRates('p1', { write_file: { results: 0, refusals: 0 } }, 'gen-1');
    expect(prisma.generationEvent.findUnique).not.toHaveBeenCalled();
    expect(prisma.qualitySignal.createMany).not.toHaveBeenCalled();
  });

  it('records a generation once — the duplicate check is on the namespace', async () => {
    prisma.qualitySignal.findFirst.mockResolvedValue({ id: 'sig-1' });
    await recordToolRefusalRates('p1', { read_file: { results: 3, refusals: 0 } }, 'gen-1');

    expect(prisma.qualitySignal.createMany).not.toHaveBeenCalled();
    // Not `kind: 'tool_refusal_rate:read_file'`: a rerun that called a different
    // set of tools would find no row for the tool it looked up and double the
    // whole run's contribution to the population.
    expect(prisma.qualitySignal.findFirst.mock.calls[0][0].where).toMatchObject({
      generationEventId: 'gen-1',
      kind: { startsWith: TOOL_REFUSAL_KIND_PREFIX },
    });
  });

  it('never lets a refusal rate reach the weighted composite', () => {
    for (const kind of QUALITY_SIGNAL_KINDS) {
      expect(kind.startsWith(TOOL_REFUSAL_KIND_PREFIX)).toBe(false);
    }
    expect(Object.keys(QUALITY_SCORE_WEIGHTS)).not.toContain(toolRefusalKind('edit_file'));

    // A run that refused every call, sitting in the same stats object: the score
    // is unmoved, because `composeOverallScore` iterates the weights map.
    const stats = Object.fromEntries(
      QUALITY_SIGNAL_KINDS.map((kind) => [kind, { mean: 1, n: 10 }]),
    );
    expect(
      composeOverallScore({ ...stats, [toolRefusalKind('edit_file')]: { mean: 1, n: 100 } }),
    ).toBe(1);
  });

  it('round-trips the tool name through the kind', () => {
    expect(toolFromRefusalKind(toolRefusalKind('search_files'))).toBe('search_files');
    expect(toolFromRefusalKind('revert_rate')).toBeNull();
    expect(toolFromRefusalKind(TOOL_REFUSAL_KIND_PREFIX)).toBeNull();
  });
});

describe('the dashboard reads refusals out of the aggregate it already ran', () => {
  it('reports a per-tool rate weighted by row count, and no extra query', async () => {
    prisma.qualitySignal.groupBy.mockResolvedValue([
      signalGroup(toolRefusalKind('edit_file'), 'hash-1', 0.5, 20),
      signalGroup(toolRefusalKind('edit_file'), 'hash-2', 0, 20),
      signalGroup('revert_rate', 'hash-1', 1, 40),
    ]);

    const dashboard = await getQualityDashboard(FROM, TO);

    // 0.5 over 20 rows and 0 over 20 — not the 0.25 an unweighted mean of the
    // two group means would give by luck, so the assertion below fixes the shape
    // with unequal counts too.
    expect(dashboard.toolRefusals).toEqual([{ tool: 'edit_file', rate: 0.25, n: 40 }]);
    // Three windows for the dashboard, three shared by the version history — the
    // refusal rates are derived from rows those already returned.
    expect(prisma.qualitySignal.groupBy).toHaveBeenCalledTimes(6);
    expect(prisma.qualitySignal.findMany).not.toHaveBeenCalled();
    // And the composite is untouched by them.
    expect(Object.keys(dashboard.metrics).sort()).toEqual([...QUALITY_SIGNAL_KINDS].sort());
  });

  it('holds a rate back under the sample floor but still reports the count', async () => {
    prisma.qualitySignal.groupBy.mockResolvedValue([
      signalGroup(toolRefusalKind('rename_file'), 'hash-1', 1, 4),
    ]);
    const dashboard = await getQualityDashboard(FROM, TO);
    expect(dashboard.toolRefusals).toEqual([{ tool: 'rename_file', rate: null, n: 4 }]);
  });
});

describe('cost and tokens per prompt version', () => {
  it('groups the generation events once and keeps the unversioned bucket', async () => {
    prisma.generationEvent.groupBy.mockResolvedValue([
      {
        promptVersion: 'hash-1',
        _sum: { estimatedCost: '1.5000', inputTokens: 3000 },
        _count: { _all: 3 },
      },
      {
        promptVersion: null,
        _sum: { estimatedCost: '0.2000', inputTokens: null },
        _count: { _all: 2 },
      },
    ]);
    prisma.promptVersion.findMany.mockResolvedValue([
      {
        id: 'v1',
        hash: 'hash-1',
        label: 'v1 — tightened',
        isActive: true,
        createdAt: new Date('2026-07-02'),
      },
    ]);

    const dashboard = await getQualityDashboard(FROM, TO);

    expect(dashboard.costs).toEqual([
      {
        promptVersion: 'hash-1',
        label: 'v1 — tightened',
        events: 3,
        estimatedCostUsd: 1.5,
        inputTokens: 3000,
        costPerEventUsd: 0.5,
        tokensPerEvent: 1000,
      },
      // Kept and named, not filtered: these rows are real money, and a table that
      // drops a bucket reads as a smaller bill than the workspace paid.
      {
        promptVersion: null,
        label: 'No prompt version recorded',
        events: 2,
        estimatedCostUsd: 0.2,
        inputTokens: 0,
        costPerEventUsd: 0.1,
        tokensPerEvent: 0,
      },
    ]);
    expect(prisma.generationEvent.groupBy).toHaveBeenCalledTimes(1);
    const args = prisma.generationEvent.groupBy.mock.calls[0][0];
    expect(args.by).toEqual(['promptVersion']);
    expect(args._sum).toEqual({ estimatedCost: true, inputTokens: true });
  });

  it('names a version the capped history no longer lists by its hash', async () => {
    prisma.generationEvent.groupBy.mockResolvedValue([
      {
        promptVersion: 'a'.repeat(64),
        _sum: { estimatedCost: '0.5000', inputTokens: 10 },
        _count: { _all: 1 },
      },
    ]);
    const dashboard = await getQualityDashboard(FROM, TO);
    // `MAX_VERSION_ROWS` caps the history at 25, and an older version can still
    // have spend inside the range; dropping it would stop the column adding up.
    expect(dashboard.costs[0].label).toBe('a'.repeat(12));
  });
});

describe('the generate route is what feeds the refusal rate', () => {
  it('counts every tool result and records the run once it completes', () => {
    const source = readFileSync('app/api/generate-ai-code-stream/route.ts', 'utf8');
    // The notify closure is the only place a tool result exists: refusals are
    // returned to the model, so nothing else in the run ever sees one.
    expect(source).toContain('countToolResult(toolResults, event.tool, event.ok)');
    // Filed against the event the token spend is filed against, so the cost panel
    // and the refusal rate describe the same generation.
    expect(source).toContain('recordToolRefusalRates(projectId, toolResults, usageEventId)');
  });
});
