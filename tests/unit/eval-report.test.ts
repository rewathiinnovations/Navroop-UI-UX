import { describe, expect, it } from 'vitest';
import {
  diffVerdicts,
  formatToolTally,
  mergeToolTallies,
  modelsForRun,
  parseRunFile,
  priorRunFilesNewestFirst,
  renderModelMatrix,
  tallyToolOutcomes,
} from '../../scripts/eval-report';

/**
 * The scoring half of the paid prompt eval, which is the half nobody can afford to
 * test by running it.
 *
 * `scripts/eval-prompts.ts` is twelve live generations per model against a metered
 * provider, so every decision it makes that does *not* need a model — which models
 * a sweep covers, how tool calls are tallied, how a run is diffed against the last
 * one — lives in `scripts/eval-report.ts` and is exercised here instead.
 *
 * Three of these guard properties the harness would otherwise lose silently:
 *
 * 1. A bare `--live` must still be one model. The recorded 9/12 baseline in
 *    `docs/build-autofix.md` was measured against the configured primary alone, and
 *    a default that swept every model would leave that number comparable to nothing
 *    while tripling the bill.
 * 2. A refused tool call must be counted as refused, not as an error and not at all.
 *    `lib/generation/tools/index.ts` *returns* its refusals rather than throwing, so
 *    they are invisible to anything that only looks at what threw.
 * 3. `parseRunFile` must still read a results file written before the tool tallies
 *    existed — the 2026-08-27 baseline is such a file, and it is the one run every
 *    future run is measured against.
 */

const OFFERED = ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp'];

describe('modelsForRun', () => {
  it('runs the configured model alone without a sweep flag', () => {
    expect(modelsForRun(['--live'], { configured: 'deepseek-v4-flash', offered: OFFERED })).toEqual(
      { models: ['deepseek-v4-flash'], unknown: [] },
    );
  });

  it('leads --all-models with the configured model and drops the duplicate', () => {
    expect(
      modelsForRun(['--live', '--all-models'], {
        configured: 'deepseek-v4-pro',
        offered: OFFERED,
      }),
    ).toEqual({
      models: ['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'],
      unknown: [],
    });
  });

  it('takes an explicit list over --all-models, so a sweep can be narrowed to two', () => {
    expect(
      modelsForRun(['--live', '--all-models', '--models=deepseek-v4-pro,deepseek-v4-flash'], {
        configured: 'deepseek-v4-flash',
        offered: OFFERED,
      }),
    ).toEqual({ models: ['deepseek-v4-pro', 'deepseek-v4-flash'], unknown: [] });
  });

  it('reports an unknown id separately instead of silently sweeping the rest', () => {
    const selection = modelsForRun(['--live', '--models=deepseek-v4-pro,gpt-4'], {
      configured: 'deepseek-v4-flash',
      offered: OFFERED,
    });
    expect(selection.models).toEqual(['deepseek-v4-pro']);
    expect(selection.unknown).toEqual(['gpt-4']);
  });

  /**
   * `resolveModel` returns `AI_PRIMARY_MODEL` verbatim without checking it against
   * `DEEPSEEK_MODELS`, so a deployment can legally be serving an id the dropdown
   * does not offer. Refusing to sweep the model actually in production would be the
   * wrong answer.
   */
  it('accepts the configured model even when it is not on the offered list', () => {
    expect(
      modelsForRun(['--live', '--models=deepseek-v9-unreleased'], {
        configured: 'deepseek-v9-unreleased',
        offered: OFFERED,
      }),
    ).toEqual({ models: ['deepseek-v9-unreleased'], unknown: [] });
  });
});

describe('tallyToolOutcomes', () => {
  it('separates a refusal from a success on the same tool', () => {
    const tally = tallyToolOutcomes({
      calls: ['write_file', 'edit_file', 'edit_file', 'read_file'],
      results: [
        { tool: 'write_file', ok: true },
        { tool: 'edit_file', ok: false },
        { tool: 'edit_file', ok: true },
        { tool: 'read_file', ok: true },
      ],
    });
    expect(tally.byTool.edit_file).toEqual({ calls: 2, ok: 1, refused: 1, error: 0 });
    expect(tally.byTool.write_file).toEqual({ calls: 1, ok: 1, refused: 0, error: 0 });
    expect(tally.totals).toEqual({ calls: 4, ok: 3, refused: 1, error: 0 });
  });

  /**
   * A call whose arguments fail schema validation never reaches `execute`, so it
   * emits no notify event at all. It is only visible as the difference between what
   * the model asked for and what the store answered — which is precisely the failure
   * a change to the tool surface is most likely to introduce.
   */
  it('counts a call the tool surface never answered as an error', () => {
    const tally = tallyToolOutcomes({
      calls: ['edit_file', 'edit_file', 'edit_file'],
      results: [{ tool: 'edit_file', ok: true }],
    });
    expect(tally.byTool.edit_file).toEqual({ calls: 3, ok: 1, refused: 0, error: 2 });
  });

  it('never reports a negative error count when more results arrive than calls', () => {
    const tally = tallyToolOutcomes({
      calls: [],
      results: [
        { tool: 'write_file', ok: true },
        { tool: 'write_file', ok: false },
      ],
    });
    expect(tally.byTool.write_file).toEqual({ calls: 2, ok: 1, refused: 1, error: 0 });
  });

  it('sorts tools by name so two runs produce a comparable JSON diff', () => {
    const tally = tallyToolOutcomes({
      calls: ['write_file', 'add_dependency', 'read_file'],
      results: [],
    });
    expect(Object.keys(tally.byTool)).toEqual(['add_dependency', 'read_file', 'write_file']);
  });
});

describe('mergeToolTallies', () => {
  it('sums the same tool across cases', () => {
    const first = tallyToolOutcomes({
      calls: ['write_file', 'edit_file'],
      results: [
        { tool: 'write_file', ok: true },
        { tool: 'edit_file', ok: false },
      ],
    });
    const second = tallyToolOutcomes({
      calls: ['write_file'],
      results: [{ tool: 'write_file', ok: true }],
    });
    const merged = mergeToolTallies([first, second]);
    expect(merged.byTool.write_file).toEqual({ calls: 2, ok: 2, refused: 0, error: 0 });
    expect(merged.byTool.edit_file).toEqual({ calls: 1, ok: 0, refused: 1, error: 0 });
    expect(merged.totals).toEqual({ calls: 3, ok: 2, refused: 1, error: 0 });
  });

  it('is empty for a run that called nothing', () => {
    expect(mergeToolTallies([])).toEqual({
      byTool: {},
      totals: { calls: 0, ok: 0, refused: 0, error: 0 },
    });
  });
});

describe('formatToolTally', () => {
  it('omits the zero counters so the refusals are the part that stands out', () => {
    const line = formatToolTally(
      tallyToolOutcomes({
        calls: ['write_file', 'write_file', 'write_file', 'write_file', 'edit_file', 'edit_file'],
        results: [
          { tool: 'write_file', ok: true },
          { tool: 'write_file', ok: true },
          { tool: 'write_file', ok: true },
          { tool: 'write_file', ok: true },
          { tool: 'edit_file', ok: false },
          { tool: 'edit_file', ok: false },
        ],
      }),
    );
    expect(line).toBe('edit_file 2 refused; write_file 4 ok');
  });

  it('prints nothing at all for a case that called no tool', () => {
    expect(formatToolTally(tallyToolOutcomes({ calls: [], results: [] }))).toBe('');
  });
});

describe('priorRunFilesNewestFirst', () => {
  /**
   * The names are `toISOString()` with `:` and `.` replaced by `-`, a fixed-width
   * format whose lexicographic order is its chronological order — so no `stat` is
   * needed, and an mtime rewritten by a copy or a checkout cannot reorder history.
   */
  it('orders by the timestamp in the name, newest first', () => {
    expect(
      priorRunFilesNewestFirst([
        '2026-08-27T10-53-08-055Z.json',
        '2026-08-29T09-01-00-000Z.json',
        '2026-08-27T09-12-44-001Z.json',
      ]),
    ).toEqual([
      '2026-08-29T09-01-00-000Z.json',
      '2026-08-27T10-53-08-055Z.json',
      '2026-08-27T09-12-44-001Z.json',
    ]);
  });

  it('skips the files this run wrote, so a sweep cannot diff against itself', () => {
    expect(
      priorRunFilesNewestFirst(
        [
          '2026-08-29T09-00-00-000Z--deepseek-v4-flash.json',
          '2026-08-29T09-00-00-000Z--deepseek-v4-pro.json',
          '2026-08-27T10-53-08-055Z.json',
        ],
        ['2026-08-29T09-00-00-000Z--deepseek-v4-flash.json'],
      ),
    ).toEqual(['2026-08-29T09-00-00-000Z--deepseek-v4-pro.json', '2026-08-27T10-53-08-055Z.json']);
  });

  it('ignores anything that is not a results file', () => {
    expect(priorRunFilesNewestFirst(['notes.md', '2026-08-27T10-53-08-055Z.json'])).toEqual([
      '2026-08-27T10-53-08-055Z.json',
    ]);
  });
});

describe('parseRunFile', () => {
  /** The shape written on 2026-08-27, before tool tallies or a recorded baseline existed. */
  const HISTORIC = {
    at: '2026-08-27T10:53:08.055Z',
    model: 'deepseek-v4-flash',
    thinking: false,
    passed: 2,
    total: 3,
    rate: 67,
    tokensIn: 1_340_000,
    tokensOut: 52_000,
    results: [
      { id: 'first-build-cafe', passed: true, files: ['app/page.tsx'], buildStatus: 'passed' },
      { id: 'pricing-page', passed: false, failures: ['matched forbidden pattern /\\$0\\b/i'] },
      { id: 'dark-mode', passed: true },
    ],
  };

  it('reads a file written before the tool tallies existed', () => {
    const run = parseRunFile('2026-08-27T10-53-08-055Z.json', HISTORIC);
    expect(run).not.toBeNull();
    expect(run?.model).toBe('deepseek-v4-flash');
    expect(run?.passed).toBe(2);
    expect(run?.total).toBe(3);
    expect(run?.verdicts).toEqual([
      { id: 'first-build-cafe', passed: true },
      { id: 'pricing-page', passed: false },
      { id: 'dark-mode', passed: true },
    ]);
  });

  it('derives the totals when the file omits them', () => {
    const run = parseRunFile('run.json', {
      results: [
        { id: 'a', passed: true },
        { id: 'b', passed: false },
      ],
    });
    expect(run?.passed).toBe(1);
    expect(run?.total).toBe(2);
    expect(run?.model).toBe('');
  });

  /**
   * A truncated file from an interrupted run sits in the same directory. Treating it
   * as the most recent run would suppress the comparison against the real one.
   */
  it('rejects a file with no scored case rather than returning an empty baseline', () => {
    expect(parseRunFile('run.json', { results: [] })).toBeNull();
    expect(parseRunFile('run.json', { results: [{ id: 'a' }] })).toBeNull();
    expect(parseRunFile('run.json', { model: 'deepseek-v4-flash' })).toBeNull();
    expect(parseRunFile('run.json', null)).toBeNull();
    expect(parseRunFile('run.json', [1, 2, 3])).toBeNull();
  });
});

describe('diffVerdicts', () => {
  it('names what moved and counts what did not', () => {
    const diff = diffVerdicts(
      [
        { id: 'first-build-cafe', passed: true },
        { id: 'pricing-page', passed: false },
        { id: 'dark-mode', passed: true },
        { id: 'ambiguous-one-word', passed: false },
      ],
      [
        { id: 'first-build-cafe', passed: true },
        { id: 'pricing-page', passed: true },
        { id: 'dark-mode', passed: false },
        { id: 'ambiguous-one-word', passed: false },
      ],
    );
    expect(diff.newlyPassing).toEqual(['pricing-page']);
    expect(diff.newlyFailing).toEqual(['dark-mode']);
    expect(diff.unchangedPassing).toEqual(['first-build-cafe']);
    expect(diff.unchangedFailing).toEqual(['ambiguous-one-word']);
  });

  /**
   * A rate that holds at 9/12 while two cases swap places is the change worth
   * arguing about, and it is exactly what a pass rate on its own cannot show.
   */
  it('reports a swap that leaves the pass rate identical', () => {
    const diff = diffVerdicts(
      [
        { id: 'a', passed: true },
        { id: 'b', passed: false },
      ],
      [
        { id: 'a', passed: false },
        { id: 'b', passed: true },
      ],
    );
    expect(diff.newlyPassing).toEqual(['b']);
    expect(diff.newlyFailing).toEqual(['a']);
    expect(diff.unchangedPassing).toEqual([]);
    expect(diff.unchangedFailing).toEqual([]);
  });

  it('keeps a case the two runs do not share out of the pass and fail counts', () => {
    const diff = diffVerdicts(
      [
        { id: 'kept', passed: true },
        { id: 'deleted-case', passed: false },
      ],
      [
        { id: 'kept', passed: true },
        { id: 'brand-new-case', passed: false },
      ],
    );
    expect(diff.added).toEqual(['brand-new-case']);
    expect(diff.removed).toEqual(['deleted-case']);
    expect(diff.newlyFailing).toEqual([]);
    expect(diff.unchangedPassing).toEqual(['kept']);
  });
});

describe('renderModelMatrix', () => {
  const LINES = renderModelMatrix([
    {
      model: 'deepseek-v4-flash',
      verdicts: [
        { id: 'first-build-cafe', passed: true },
        { id: 'pricing-page', passed: false },
      ],
    },
    {
      model: 'deepseek-v4-flash-vision-exp',
      verdicts: [{ id: 'first-build-cafe', passed: true }],
    },
  ]);

  /**
   * `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` share their first
   * seventeen characters, so a truncated header would title two columns identically
   * and the table would no longer say which model scored what.
   */
  it('prints both model ids in full', () => {
    expect(LINES[0]).toContain('deepseek-v4-flash ');
    expect(LINES[0]).toContain('deepseek-v4-flash-vision-exp');
  });

  it('marks a case a model did not run as absent rather than failed', () => {
    const row = LINES.find((line) => line.startsWith('pricing-page'));
    expect(row).toMatch(/FAIL\s+-\s*$/);
  });

  it('ends with a per-model pass rate over what that model actually ran', () => {
    expect(LINES[LINES.length - 1]).toMatch(/^pass rate\s+1\/2\s+1\/1\s*$/);
  });

  /**
   * `pass rate` is wider than a short case id, so a first column sized only to the
   * ids would let the footer push its own numbers out of the columns they belong to.
   */
  it('keeps the columns aligned when every case id is shorter than the footer label', () => {
    const lines = renderModelMatrix([
      { model: 'deepseek-v4-flash', verdicts: [{ id: 'ab', passed: true }] },
      { model: 'deepseek-v4-pro', verdicts: [{ id: 'ab', passed: false }] },
    ]);
    // The first column is `'pass rate'.length + 2`, so the first model column begins
    // at the same character on the header, the case row and the footer alike.
    expect(lines.map((line) => line.slice(0, 11))).toEqual([
      'case       ',
      'ab         ',
      'pass rate  ',
    ]);
    expect(lines[0].slice(11)).toMatch(/^deepseek-v4-flash /);
    expect(lines[1].slice(11)).toMatch(/^PASS /);
    expect(lines[2].slice(11)).toMatch(/^1\/1 /);
  });
});
