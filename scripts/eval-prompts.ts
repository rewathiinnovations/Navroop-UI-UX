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
 * printed table. The JSON carries every case's files, tokens and failures, so a
 * regression can be read after the fact rather than re-run.
 *
 * The provider is resolved exactly as generation resolves it — the effective-env
 * overlay, the provider chain, the chat-completions model — so a score here is
 * about the configured deployment, not about DeepSeek in general.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from 'dotenv';
import { generateText, stepCountIs } from 'ai';
import { chatModelForEntry, thinkingEnabledFromEnv } from '../lib/ai/client-for-entry';
import { loadEffectiveProviderEnv } from '../lib/ai/effective-env';
import { loadProviderChain, type ProviderEntry } from '../lib/ai/providers';
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
  };

  try {
    const result = await generateText({
      model: chatModelForEntry(entry, providerEnv, entry.model),
      messages: buildCachedMessages({ stablePrefix, volatileUser }),
      tools: buildGenerationTools({ store, notify: () => {} }),
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
  } catch (error) {
    base.error = error instanceof Error ? error.message : String(error);
    base.failures.push(`provider: ${base.error}`);
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

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.includes('--live')) {
    console.error('This spends real tokens: twelve generations against the configured provider.');
    console.error('Re-run with --live when you mean it:');
    console.error('  node ./node_modules/tsx/dist/cli.mjs scripts/eval-prompts.ts --live');
    process.exitCode = 1;
    return;
  }

  const cases = readCases();
  // No user: the admin/env overlay only, which is what a cron-driven generation
  // would resolve to as well.
  const providerEnv = await loadEffectiveProviderEnv(null);
  const [entry] = loadProviderChain(providerEnv, {});
  if (!entry) {
    console.error('No provider is configured (no DeepSeek API key). Nothing to evaluate.');
    process.exitCode = 1;
    return;
  }

  console.log(`model: ${entry.model}`);
  console.log(`thinking: ${thinkingEnabledFromEnv(providerEnv) ? 'enabled' : 'disabled'}`);
  console.log(`cases: ${cases.length}`);
  console.log('');

  const results: CaseResult[] = [];
  for (const testCase of cases) {
    process.stdout.write(`${pad(testCase.id, 26)} `);
    const result = await runCase(entry, providerEnv, testCase);
    results.push(result);
    console.log(
      `${result.passed ? 'PASS' : 'FAIL'}  ${pad(`${result.fileCount} files`, 10)} ${pad(result.buildStatus, 14)} ${result.tokensOut} out`,
    );
    for (const failure of result.failures) console.log(`${' '.repeat(27)}- ${failure}`);
  }

  const passed = results.filter((result) => result.passed).length;
  const tokensIn = results.reduce((sum, result) => sum + result.tokensIn, 0);
  const tokensOut = results.reduce((sum, result) => sum + result.tokensOut, 0);
  const rate = results.length > 0 ? Math.round((passed / results.length) * 100) : 0;

  console.log('');
  console.log(`pass rate: ${passed}/${results.length} (${rate}%)`);
  console.log(`tokens: ${tokensIn} in, ${tokensOut} out`);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = join('tmp', 'eval', `${stamp}.json`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(
    outPath,
    `${JSON.stringify(
      {
        at: new Date().toISOString(),
        model: entry.model,
        thinking: thinkingEnabledFromEnv(providerEnv),
        passed,
        total: results.length,
        rate,
        tokensIn,
        tokensOut,
        results,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`written: ${outPath}`);
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
