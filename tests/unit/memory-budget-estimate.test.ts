/**
 * F-110: `selectWithinBudget` measured every candidate row by re-rendering the whole
 * accumulated selection and estimating tokens over the result — O(n^2) in block length, on
 * the generation hot path and on every Brain-panel render. The cost must not scale with the
 * number of candidate rows, and the selection it produces must stay exactly the greedy,
 * maximal one the full re-render produced.
 */
import { describe, expect, it, vi } from 'vitest';
import { estimateTokens } from '@/lib/generation/token-estimate';
import { renderMemoryBlock } from '@/lib/memory/build-context';
import { MEMORY_CATEGORIES, MEMORY_TOKEN_BUDGET, type MemoryRecord } from '@/lib/memory/types';

const tokenEstimateCalls = { count: 0 };

vi.mock('@/lib/generation/token-estimate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/generation/token-estimate')>();
  return {
    ...actual,
    estimateTokens: (text: string) => {
      tokenEstimateCalls.count += 1;
      return actual.estimateTokens(text);
    },
  };
});

function entry(
  partial: Partial<MemoryRecord> & Pick<MemoryRecord, 'id' | 'content'>,
): MemoryRecord {
  return {
    scope: 'PROJECT',
    projectId: 'proj_1',
    category: 'design',
    source: 'manual',
    status: 'ACTIVE',
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    ...partial,
  };
}

/** Deterministic pseudo-random rows: mixed scopes, categories and lengths. */
function rows(count: number, seed: number): MemoryRecord[] {
  let state = seed;
  const next = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  return Array.from({ length: count }, (_, index) => {
    const workspace = next() < 0.5;
    const words = 1 + Math.floor(next() * 40);
    return entry({
      id: `row-${index}`,
      scope: workspace ? 'WORKSPACE' : 'PROJECT',
      projectId: workspace ? null : 'proj_1',
      category: MEMORY_CATEGORIES[Math.floor(next() * MEMORY_CATEGORIES.length)],
      content: `row-${index} ${'durable preference '.repeat(words)}`,
      createdAt: new Date(Date.UTC(2026, 7, 1, 0, index)),
    });
  });
}

/** Rows carry their id as the first word, so the block names exactly what was selected. */
function isSelected(block: string, row: MemoryRecord) {
  return block.includes(`- ${row.id} durable`);
}

function estimateCallsFor(entries: MemoryRecord[]) {
  tokenEstimateCalls.count = 0;
  renderMemoryBlock(entries);
  return tokenEstimateCalls.count;
}

describe('budget selection does not re-render the block per candidate (F-110)', () => {
  it('costs the same number of token estimates for 20 rows as for 400', () => {
    expect(estimateCallsFor(rows(400, 7))).toBe(estimateCallsFor(rows(20, 7)));
  });

  it('estimates the rendered block exactly once per render', () => {
    expect(estimateCallsFor(rows(200, 3))).toBe(1);
  });
});

describe('the incremental estimate selects exactly what a full re-render selected (F-110)', () => {
  const cases = [rows(6, 11), rows(40, 12), rows(120, 13), rows(400, 14)];

  it('reports a token estimate that matches the block it returned, inside the budget', () => {
    for (const entries of cases) {
      const result = renderMemoryBlock(entries);
      expect(result.tokenEstimate).toBe(estimateTokens(result.block));
      expect(result.tokenEstimate).toBeLessThanOrEqual(MEMORY_TOKEN_BUDGET);
    }
  });

  it('keeps the selection maximal: every rejected row would break the budget', () => {
    for (const entries of cases) {
      const { block, truncated } = renderMemoryBlock(entries);
      const selected = entries.filter((row) => isSelected(block, row));
      const rejected = entries.filter((row) => !isSelected(block, row));

      expect(selected.length).toBeGreaterThan(0);
      expect(truncated).toBe(rejected.length > 0);
      // The selection on its own fits, so the estimate never over-counted a kept row.
      expect(renderMemoryBlock(selected).truncated).toBe(false);
      // Adding any single rejected row no longer fits, so it never under-counted either.
      for (const row of rejected) {
        expect(renderMemoryBlock([...selected, row]).truncated).toBe(true);
      }
    }
  });
});
