/**
 * The half of the prompt eval harness that costs nothing to run.
 *
 * `scripts/eval-prompts.ts` calls `main()` at import time and needs a database, a
 * provider key and twelve live generations, so nothing in it can be unit-tested.
 * Everything here — which models a sweep covers, how tool calls are tallied, how
 * one run is diffed against the last — is a decision the harness makes *about*
 * results rather than a way of producing them, and a scoring rule nobody can
 * exercise is a scoring rule nobody should trust. `tests/unit/eval-report.test.ts`
 * exercises these directly, without a token being spent.
 */

/** Every model in `DEEPSEEK_MODELS` that can call tools, plus the configured one. */
export const ALL_MODELS_FLAG = '--all-models';
/** `--models=deepseek-v4-flash,deepseek-v4-pro` — the cost control on the sweep. */
export const MODELS_FLAG = '--models=';

export type ModelSelection = {
  models: string[];
  /** Ids named on the command line that the product does not offer. */
  unknown: string[];
};

export type ToolOutcomeCounts = {
  calls: number;
  ok: number;
  refused: number;
  error: number;
};

export type ToolTally = {
  byTool: Record<string, ToolOutcomeCounts>;
  totals: ToolOutcomeCounts;
};

export type RunVerdict = { id: string; passed: boolean };

/** A results file from an earlier run, reduced to what a diff needs. */
export type BaselineRun = {
  file: string;
  at: string;
  model: string;
  passed: number;
  total: number;
  verdicts: RunVerdict[];
};

export type BaselineDiff = {
  newlyPassing: string[];
  newlyFailing: string[];
  unchangedPassing: string[];
  unchangedFailing: string[];
  /** Cases this run scored that the baseline never saw. */
  added: string[];
  /** Cases the baseline scored that this run did not. */
  removed: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function emptyCounts(): ToolOutcomeCounts {
  return { calls: 0, ok: 0, refused: 0, error: 0 };
}

/** Stable key order, so two runs of the same case produce a comparable JSON diff. */
function sortedByKey(
  entries: Record<string, ToolOutcomeCounts>,
): Record<string, ToolOutcomeCounts> {
  const sorted: Record<string, ToolOutcomeCounts> = {};
  for (const key of Object.keys(entries).sort()) sorted[key] = entries[key];
  return sorted;
}

function sumCounts(rows: readonly ToolOutcomeCounts[]): ToolOutcomeCounts {
  return rows.reduce<ToolOutcomeCounts>(
    (total, row) => ({
      calls: total.calls + row.calls,
      ok: total.ok + row.ok,
      refused: total.refused + row.refused,
      error: total.error + row.error,
    }),
    emptyCounts(),
  );
}

/**
 * Which models one sweep covers.
 *
 * A bare `--live` still runs exactly one model — the configured primary, resolved
 * the way generation resolves it — because the recorded 9/12 baseline in
 * `docs/build-autofix.md` was measured that way. A default that silently swept
 * three models would triple the bill and leave that number comparable to nothing.
 *
 * The axis is MODEL rather than provider: `ProviderName` is a one-member union
 * (`'deepseek'`), so there is no provider to vary.
 *
 * `--models=` is validated against the configured id as well as the offered list,
 * because `resolveModel` returns `AI_PRIMARY_MODEL` verbatim without checking it
 * against `DEEPSEEK_MODELS` — a deployment can legally be running an id that is
 * not on the dropdown, and refusing to sweep the model actually in production
 * would be the wrong answer.
 */
export function modelsForRun(
  argv: readonly string[],
  options: { configured: string; offered: readonly string[] },
): ModelSelection {
  const named = argv
    .filter((arg) => arg.startsWith(MODELS_FLAG))
    .flatMap((arg) => arg.slice(MODELS_FLAG.length).split(','))
    .map((value) => value.trim())
    .filter(Boolean);
  if (named.length > 0) {
    const known = new Set<string>([options.configured, ...options.offered]);
    return {
      models: dedupe(named.filter((model) => known.has(model))),
      unknown: dedupe(named.filter((model) => !known.has(model))),
    };
  }
  // The configured model leads the sweep so its results file is the one that lines
  // up with the recorded baseline for the deployment.
  if (argv.includes(ALL_MODELS_FLAG)) {
    return { models: dedupe([options.configured, ...options.offered]), unknown: [] };
  }
  return { models: [options.configured], unknown: [] };
}

/**
 * What the model asked the tool surface to do, and what it got back.
 *
 * Two sources, because neither alone is the whole picture. `step.toolCalls` is the
 * authoritative list of *requests*: it includes a call whose arguments failed
 * schema validation, which never reaches `execute` and therefore never emits a
 * notify event at all. The notify events are the only source for ok-versus-refused,
 * because `lib/generation/tools/index.ts` deliberately *returns* its refusals as
 * ordinary tool output ("search appears 3 times in app/page.tsx") so the model can
 * correct itself on the next step — which makes a refused edit and a successful one
 * the same `tool-result` part as far as the SDK is concerned.
 *
 * `error` is the remainder rather than a fourth source: a call the tool surface
 * never answered. Unparsable arguments, a tool name that does not exist, a throw
 * inside `execute`, a step the provider abandoned — all of them land there, and all
 * of them were invisible while the harness passed `notify: () => {}` and collapsed
 * each case to a boolean.
 */
export function tallyToolOutcomes(input: {
  calls: readonly string[];
  results: readonly { tool: string; ok: boolean }[];
}): ToolTally {
  const byTool: Record<string, ToolOutcomeCounts> = {};
  const bucket = (tool: string): ToolOutcomeCounts => {
    const existing = byTool[tool];
    if (existing) return existing;
    const created = emptyCounts();
    byTool[tool] = created;
    return created;
  };

  for (const tool of input.calls) bucket(tool).calls += 1;
  for (const result of input.results) {
    const counts = bucket(result.tool);
    if (result.ok) counts.ok += 1;
    else counts.refused += 1;
  }
  // The two sources are counted independently, so a provider that reported fewer
  // calls than the store actually answered must not manufacture a negative error
  // count. The answered calls are the floor.
  for (const counts of Object.values(byTool)) {
    counts.calls = Math.max(counts.calls, counts.ok + counts.refused);
    counts.error = counts.calls - counts.ok - counts.refused;
  }

  return { byTool: sortedByKey(byTool), totals: sumCounts(Object.values(byTool)) };
}

export function emptyToolTally(): ToolTally {
  return { byTool: {}, totals: emptyCounts() };
}

/** The run-level tally: the same counters summed over every case. */
export function mergeToolTallies(tallies: readonly ToolTally[]): ToolTally {
  const byTool: Record<string, ToolOutcomeCounts> = {};
  for (const tally of tallies) {
    for (const [tool, counts] of Object.entries(tally.byTool)) {
      byTool[tool] = sumCounts([byTool[tool] ?? emptyCounts(), counts]);
    }
  }
  return { byTool: sortedByKey(byTool), totals: sumCounts(Object.values(byTool)) };
}

/**
 * One line of tool outcomes, or `''` when the case called no tool at all.
 *
 * Zero counters are omitted: a case whose every write landed should read
 * `write_file 4 ok`, not a wall of noughts that hides the one line that matters.
 * An empty string is the caller's signal to print nothing — and a case that wrote
 * files while reporting no calls is itself a finding, so this never invents a row.
 */
export function formatToolTally(tally: ToolTally): string {
  const parts: string[] = [];
  for (const [tool, counts] of Object.entries(tally.byTool)) {
    const outcomes: string[] = [];
    if (counts.ok > 0) outcomes.push(`${counts.ok} ok`);
    if (counts.refused > 0) outcomes.push(`${counts.refused} refused`);
    if (counts.error > 0) outcomes.push(`${counts.error} error`);
    if (outcomes.length === 0) continue;
    parts.push(`${tool} ${outcomes.join(', ')}`);
  }
  return parts.join('; ');
}

/**
 * Prior result files, newest first.
 *
 * The names are `toISOString()` with `:` and `.` swapped for `-`, a fixed-width
 * format whose lexicographic order *is* its chronological order — so this needs no
 * `stat` call, which matters because the run being compared against may be months
 * old and an mtime is rewritten by any copy or checkout that touched the file.
 *
 * `exclude` is the files this process has already written: without it a sweep's
 * second model would consider the first model's fresh file, and a re-run would diff
 * against itself.
 */
export function priorRunFilesNewestFirst(
  names: readonly string[],
  exclude: readonly string[] = [],
): string[] {
  const skip = new Set(exclude);
  return names
    .filter((name) => name.endsWith('.json') && !skip.has(name))
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
}

/**
 * An earlier results file reduced to its verdicts, or `null` if it is not one.
 *
 * Defensive on every field because the input is a file on disk that a previous
 * version of this harness wrote — the 2026-08-27 baseline predates the `tools`
 * key and knows nothing about it, and a run killed halfway through leaves a
 * truncated file in the same directory. A file with no scored case returns `null`
 * rather than an empty baseline: it cannot produce a delta, so treating it as the
 * most recent run would silently suppress the comparison.
 */
export function parseRunFile(file: string, raw: unknown): BaselineRun | null {
  if (!isRecord(raw) || !Array.isArray(raw.results)) return null;
  const verdicts: RunVerdict[] = [];
  for (const row of raw.results) {
    if (!isRecord(row)) continue;
    if (typeof row.id !== 'string' || typeof row.passed !== 'boolean') continue;
    verdicts.push({ id: row.id, passed: row.passed });
  }
  if (verdicts.length === 0) return null;
  return {
    file,
    at: typeof raw.at === 'string' ? raw.at : '',
    model: typeof raw.model === 'string' ? raw.model : '',
    passed:
      typeof raw.passed === 'number'
        ? raw.passed
        : verdicts.filter((verdict) => verdict.passed).length,
    total: typeof raw.total === 'number' ? raw.total : verdicts.length,
    verdicts,
  };
}

/**
 * What changed since the last run of this model.
 *
 * A pass rate on its own says a run scored 9/12; it does not say whether it is the
 * *same* 9. Two prompt edits that both hold the rate steady while swapping which
 * cases fail are the change worth arguing about, and until this existed the results
 * files were written and never read.
 *
 * Cases the two runs do not share are reported separately rather than counted as a
 * change: adding a thirteenth case is not a regression, and deleting one is not a
 * fix.
 */
export function diffVerdicts(
  previous: readonly RunVerdict[],
  current: readonly RunVerdict[],
): BaselineDiff {
  const before = new Map(previous.map((verdict) => [verdict.id, verdict.passed]));
  const now = new Map(current.map((verdict) => [verdict.id, verdict.passed]));
  const diff: BaselineDiff = {
    newlyPassing: [],
    newlyFailing: [],
    unchangedPassing: [],
    unchangedFailing: [],
    added: [],
    removed: [],
  };
  for (const verdict of current) {
    const was = before.get(verdict.id);
    if (was === undefined) diff.added.push(verdict.id);
    else if (was === verdict.passed) {
      (verdict.passed ? diff.unchangedPassing : diff.unchangedFailing).push(verdict.id);
    } else (verdict.passed ? diff.newlyPassing : diff.newlyFailing).push(verdict.id);
  }
  for (const verdict of previous) {
    if (!now.has(verdict.id)) diff.removed.push(verdict.id);
  }
  return diff;
}

/**
 * The per-model table, one row per case.
 *
 * Model ids are never truncated to fit a column. `deepseek-v4-flash` and
 * `deepseek-v4-flash-vision-exp` share their first seventeen characters, so a fixed
 * narrow header would print two columns with identical titles — a table in which
 * the reader cannot tell which model scored what is worse than no table.
 *
 * A case a model did not run reads `-`, not `FAIL`: an interrupted sweep must not
 * look like a regression.
 */
const RATE_LABEL = 'pass rate';

export function renderModelMatrix(
  runs: readonly { model: string; verdicts: readonly RunVerdict[] }[],
): string[] {
  const ids: string[] = [];
  for (const run of runs) {
    for (const verdict of run.verdicts) if (!ids.includes(verdict.id)) ids.push(verdict.id);
  }
  // `pass rate` is in the max because it is the widest thing in the first column
  // whenever the case ids are short, and a footer that overflows its own column
  // shifts every model heading on that one line out of alignment with its data.
  const labelWidth = Math.max(RATE_LABEL.length, ...ids.map((id) => id.length)) + 2;
  const widths = runs.map((run) => Math.max(run.model.length, 6) + 2);
  const cell = (value: string, width: number) => value.padEnd(width);

  const lines = [
    cell('case', labelWidth) + runs.map((run, i) => cell(run.model, widths[i])).join(''),
  ];
  for (const id of ids) {
    const row = runs.map((run, i) => {
      const verdict = run.verdicts.find((entry) => entry.id === id);
      return cell(verdict === undefined ? '-' : verdict.passed ? 'PASS' : 'FAIL', widths[i]);
    });
    lines.push(cell(id, labelWidth) + row.join(''));
  }
  const rates = runs.map((run, i) => {
    const passed = run.verdicts.filter((verdict) => verdict.passed).length;
    return cell(`${passed}/${run.verdicts.length}`, widths[i]);
  });
  lines.push(cell(RATE_LABEL, labelWidth) + rates.join(''));
  // The padding on the last column is what made every row end in a ragged tail of
  // spaces, which a terminal shows only when someone selects the output and a diff
  // of two saved runs shows as a change on every line.
  return lines.map((line) => line.trimEnd());
}
