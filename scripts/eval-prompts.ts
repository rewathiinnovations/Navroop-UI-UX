/**
 * The paid tier of the prompt regression net.
 *
 * The free tier is `tests/unit/stable-prompt-prefix.test.ts`: it snapshots the
 * system prompt so an edit lands as a reviewable diff. What it cannot tell you is
 * whether the edit made the *output* better or worse. This runs the real prompt
 * assembly against the real model on a fixed case set and scores the results with
 * machinery that already decides these questions in production — `checkBuild` for
 * "does it compile", the file store for "how many files", a regex sweep for the
 * anti-slop patterns the prompts exist to prevent.
 *
 *   node ./node_modules/tsx/dist/cli.mjs scripts/eval-prompts.ts --live
 *
 * **It refuses to run without `--live`**, because a run is twelve generations
 * against a metered provider. Nothing schedules it: it is deliberately absent from
 * `VERIFY_STEPS` in `lib/verify/orchestrator.ts`, since a gate that costs money per
 * invocation is a gate people learn to skip. Run it by hand when a prompt changes,
 * and compare the pass rate with the last recorded baseline.
 *
 * Results are written to `tmp/eval/<ISO timestamp>.json` (gitignored) alongside a
 * printed table. The JSON carries every case's files, tokens, tool outcomes and
 * failures, so a regression can be read after the fact rather than re-run — and
 * each run is diffed against the most recent earlier run of the same model, so the
 * output says what *changed* rather than only what happened.
 *
 * The provider is resolved exactly as generation resolves it — the effective-env
 * overlay, the provider chain, the chat-completions model — so a score here is
 * about the configured deployment, not about DeepSeek in general. `--all-models`
 * (or `--models=a,b`) repeats the case set across the offered models and prints
 * them side by side; it multiplies the bill by the number of models, which is why
 * a bare `--live` still runs the configured one alone.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from 'dotenv';
import { generateText, stepCountIs } from 'ai';
import { chatModelForEntry, thinkingEnabledFromEnv } from '../lib/ai/client-for-entry';
import { loadEffectiveProviderEnv } from '../lib/ai/effective-env';
import {
  DEEPSEEK_MODELS,
  loadProviderChain,
  modelSupportsTools,
  type ProviderEntry,
} from '../lib/ai/providers';
import { temperatureForModel } from '../lib/ai/temperature';
import { buildCachedMessages } from '../lib/generation/prompt-cache';
import { buildGenerationTools } from '../lib/generation/tools';
import { createGenerationFileStore } from '../lib/generation/tools/file-store';
import { wrapUserRequest } from '../lib/generation/user-prompt';
import { buildStablePromptPrefix, buildVolatilePromptSuffix } from '../lib/stack-prompts';
import { isStackId, type StackId } from '../lib/stacks';
import { withStarterFiles } from '../lib/stacks/starter';
import { checkBuild } from '../lib/validation/build-check';
import { prisma } from '../lib/db';
import {
  ALL_MODELS_FLAG,
  MODELS_FLAG,
  diffVerdicts,
  emptyToolTally,
  formatToolTally,
  mergeToolTallies,
  modelsForRun,
  parseRunFile,
  priorRunFilesNewestFirst,
  renderModelMatrix,
  tallyToolOutcomes,
  type BaselineDiff,
  type BaselineRun,
  type RunVerdict,
  type ToolTally,
} from './eval-report';

config({ path: '.env' });
config({ path: '.env.local', override: true });

const CASES_PATH = join(
  dirname(new URL(import.meta.url).pathname.slice(1)),
  'prompt-eval-cases.json',
);
/** Enough for a multi-page first build; the same ceiling a real generation gets. */
const MAX_STEPS = 24;
const MAX_OUTPUT_TOKENS = 16_000;

type EvalCase = {
  id: string;
  prompt: string;
  stack: string;
  designDirection: string;
  expectFiles: number;
  mustNotMatch: string[];
  /**
   * Files the project already has when the case runs.
   *
   * Load-bearing for every edit-shaped case. Without it the store starts empty, so
   * "change the hero heading" and "fix the navbar on mobile" are handed a project
   * that does not exist — and the model correctly builds a whole site, which the
   * `expectFiles` floor then reads as a pass and `mustNotMatch` judges against
   * copy nobody asked for. The first recorded baseline (6/12, 2026-08-27) was
   * measured before this field existed and is therefore a baseline for the
   * first-build cases only; the edit cases were measuring the harness.
   *
   * `isEdit` follows from it, so the volatile suffix carries the edit rules the
   * real route sends on a follow-up.
   */
  seedFiles?: Record<string, string>;
};
type CaseResult = {
  id: string;
  stack: string;
  designDirection: string;
  passed: boolean;
  failures: string[];
  files: string[];
  fileCount: number;
  expectFiles: number;
  buildStatus: string;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
  reply: string;
  error: string | null;
  /**
   * Every tool the model called, by tool and by outcome.
   *
   * A pass/fail plus a file count cannot distinguish a run that wrote four files
   * in four clean steps from one that spent half its step budget being refused,
   * and the refusals are the half a prompt or a tolerance change can move. This
   * is the instrument that decides whether such a change was worth shipping.
   */
  tools: ToolTally;
};

function readCases(): EvalCase[] {
  const parsed: unknown = JSON.parse(readFileSync(CASES_PATH, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`${CASES_PATH} is not a JSON array`);
  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new Error(`case ${index} is not an object`);
    const row: Record<string, unknown> = { ...entry };
    const id = typeof row.id === 'string' ? row.id : '';
    const prompt = typeof row.prompt === 'string' ? row.prompt : '';
    const stack = typeof row.stack === 'string' ? row.stack : '';
    const designDirection =
      typeof row.designDirection === 'string' ? row.designDirection : 'minimal';
    const expectFiles = typeof row.expectFiles === 'number' ? row.expectFiles : 0;
    const mustNotMatch = Array.isArray(row.mustNotMatch)
      ? row.mustNotMatch.filter((value): value is string => typeof value === 'string')
      : [];
    const seedRow = row.seedFiles;
    const seedFiles =
      seedRow && typeof seedRow === 'object' && !Array.isArray(seedRow)
        ? Object.fromEntries(
            Object.entries(seedRow).filter(
              (pair): pair is [string, string] => typeof pair[1] === 'string',
            ),
          )
        : undefined;
    if (!id || !prompt || !isStackId(stack)) {
      throw new Error(`case ${index} needs id, prompt and a known stack (got "${stack}")`);
    }
    return { id, prompt, stack, designDirection, expectFiles, mustNotMatch, seedFiles };
  });
}

/**
 * One case, run through the same assembly the generate route uses.
 *
 * Deliberately not a call to the route: the route needs a session, a project row,
 * a job and credits. What is under test is the prompt and the tool surface, and
 * those are library functions.
 */
async function runCase(
  entry: ProviderEntry,
  providerEnv: Record<string, string | undefined>,
  testCase: EvalCase,
): Promise<CaseResult> {
  const startedAt = Date.now();
  const stack = testCase.stack as StackId;
  // Starter files underneath the seed, exactly as the route builds the store — so
  // `read_file` can see `components/ui/button.tsx` here too.
  const seeded = testCase.seedFiles ?? {};
  const isEdit = Object.keys(seeded).length > 0;
  const store = createGenerationFileStore({
    base: withStarterFiles(stack, seeded, testCase.designDirection),
    stack,
  });
  const stablePrefix = buildStablePromptPrefix(stack, testCase.designDirection, {
    outputMode: 'tools',
  });
  // A seeded case is a follow-up, so it gets the edit rules a real follow-up gets.
  const volatileSuffix = buildVolatilePromptSuffix({ isEdit });
  // The same framing a real request gets: the user's words are data, not
  // instructions that may rewrite the rules above them.
  const volatileUser = [volatileSuffix, wrapUserRequest(testCase.prompt)]
    .filter(Boolean)
    .join('\n\n');

  const base: CaseResult = {
    id: testCase.id,
    stack: testCase.stack,
    designDirection: testCase.designDirection,
    passed: false,
    failures: [],
    files: [],
    fileCount: 0,
    expectFiles: testCase.expectFiles,
    buildStatus: 'not-run',
    tokensIn: 0,
    tokensOut: 0,
    durationMs: 0,
    reply: '',
    error: null,
    tools: emptyToolTally(),
  };

  // Only the outcome of each tool result is kept. A successful write carries the
  // complete file on `content`, and holding twelve cases' worth of those to count
  // them would be pure waste — the store already has the files.
  const toolResults: { tool: string; ok: boolean }[] = [];

  try {
    const result = await generateText({
      model: chatModelForEntry(entry, providerEnv, entry.model),
      messages: buildCachedMessages({ stablePrefix, volatileUser }),
      // `notify: () => {}` here until 2026-08-29, which is why nothing could see a
      // refused `edit_file`: the tools *return* their refusals rather than throwing,
      // so a run that burned half its step budget on "search appears 3 times" scored
      // exactly like one that never missed.
      tools: buildGenerationTools({
        store,
        notify: (event) => {
          if (event.phase === 'result') toolResults.push({ tool: event.tool, ok: event.ok });
        },
      }),
      toolChoice: 'auto',
      stopWhen: stepCountIs(MAX_STEPS),
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      temperature: temperatureForModel(entry.model, {
        thinking: thinkingEnabledFromEnv(providerEnv),
      }),
    });
    base.reply = result.text ?? '';
    base.tokensIn = result.totalUsage?.inputTokens ?? 0;
    base.tokensOut = result.totalUsage?.outputTokens ?? 0;
    base.tools = tallyToolOutcomes({
      // The SDK's own list of what the model asked for, which includes a call whose
      // arguments failed schema validation — that one never reaches `execute` and so
      // never appears among `toolResults`, and it is exactly the failure a
      // tool-surface change is most likely to introduce.
      // Defensive for the same reason every read beside it is: a throw here would be
      // caught below and recorded as `passed: false` with a provider error, turning a
      // generation that actually succeeded into a failed case — and the pass rate this
      // harness exists to measure is the one number that must never lie quietly.
      calls: (result.steps ?? []).flatMap((step) =>
        (step.toolCalls ?? []).map((call) => call.toolName),
      ),
      results: toolResults,
    });
  } catch (error) {
    base.error = error instanceof Error ? error.message : String(error);
    base.failures.push(`provider: ${base.error}`);
    // A provider blow-up mid-run still made tool calls, and what it managed before
    // dying is the evidence for whether the failure was the tool surface's fault.
    base.tools = tallyToolOutcomes({ calls: [], results: toolResults });
    base.durationMs = Date.now() - startedAt;
    return base;
  }

  const written = store.writtenFiles();
  base.files = Object.keys(written).sort();
  base.fileCount = base.files.length;

  // An expectation of zero files is the ambiguous case: it must ask a question
  // rather than build something nobody asked for. Anything else has a floor.
  if (testCase.expectFiles === 0) {
    if (base.fileCount > 0) {
      base.failures.push(`built ${base.fileCount} files for an ambiguous request`);
    }
  } else if (base.fileCount < testCase.expectFiles) {
    base.failures.push(`wrote ${base.fileCount} files, expected at least ${testCase.expectFiles}`);
  }

  // Compiles or does not, decided by the same check production runs. Merged over the
  // seed, never the writes alone: an edit returns one file, and compiling that on its
  // own reports every import of the rest of the site as broken.
  if (base.fileCount > 0) {
    const build = await checkBuild({
      stack,
      files: { ...seeded, ...written },
      designDirection: testCase.designDirection,
    });
    base.buildStatus = build.status;
    if (build.status === 'failed') {
      base.failures.push(
        `build failed: ${build.errors.map((problem) => problem.kind).join(', ') || 'unknown'}`,
      );
    }
  }

  // The anti-slop sweep, over what this turn produced *and* the reply: placeholder
  // copy in a closing sentence is the same failure as placeholder copy on the page.
  // The seed is excluded — a case must not fail on its own fixture.
  const haystack = [...Object.values(written), base.reply].join('\n');
  for (const pattern of testCase.mustNotMatch) {
    if (new RegExp(pattern, 'i').test(haystack)) {
      base.failures.push(`matched forbidden pattern /${pattern}/i`);
    }
  }

  base.passed = base.failures.length === 0;
  base.durationMs = Date.now() - startedAt;
  return base;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value.padEnd(width);
}

/** Every run this harness has ever written. Gitignored, and the only history there is. */
const EVAL_DIR = join('tmp', 'eval');

/**
 * The most recent earlier run of the same model, or `null` before there is one.
 *
 * Keyed on the model rather than simply taking the newest file, because a sweep
 * writes one file per model within the same second and diffing Pro against Flash
 * would report every difference between two *models* as a change in the prompt.
 *
 * Read newest-first and stopped at the first match, so the usual cost is one file.
 * A file that will not parse is skipped rather than fatal: an interrupted run leaves
 * a truncated one behind, and losing the comparison is no reason to lose the run.
 */
function findBaseline(model: string, written: readonly string[]): BaselineRun | null {
  let names: string[];
  try {
    names = readdirSync(EVAL_DIR);
  } catch {
    return null;
  }
  for (const name of priorRunFilesNewestFirst(names, written)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(EVAL_DIR, name), 'utf8'));
    } catch {
      continue;
    }
    const run = parseRunFile(name, parsed);
    if (run && run.model === model) return run;
  }
  return null;
}

function listing(ids: readonly string[]): string {
  return ids.length > 0 ? `: ${ids.join(', ')}` : '';
}

function printBaselineDiff(
  baseline: BaselineRun | null,
  results: readonly CaseResult[],
): BaselineDiff | null {
  if (!baseline) {
    console.log('baseline: no earlier run of this model in tmp/eval — this run becomes it.');
    return null;
  }
  const diff = diffVerdicts(
    baseline.verdicts,
    results.map((result) => ({ id: result.id, passed: result.passed })),
  );
  const when = baseline.at ? ` at ${baseline.at}` : '';
  console.log(`baseline: ${baseline.file} — ${baseline.passed}/${baseline.total}${when}`);
  console.log(`  newly passing (${diff.newlyPassing.length})${listing(diff.newlyPassing)}`);
  console.log(`  newly failing (${diff.newlyFailing.length})${listing(diff.newlyFailing)}`);
  console.log(
    `  unchanged: ${diff.unchangedPassing.length} passing, ${diff.unchangedFailing.length} failing`,
  );
  if (diff.added.length > 0) {
    console.log(`  not in the baseline (${diff.added.length})${listing(diff.added)}`);
  }
  if (diff.removed.length > 0) {
    console.log(`  absent from this run (${diff.removed.length})${listing(diff.removed)}`);
  }
  return diff;
}

/** The whole case set against one model, printed as it goes. */
async function runModel(
  entry: ProviderEntry,
  providerEnv: Record<string, string | undefined>,
  cases: readonly EvalCase[],
): Promise<CaseResult[]> {
  const results: CaseResult[] = [];
  for (const testCase of cases) {
    process.stdout.write(`${pad(testCase.id, 26)} `);
    const result = await runCase(entry, providerEnv, testCase);
    results.push(result);
    console.log(
      `${result.passed ? 'PASS' : 'FAIL'}  ${pad(`${result.fileCount} files`, 10)} ${pad(result.buildStatus, 14)} ${result.tokensOut} out`,
    );
    for (const failure of result.failures) console.log(`${' '.repeat(27)}- ${failure}`);
    const tools = formatToolTally(result.tools);
    if (tools) console.log(`${' '.repeat(27)}${tools}`);
  }
  return results;
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.includes('--live')) {
    console.error('This spends real tokens: twelve generations against the configured provider.');
    console.error('Re-run with --live when you mean it:');
    console.error('  node ./node_modules/tsx/dist/cli.mjs scripts/eval-prompts.ts --live');
    console.error(
      `Add ${ALL_MODELS_FLAG} (or ${MODELS_FLAG}<id>,<id>) to repeat the set per model — one bill per model.`,
    );
    process.exitCode = 1;
    return;
  }

  const cases = readCases();
  // No user: the admin/env overlay only, which is what a cron-driven generation
  // would resolve to as well.
  const providerEnv = await loadEffectiveProviderEnv(null);
  const [configured] = loadProviderChain(providerEnv, {});
  if (!configured) {
    console.error('No provider is configured (no DeepSeek API key). Nothing to evaluate.');
    process.exitCode = 1;
    return;
  }

  // An unprobed model is kept out of a sweep: `modelSupportsTools` answers false for
  // anything nobody has measured, and a model that cannot call a tool would produce
  // twelve empty projects and read as a catastrophic prompt regression rather than
  // as the capability gap it is.
  const selection = modelsForRun(argv, {
    configured: configured.model,
    offered: DEEPSEEK_MODELS.map((row) => row.id).filter((id) => modelSupportsTools(id)),
  });
  if (selection.unknown.length > 0) {
    console.error(`Not an available model: ${selection.unknown.join(', ')}.`);
    console.error(`Choose from: ${DEEPSEEK_MODELS.map((row) => row.id).join(', ')}.`);
    process.exitCode = 1;
    return;
  }

  const thinking = thinkingEnabledFromEnv(providerEnv);
  const sweep = selection.models.length > 1;
  if (sweep) {
    console.log(`models: ${selection.models.join(', ')}`);
    console.log(`thinking: ${thinking ? 'enabled' : 'disabled'}`);
    console.log(
      `cases: ${cases.length} x ${selection.models.length} models = ${cases.length * selection.models.length} generations`,
    );
  } else {
    console.log(`model: ${selection.models[0]}`);
    console.log(`thinking: ${thinking ? 'enabled' : 'disabled'}`);
    console.log(`cases: ${cases.length}`);
  }
  console.log('');

  // One stamp for the whole sweep, so every file a run produced sorts together.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const written: string[] = [];
  const runs: { model: string; verdicts: RunVerdict[] }[] = [];

  for (const model of selection.models) {
    // The configured entry is reused rather than re-resolved, because `resolveModel`
    // passes `AI_PRIMARY_MODEL` through without checking it against `DEEPSEEK_MODELS`
    // — a deployment may legally be running an id `requestedModel` would refuse.
    const entry =
      model === configured.model
        ? configured
        : loadProviderChain(providerEnv, { requestedModel: model })[0];
    // A sweep is paid for model by model, so an unresolvable id must not throw after the
    // earlier models have already been billed. `noUncheckedIndexedAccess` is off, so the
    // empty chain types as an entry and only fails on the first property read.
    if (!entry) {
      console.log(`--- ${model} --- skipped: no provider chain resolves this model`);
      continue;
    }

    if (sweep) console.log(`--- ${model} ---`);
    const results = await runModel(entry, providerEnv, cases);

    const passed = results.filter((result) => result.passed).length;
    const tokensIn = results.reduce((sum, result) => sum + result.tokensIn, 0);
    const tokensOut = results.reduce((sum, result) => sum + result.tokensOut, 0);
    const rate = results.length > 0 ? Math.round((passed / results.length) * 100) : 0;
    const toolTotals = mergeToolTallies(results.map((result) => result.tools));

    console.log('');
    console.log(`pass rate: ${passed}/${results.length} (${rate}%)`);
    console.log(`tokens: ${tokensIn} in, ${tokensOut} out`);
    const tools = formatToolTally(toolTotals);
    if (tools) console.log(`tools: ${tools}`);

    // Looked up before the write, so this run's own file cannot become its baseline.
    const baseline = findBaseline(entry.model, written);
    const diff = printBaselineDiff(baseline, results);

    // One file per model, in the one shape every earlier run was written in — the
    // 2026-08-27 baseline included, which is what keeps it readable by `parseRunFile`
    // and therefore still comparable. The name only carries the model when a sweep
    // would otherwise write several files under one stamp.
    const outName = sweep ? `${stamp}--${entry.model}.json` : `${stamp}.json`;
    const outPath = join(EVAL_DIR, outName);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(
      outPath,
      `${JSON.stringify(
        {
          at: new Date().toISOString(),
          model: entry.model,
          thinking,
          passed,
          total: results.length,
          rate,
          tokensIn,
          tokensOut,
          tools: toolTotals,
          baseline: baseline
            ? {
                file: baseline.file,
                at: baseline.at,
                passed: baseline.passed,
                total: baseline.total,
                diff,
              }
            : null,
          results,
        },
        null,
        2,
      )}\n`,
    );
    written.push(outName);
    console.log(`written: ${outPath}`);
    if (sweep) console.log('');

    runs.push({
      model: entry.model,
      verdicts: results.map((result) => ({ id: result.id, passed: result.passed })),
    });
  }

  if (runs.length > 1) {
    for (const line of renderModelMatrix(runs)) console.log(line);
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
