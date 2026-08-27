import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BuildCheckResult } from '@/lib/validation/build-check';

/**
 * One user message must not be able to bill an unbounded number of generations.
 *
 * The live run that found this: a follow-up whose generated code failed the
 * in-process esbuild check turned a single message into three billed
 * generations — the main run plus two automatic repair passes — with nothing in
 * the transcript saying the second and third had been charged, and no operator
 * switch anywhere that could stop it.
 *
 * Three separate things had to be true at once for that to happen, and each has a
 * case below:
 *
 * 1. `decideAutoFix` checks its attempt ceiling *after* the missing-package
 *    branch has already returned, so an `install` decision skipped the cap
 *    entirely. The only thing that then ended the client's recursion was the
 *    model happening to emit a byte-identical failure signature twice — the
 *    repeated-failure guard — which is not a bound at all.
 * 2. The `buildAutoFixEnabled` toggle had a reader and a writer and no caller for
 *    the writer, and its key was absent from `lib/settings/registry.ts`, so
 *    /admin/config could neither show it nor write it. An unbounded billed loop
 *    defaulted to on with no off switch.
 * 3. The repair passes were announced as "attempting an automatic fix", which
 *    does not say a credit is being spent.
 *
 * The loop below drives `runBuildValidation` exactly the way the workspace does —
 * feeding `retry.attempt` and `retry.signature` back in as the next call's inputs
 * — so it counts real billable passes rather than asserting on the policy's
 * internals.
 */

const recordJobStepFailure = vi.fn(async () => undefined);

/** Whatever the bundle check should report on this call. */
const bundle = { next: null as null | (() => BuildCheckResult) };

vi.mock('@/lib/jobs/step-failure', () => ({
  recordJobStepFailure: (...args: unknown[]) =>
    (recordJobStepFailure as unknown as (...inner: unknown[]) => Promise<undefined>)(...args),
}));

vi.mock('@/lib/validation/build-check', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/validation/build-check')>();
  return {
    ...actual,
    checkBuild: async (args: Parameters<typeof actual.checkBuild>[0]) =>
      bundle.next ? bundle.next() : actual.checkBuild(args),
  };
});

/**
 * An in-memory `AppSetting` table, so `saveSettings` → `getBuildAutoFixEnabled`
 * can be exercised end to end. That round trip is the whole point of case 2: a
 * value written by the admin path has to land on the row the generation path
 * reads, and before this change the two named different keys in different shapes.
 */
const rows = new Map<string, string>();

vi.mock('@/lib/db', () => ({
  prisma: {
    appSetting: {
      findUnique: async ({ where }: { where: { key: string } }) => {
        const value = rows.get(where.key);
        return value === undefined ? null : { value };
      },
      upsert: async ({ where, create }: { where: { key: string }; create: { value: string } }) => {
        rows.set(where.key, create.value);
        return { key: where.key, value: create.value };
      },
      deleteMany: async ({ where }: { where: { key: string } }) => {
        const existed = rows.delete(where.key);
        return { count: existed ? 1 : 0 };
      },
    },
  },
}));

const writeAudit = vi.fn(async () => undefined);
vi.mock('@/lib/audit/log', () => ({ writeAudit: () => writeAudit() }));

const { runBuildValidation } = await import('@/lib/validation/run-build-validation');
const { MAX_AUTOFIX_ATTEMPTS } = await import('@/lib/validation/autofix-policy');
const { BUILD_AUTOFIX_SETTING_KEY, getBuildAutoFixEnabled, parseBuildAutoFixEnabled } =
  await import('@/lib/validation/settings');
const { findSetting } = await import('@/lib/settings/registry');
const { invalidateSettingsCache, saveSettings, clearSetting } =
  await import('@/lib/settings/resolve');

/** A project that passes the static import scan, so the bundle check is reached. */
const CLEAN_FILES: Record<string, string> = {
  'app/page.tsx': [
    "import { siteConfig } from '@/lib/data';",
    'export default function Page() {',
    '  return <h1>{siteConfig.name}</h1>;',
    '}',
  ].join('\n'),
  'lib/data.ts': "export const siteConfig = { name: 'Nordlys' };",
};

function failureWith(kind: 'missing-package' | 'syntax', round: number): BuildCheckResult {
  return {
    status: 'failed',
    stack: 'NEXTJS',
    errors: [
      {
        kind,
        message:
          kind === 'missing-package'
            ? `Could not resolve "carousel-lib-${round}"`
            : `Unexpected token in round ${round}`,
        file: 'app/page.tsx',
        line: round + 1,
      },
    ],
    // A *different* package every round, so the repeated-failure guard never
    // trips. This is the model "changing its mind", which is exactly what the
    // old loop relied on to terminate.
    missingPackages: kind === 'missing-package' ? [`carousel-lib-${round}`] : [],
    signature: `sig-round-${round}`,
  };
}

/**
 * Runs the build → fix → build cycle the way `applyGeneratedCode` does and
 * returns how many billable repair generations the server asked for. The `stop`
 * ceiling is deliberately far above `MAX_AUTOFIX_ATTEMPTS`: against the broken
 * behaviour this loop does not terminate on its own, and the count it returns is
 * the evidence.
 */
async function countBilledRepairs(kind: 'missing-package' | 'syntax', stopAfter = 12) {
  let round = 0;
  let attempt = 0;
  let previousSignature: string | null = null;
  let billed = 0;

  for (let pass = 0; pass < stopAfter; pass += 1) {
    bundle.next = () => failureWith(kind, round);
    const outcome = await runBuildValidation({
      stack: 'NEXTJS',
      files: CLEAN_FILES,
      changedPaths: Object.keys(CLEAN_FILES),
      jobId: 'job-bound',
      attempt,
      previousSignature,
      notify: () => undefined,
    });
    if (!outcome.retry) return billed;
    billed += 1;
    attempt = outcome.retry.attempt;
    previousSignature = outcome.retry.signature;
    round += 1;
  }
  return billed;
}

beforeEach(() => {
  rows.clear();
  bundle.next = null;
  recordJobStepFailure.mockClear();
  writeAudit.mockClear();
  invalidateSettingsCache();
});

describe('one message cannot bill an unbounded number of generations', () => {
  it('stops after the ceiling when every failure names a different missing package', async () => {
    // The leak. `decideAutoFix` returns `install` before it ever tests the
    // attempt cap, and `settleFailure` turned that into a retry payload at any
    // attempt number; with a fresh signature each round nothing else could stop
    // it, so the client recursed for as long as the model kept naming a new
    // package — one credit per pass.
    expect(await countBilledRepairs('missing-package')).toBe(MAX_AUTOFIX_ATTEMPTS);
  });

  it('stops after the ceiling on an ordinary compile failure too', async () => {
    expect(await countBilledRepairs('syntax')).toBe(MAX_AUTOFIX_ATTEMPTS);
  });

  it('says the loop is over rather than going quiet at the ceiling', async () => {
    // A silent stop is indistinguishable from a check that never ran, and leaves
    // the person staring at a broken preview.
    const notices: string[] = [];
    bundle.next = () => failureWith('missing-package', 0);
    const outcome = await runBuildValidation({
      stack: 'NEXTJS',
      files: CLEAN_FILES,
      changedPaths: Object.keys(CLEAN_FILES),
      jobId: 'job-bound-2',
      attempt: MAX_AUTOFIX_ATTEMPTS,
      previousSignature: 'something-else',
      notify: (message) => {
        notices.push(message);
      },
    });

    expect(outcome.retry).toBeNull();
    expect(outcome.decision).toMatchObject({ action: 'stop', reason: 'attempts-exhausted' });
    expect(notices.join(' ')).toContain(`${MAX_AUTOFIX_ATTEMPTS} automatic fix attempts`);
  });

  it('tells the user each repair pass is a separate charged generation', async () => {
    const notices: string[] = [];
    bundle.next = () => failureWith('syntax', 0);
    await runBuildValidation({
      stack: 'NEXTJS',
      files: CLEAN_FILES,
      changedPaths: Object.keys(CLEAN_FILES),
      jobId: 'job-bound-3',
      attempt: 0,
      previousSignature: null,
      notify: (message) => {
        notices.push(message);
      },
    });

    const line = notices.find((message) => message.includes('automatic fix 1'));
    expect(line, 'no notice named the repair pass').toBeTruthy();
    // The old copy was "attempting an automatic fix (1/2)", which never said a
    // credit was being spent — which is how two extra charges per message went
    // unnoticed through a whole live run.
    expect(line).toContain('charged');
    expect(line).toContain(`of ${MAX_AUTOFIX_ATTEMPTS}`);
  });

  it('spends nothing extra when a repair pass would exceed the ceiling on packages', async () => {
    bundle.next = () => failureWith('missing-package', 3);
    const outcome = await runBuildValidation({
      stack: 'NEXTJS',
      files: CLEAN_FILES,
      changedPaths: Object.keys(CLEAN_FILES),
      jobId: 'job-bound-4',
      attempt: MAX_AUTOFIX_ATTEMPTS + 5,
      previousSignature: null,
      notify: () => undefined,
    });
    expect(outcome.retry).toBeNull();
  });
});

describe('the auto-fix switch is reachable through the normal settings path', () => {
  it('is a registry entry, so /admin/config renders and writes it', () => {
    const entry = findSetting(BUILD_AUTOFIX_SETTING_KEY);
    // /admin/config renders from SETTINGS and `saveSettings` refuses any key that
    // is not in it, so an absent entry means the row can be read and never set —
    // the exact state this defect was in.
    expect(entry, `${BUILD_AUTOFIX_SETTING_KEY} is not in the settings registry`).toBeDefined();
    expect(entry?.kind).toBe('select');
    expect(entry?.options?.map((option) => option.value)).toEqual(['on', 'off']);
  });

  it('defaults to on, and says so where an operator can see it', () => {
    const entry = findSetting(BUILD_AUTOFIX_SETTING_KEY);
    // Kept on deliberately: with it off a failing build reaches the preview and
    // the only remedy is the same corrective message typed by hand, billed the
    // same. The default belongs in the registry `fallback`, where /admin/config
    // shows it, rather than in an `if (value == null) return true` nobody reads.
    expect(entry?.fallback).toBe('on');
    expect(parseBuildAutoFixEnabled(entry?.fallback)).toBe(true);
  });

  it('states the real ceiling in its help text', () => {
    // Prose that drifts from the constant is how "up to two extra generations"
    // becomes a lie after someone raises the cap.
    expect(findSetting(BUILD_AUTOFIX_SETTING_KEY)?.help).toContain(
      `at most ${MAX_AUTOFIX_ATTEMPTS} of them`,
    );
  });

  it('reads what the admin save path writes, and reverts to on when cleared', async () => {
    const actor = { id: 'admin-1', email: 'admin@example.com' };

    expect(await getBuildAutoFixEnabled()).toBe(true);

    const saved = await saveSettings([{ key: BUILD_AUTOFIX_SETTING_KEY, value: 'off' }], actor);
    expect(saved.unknown).toEqual([]);
    expect(saved.applied).toEqual([BUILD_AUTOFIX_SETTING_KEY]);
    // The row the admin path wrote has to be the row the generation path reads.
    // Before this change the writer wrote a bare `buildAutoFixEnabled` row nobody
    // could reach and the registry knew nothing about the key at all.
    expect(await getBuildAutoFixEnabled()).toBe(false);

    await clearSetting(BUILD_AUTOFIX_SETTING_KEY, actor);
    expect(await getBuildAutoFixEnabled()).toBe(true);
  });

  it('stops the loop once the switch is off, and still reports the failure', async () => {
    await saveSettings(
      [{ key: BUILD_AUTOFIX_SETTING_KEY, value: 'off' }],
      { id: 'admin-1', email: 'admin@example.com' },
    );

    const notices: string[] = [];
    bundle.next = () => failureWith('missing-package', 0);
    const outcome = await runBuildValidation({
      stack: 'NEXTJS',
      files: CLEAN_FILES,
      changedPaths: Object.keys(CLEAN_FILES),
      jobId: 'job-off',
      attempt: 0,
      previousSignature: null,
      notify: (message) => {
        notices.push(message);
      },
    });

    expect(outcome.retry).toBeNull();
    expect(outcome.decision).toMatchObject({ action: 'stop', reason: 'autofix-disabled' });
    // Declining to spend a generation is not licence to tell the user a broken
    // build worked.
    expect(notices.some((message) => message.includes('turned off'))).toBe(true);
  });
});

describe('the workspace bounds its own recursion', () => {
  /**
   * `applyGeneratedCode` is a closure inside a client component, so the mechanism
   * is pinned by reading the source the way the repo's other workspace tests do
   * (tests/unit/no-package-install-theatre.test.ts, plan-recovery-retry.test.ts).
   * What matters is that the recursive call advances a counter the client owns:
   * a recursion whose only exit is the server withholding `buildFix` has no
   * defence if the counter round trip ever breaks again — and it has broken
   * before, in both directions (F-021).
   */
  const workspace = readFileSync(
    resolvePath(process.cwd(), 'components/workspace/GenerationWorkspace.tsx'),
    'utf8',
  );

  it('guards the repair branch with its own ceiling', () => {
    expect(workspace).toMatch(/export const MAX_CLIENT_BUILD_FIX_PASSES = \d+;/);
    expect(workspace).toMatch(
      /if \(buildFix\?\.instruction && buildFixPass >= MAX_CLIENT_BUILD_FIX_PASSES\)/,
    );
  });

  it('advances that counter on the recursive call', () => {
    // Recursing with the same count is the same unbounded loop with a constant
    // added to it.
    expect(workspace).toMatch(/applyGeneratedCode\([\s\S]{0,200}?buildFixPass \+ 1,/);
  });

  it('names the repair pass as a charged generation in chat', () => {
    expect(workspace).toContain('This is a separate generation and is charged like any other');
    // The old line. It attributed nothing and priced nothing.
    expect(workspace).not.toContain('attempting an automatic fix (');
  });

  it('keeps its ceiling equal to the server policy it copies', () => {
    // The client cannot import MAX_AUTOFIX_ATTEMPTS: `autofix-policy` runtime-imports
    // `fix-prompt`, whose link to the esbuild half is an `import type` away from
    // pulling `lib/preview/server-bundle` into a `'use client'` graph. So the number
    // is copied — and a copy is only as good as the thing that stops it drifting.
    // Raise the server cap alone and the two halves narrate different loops in one
    // transcript: the server's own chat notice says "automatic fix 2 of 4" while the
    // workspace says "2 of 2" and then stops. Lower it alone and the workspace offers
    // a third pass the server will never fund.
    const mirrored = /export const MAX_CLIENT_BUILD_FIX_PASSES = (\d+);/.exec(workspace);
    expect(mirrored, 'no client ceiling found to compare').toBeTruthy();
    expect(Number(mirrored?.[1]), 'client and server build-fix ceilings disagree').toBe(
      MAX_AUTOFIX_ATTEMPTS,
    );
  });

  it('prices both chat lines off that constant rather than a literal', () => {
    // A hand-written "of 2" in the copy is the same drift one layer down: it survives
    // a change to the constant and tells the person a ceiling that is no longer real.
    expect(workspace).toContain(
      'automatic fix ${buildFixPass + 1} of ${MAX_CLIENT_BUILD_FIX_PASSES}',
    );
    expect(workspace).toContain(
      'still fails after ${MAX_CLIENT_BUILD_FIX_PASSES} automatic fix attempts',
    );
  });
});
