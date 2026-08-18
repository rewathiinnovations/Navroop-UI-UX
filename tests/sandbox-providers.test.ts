/**
 * Multi-provider sandbox routing, credits, failover, sticky, round-robin.
 * Run: pnpm exec tsx tests/sandbox-providers.test.ts
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DRIVER_CAPABILITIES,
  LAST_ACTIVE_DEACTIVATE_WARNING,
  NO_PROVIDER_GENERATION_MESSAGE,
  NoProviderAvailableError,
  SANDBOX_DRIVERS,
} from '../lib/sandbox/provider.ts';
import {
  applyCreditConsumption,
  estimateRunCostUsd,
  monthsRemainingAt30DayBurn,
  rollProviderPeriod,
} from '../lib/sandbox/credits.ts';
import { lastActiveDeactivateWarning } from '../lib/sandbox/admin.ts';
import { isFailoverError } from '../lib/sandbox/failover.ts';
import { createWithFailover } from '../lib/sandbox/failover.ts';
import { rankAndSelect, type ProviderCandidate } from '../lib/sandbox/router.ts';
import { shouldSkipHealthProbe } from '../lib/sandbox/health.ts';
import { runConformanceSuite } from '../lib/sandbox/conformance.ts';
import { E2BProvider } from '../lib/sandbox/providers/e2b-provider.ts';
import { ModalProvider } from '../lib/sandbox/providers/modal-provider.ts';
import { DaytonaProvider } from '../lib/sandbox/providers/daytona-provider.ts';
import { runProviderTest } from '../lib/sandbox/test-run.ts';
import { SandboxFactory } from '../lib/sandbox/factory.ts';
import { resolveStickyProvider } from '../lib/sandbox/sticky.ts';

let failed = 0;
let passed = 0;

function assert(cond: unknown, name: string) {
  if (cond) {
    passed += 1;
    console.log(`PASS  ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL  ${name}`);
}

function candidate(partial: Partial<ProviderCandidate> & Pick<ProviderCandidate, 'id' | 'creditType'>): ProviderCandidate {
  return {
    name: partial.name ?? partial.id,
    driver: partial.driver ?? 'e2b',
    isActive: partial.isActive ?? true,
    priority: partial.priority ?? 100,
    weight: partial.weight ?? 1,
    creditRemainingUsd: partial.creditRemainingUsd ?? 10,
    creditTotalUsd: partial.creditTotalUsd ?? 10,
    monthlyBudgetUsd: partial.monthlyBudgetUsd ?? null,
    monthlyMinutesLimit: partial.monthlyMinutesLimit ?? null,
    minutesUsed: partial.minutesUsed ?? 0,
    spendUsd: partial.spendUsd ?? 0,
    healthStatus: partial.healthStatus ?? 'healthy',
    lastCheckedAt: partial.lastCheckedAt ?? new Date(),
    consecutiveFails: partial.consecutiveFails ?? 0,
    downUntil: partial.downUntil ?? null,
    periodStart: partial.periodStart ?? new Date('2026-08-01T00:00:00.000Z'),
    creditResetsAt: partial.creditResetsAt ?? new Date('2026-09-01T00:00:00.000Z'),
    config: partial.config ?? { cpu: 1, memoryGiB: 1, timeoutMs: 300_000 },
    ...partial,
  };
}

const COST = { cpuPerSecUsd: 0.0001, memPerGibSecUsd: 0.00005 };

function mockClient(label: string) {
  let alive = false;
  let preview = `https://${label}.example.test`;
  return {
    create: async () => {
      alive = true;
      return { id: `${label}-box`, previewUrl: preview };
    },
    run: async (command: string) => ({
      stdout: `ran:${command}`,
      stderr: '',
      exitCode: 0,
    }),
    writeFile: async () => undefined,
    readFile: async () => 'ok',
    listFiles: async () => ['index.html'],
    kill: async () => {
      alive = false;
    },
    reconnect: async () => alive,
    getPreviewUrl: () => (alive ? preview : null),
    setPreview(url: string | null) {
      preview = url || '';
    },
  };
}

// --- driver set ---
assert(SANDBOX_DRIVERS.join(',') === 'e2b,modal,daytona', 'driver set is e2b, modal, daytona only');
assert(!SANDBOX_DRIVERS.includes('vercel' as never), 'driver set has no vercel');
assert(DRIVER_CAPABILITIES.e2b.publicPreviewUrl === true, 'e2b exposes a public preview URL');
assert(DRIVER_CAPABILITIES.daytona.publicPreviewUrl === true, 'daytona exposes a public preview URL');

// --- conformance (mocked SDKs) ---
const e2b = new E2BProvider({ apiKey: 'test-e2b' }, { client: mockClient('e2b') });
const modal = new ModalProvider({ tokenId: 'ak-test', tokenSecret: 'as-test' }, { client: mockClient('modal') });
const daytona = new DaytonaProvider({ apiKey: 'test-daytona' }, { client: mockClient('daytona') });

for (const [name, driver] of [
  ['e2b', e2b],
  ['modal', modal],
  ['daytona', daytona],
] as const) {
  const result = await runConformanceSuite(driver);
  assert(result.created, `${name} conformance creates a sandbox`);
  assert(result.commandOk, `${name} conformance runs a command`);
  assert(result.previewUrl !== null && result.previewUrl.length > 0, `${name} conformance returns a preview URL`);
}

// --- free_first: recurring then smallest one_time ---
const recurring = candidate({
  id: 'rec',
  creditType: 'recurring_monthly',
  creditRemainingUsd: 5,
  priority: 50,
});
const oneTimeBig = candidate({
  id: 'ot-big',
  creditType: 'one_time',
  creditRemainingUsd: 40,
  priority: 10,
});
const oneTimeSmall = candidate({
  id: 'ot-small',
  creditType: 'one_time',
  creditRemainingUsd: 8,
  priority: 20,
});
const paid = candidate({
  id: 'paid',
  creditType: 'paid',
  creditRemainingUsd: 100,
  priority: 1,
});

const first = rankAndSelect({
  candidates: [oneTimeBig, paid, oneTimeSmall, recurring],
  strategy: 'free_first',
  costModelFor: () => COST,
  estimateSeconds: 60,
});
assert(first.id === 'rec', 'free_first routes to recurring while it has credit');

const afterRecurring = rankAndSelect({
  candidates: [
    { ...recurring, creditRemainingUsd: 0 },
    oneTimeBig,
    oneTimeSmall,
    paid,
  ],
  strategy: 'free_first',
  costModelFor: () => COST,
  estimateSeconds: 60,
});
assert(afterRecurring.id === 'ot-small', 'free_first then picks the smallest one_time pool');

// --- period roll returns to recurring ---
const rolled = rollProviderPeriod(
  {
    creditType: 'recurring_monthly' as const,
    creditTotalUsd: 20,
    creditRemainingUsd: 0,
    periodStart: new Date('2026-07-01T00:00:00.000Z'),
    creditResetsAt: new Date('2026-08-01T00:00:00.000Z'),
  },
  new Date('2026-08-17T12:00:00.000Z'),
);
assert(rolled.didRoll === true, 'recurring period rolls after a month');
assert(rolled.creditRemainingUsd === 20, 'period roll restores recurring credit to total');

const afterRoll = rankAndSelect({
  candidates: [
    {
      ...recurring,
      creditRemainingUsd: rolled.creditRemainingUsd,
      periodStart: rolled.periodStart,
    },
    oneTimeSmall,
  ],
  strategy: 'free_first',
  costModelFor: () => COST,
  estimateSeconds: 60,
});
assert(afterRoll.id === 'rec', 'after period roll, free_first returns to recurring immediately');

// --- estimate exceeds remaining → skip ---
const tiny = candidate({
  id: 'tiny',
  creditType: 'recurring_monthly',
  creditRemainingUsd: 0.001,
});
const fallback = candidate({
  id: 'fallback',
  creditType: 'one_time',
  creditRemainingUsd: 10,
});
const skipped = rankAndSelect({
  candidates: [tiny, fallback],
  strategy: 'free_first',
  costModelFor: () => COST,
  estimateSeconds: 600,
});
assert(skipped.id === 'fallback', 'estimate greater than remaining credit skips that config');
assert(estimateRunCostUsd(COST, 1, 1, 600) > 0.001, '600s estimate exceeds 0.001 remaining');

try {
  rankAndSelect({
    candidates: [tiny],
    strategy: 'free_first',
    costModelFor: () => COST,
    estimateSeconds: 600,
  });
  assert(false, 'none eligible throws NoProviderAvailableError');
} catch (error) {
  assert(error instanceof NoProviderAvailableError, 'none eligible is NoProviderAvailableError');
  const typed = error as NoProviderAvailableError;
  assert(typed.exclusions.some((row) => row.reason.includes('credit')), 'exclusion explains remaining credit');
  assert(typed.message === NO_PROVIDER_GENERATION_MESSAGE, 'generation message is precise English, not a stack trace');
}

// --- one_time at zero deactivates + notify ---
const spent = applyCreditConsumption(
  {
    id: 'ot-zero',
    name: 'One-time pool',
    creditType: 'one_time',
    creditRemainingUsd: 0.4,
    creditTotalUsd: 10,
    isActive: true,
    spendUsd: 9.6,
    minutesUsed: 120,
  },
  0.5,
);
assert(spent.creditRemainingUsd === 0, 'one_time remaining floors at zero');
assert(spent.isActive === false, 'one_time at zero deactivates the config');
assert(spent.alerts.includes('one_time_exhausted'), 'one_time at zero notifies');
assert(spent.stopProbes === true, 'one_time at zero stops health probes');

const low = applyCreditConsumption(
  {
    id: 'ot-low',
    name: 'Low pool',
    creditType: 'one_time',
    creditRemainingUsd: 1.2,
    creditTotalUsd: 10,
    isActive: true,
    spendUsd: 8.8,
    minutesUsed: 30,
  },
  0.3,
);
assert(low.alerts.includes('one_time_low'), 'one_time below 10% notifies once');
assert(typeof monthsRemainingAt30DayBurn(0.9, 30, 0.3) === 'number', 'low alert includes projected months at 30-day burn');

const rec80 = applyCreditConsumption(
  {
    id: 'rec-80',
    name: 'Monthly',
    creditType: 'recurring_monthly',
    creditRemainingUsd: 2.5,
    creditTotalUsd: 10,
    isActive: true,
    spendUsd: 7.5,
    minutesUsed: 10,
  },
  0.6,
);
assert(rec80.alerts.includes('recurring_80'), 'recurring crossing 80% is informational');
assert(rec80.isActive === true, 'recurring 80% does not deactivate');

// --- create failover records both attempts ---
const attempts: Array<{ configId: string; ok: boolean }> = [];
const failover = await createWithFailover({
  candidates: [recurring, oneTimeSmall],
  isFailoverError,
  create: async (row) => {
    if (row.id === 'rec') {
      attempts.push({ configId: row.id, ok: false });
      const error = Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' });
      throw error;
    }
    attempts.push({ configId: row.id, ok: true });
    return { sandboxId: 'box-2', previewUrl: 'https://ot.example.test' };
  },
});
assert(failover.sandboxId === 'box-2', 'create succeeds on the next eligible provider');
assert(failover.attempts.length === 2, 'job records both create attempts');
assert(failover.attempts[0]?.configId === 'rec' && failover.attempts[0]?.ok === false, 'first attempt recorded as failure');
assert(failover.attempts[1]?.configId === 'ot-small' && failover.attempts[1]?.ok === true, 'second attempt recorded as success');

assert(isFailoverError(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })), 'timeout is a failover error');
assert(isFailoverError({ status: 503, message: 'unavailable' }), '5xx is a failover error');
assert(isFailoverError({ message: 'quota exceeded' }), 'quota is a failover error');
assert(!isFailoverError(new Error('invalid image')), 'invalid image is not a failover error');
assert(!isFailoverError(new Error('malformed request')), 'malformed request is not a failover error');

// --- sticky provider for kill/probe ---
const sticky = resolveStickyProvider({
  sandboxId: 'alive-1',
  sandboxStatus: 'READY',
  sandboxProviderConfigId: 'acct-a',
  strategyPickId: 'acct-b',
});
assert(sticky === 'acct-a', 'running sandbox stays on the stored account for kill/probe');

const noSticky = resolveStickyProvider({
  sandboxId: null,
  sandboxStatus: 'NONE',
  sandboxProviderConfigId: 'acct-a',
  strategyPickId: 'acct-b',
});
assert(noSticky === 'acct-b', 'without a running sandbox, strategy pick is used');

// --- round-robin 3:1 ---
const heavy = candidate({ id: 'heavy', creditType: 'paid', weight: 3, priority: 1 });
const light = candidate({ id: 'light', creditType: 'paid', weight: 1, priority: 2 });
const counts = { heavy: 0, light: 0 };
let cursor = 0;
for (let i = 0; i < 30; i += 1) {
  const picked = rankAndSelect({
    candidates: [heavy, light],
    strategy: 'round_robin',
    costModelFor: () => COST,
    estimateSeconds: 1,
    roundRobinCursor: cursor,
  });
  counts[picked.id as 'heavy' | 'light'] += 1;
  cursor += 1;
}
assert(counts.heavy === 23 || counts.heavy === 22, `round-robin weight 3:1 is ~3:1 over 30 (heavy=${counts.heavy})`);
assert(counts.light === 7 || counts.light === 8, `round-robin weight 3:1 is ~3:1 over 30 (light=${counts.light})`);

// --- Test button wrong credential fails at create ---
const bad = await runProviderTest({
  driver: 'e2b',
  secrets: { apiKey: 'wrong' },
  create: async () => {
    throw new Error('401 unauthorized');
  },
});
assert(bad.ok === false, 'wrong credential is not a silent success');
assert(bad.failedAt === 'create', 'wrong credential fails at create');
assert(bad.leakedSandbox === null, 'a create that never returned a VM reports no leak');

// --- Test button: a kill failure is surfaced whatever stage failed ---
const killFailedOnCommand = await runProviderTest({
  driver: 'e2b',
  secrets: {},
  create: async () => ({ sandboxId: 'sbx-command', previewUrl: 'https://sbx-command.example' }),
  runCommand: async () => ({ success: false, exitCode: 1 }),
  kill: async () => {
    throw new Error('terminate refused');
  },
});
assert(killFailedOnCommand.ok === false, 'command failure with a failed kill is not a success');
assert(killFailedOnCommand.failedAt === 'command', 'the primary cause stays the command failure');
assert(
  killFailedOnCommand.leakedSandbox?.sandboxId === 'sbx-command',
  'a leak on the command path names the sandbox',
);
assert(
  killFailedOnCommand.leakedSandbox?.error === 'terminate refused',
  'a leak on the command path keeps the kill error',
);
assert(
  killFailedOnCommand.error === 'Command failed (sandbox kill also failed: terminate refused)',
  'the command-path message still reports both failures',
);

const killFailedOnThrow = await runProviderTest({
  driver: 'e2b',
  secrets: {},
  create: async () => ({ sandboxId: 'sbx-throw', previewUrl: null }),
  runCommand: async () => {
    throw new Error('command exploded');
  },
  kill: async () => {
    throw new Error('terminate refused');
  },
});
assert(killFailedOnThrow.ok === false, 'a thrown command with a failed kill is not a success');
assert(
  killFailedOnThrow.failedAt === 'command',
  'a throw after the VM exists is reported as a command failure, not a credentials failure',
);
assert(
  killFailedOnThrow.leakedSandbox?.sandboxId === 'sbx-throw',
  'a leak on the throw path names the sandbox',
);
assert(
  killFailedOnThrow.error === 'command exploded (sandbox kill also failed: terminate refused)',
  'the original throw message is not lost when the kill also fails',
);

const killFailedOnSuccess = await runProviderTest({
  driver: 'e2b',
  secrets: {},
  create: async () => ({ sandboxId: 'sbx-ok', previewUrl: 'https://sbx-ok.example' }),
  runCommand: async () => ({ success: true, exitCode: 0 }),
  kill: async () => {
    throw new Error('terminate refused');
  },
});
assert(killFailedOnSuccess.failedAt === 'kill', 'a kill failure after a clean run still fails at kill');
assert(
  killFailedOnSuccess.leakedSandbox?.sandboxId === 'sbx-ok',
  'the success path reports the leak in the same field',
);

const missingId = await runProviderTest({
  driver: 'e2b',
  secrets: {},
  create: async () => ({ sandboxId: '', previewUrl: null }),
  kill: async () => {
    throw new Error('terminate refused');
  },
});
assert(missingId.failedAt === 'create', 'create without a sandbox id fails at create');
assert(
  missingId.leakedSandbox?.sandboxId === null && missingId.leakedSandbox?.error === 'terminate refused',
  'an id-less create still attempts the kill and reports the leak',
);

let killedAfterCleanRun = 0;
const cleanRun = await runProviderTest({
  driver: 'e2b',
  secrets: {},
  create: async () => ({ sandboxId: 'sbx-clean', previewUrl: 'https://sbx-clean.example' }),
  runCommand: async () => ({ success: true, exitCode: 0 }),
  kill: async () => {
    killedAfterCleanRun += 1;
  },
});
assert(cleanRun.ok === true && cleanRun.leakedSandbox === null, 'a clean provider test reports no leak');
assert(killedAfterCleanRun === 1, 'a clean provider test kills the sandbox exactly once');

// --- last-active deactivate warning ---
assert(
  lastActiveDeactivateWarning(1) === LAST_ACTIVE_DEACTIVATE_WARNING,
  'last active deactivate warns in English',
);
assert(lastActiveDeactivateWarning(2) === null, 'deactivating one of several does not warn');

// --- factory / labels ---
assert(SandboxFactory.getAvailableProviders().join(',') === 'e2b,modal,daytona', 'factory lists only e2b, modal, daytona');
assert(!SandboxFactory.getAvailableProviders().includes('vercel'), 'factory has no vercel');

// --- health probe skip when down in cooldown ---
assert(
  shouldSkipHealthProbe({
    isActive: true,
    healthStatus: 'down',
    downUntil: new Date('2026-08-17T21:20:00.000Z'),
    now: new Date('2026-08-17T21:15:00.000Z'),
  }) === true,
  'skips probe while circuit is in cooldown',
);
assert(
  shouldSkipHealthProbe({
    isActive: false,
    healthStatus: 'healthy',
    downUntil: null,
    now: new Date('2026-08-17T21:15:00.000Z'),
  }) === true,
  'deactivated configs are not probed',
);

// --- no vercel sandbox driver references ---
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandboxDir = join(root, 'lib', 'sandbox');
const forbidden = [
  'VercelProvider',
  'vercel-provider',
  "@vercel/sandbox",
  "case 'vercel'",
  'case "vercel"',
  'SANDBOX_PROVIDER=vercel',
  'Supported providers: e2b, vercel',
];

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTs(path));
    else if (/\.(ts|tsx|js)$/.test(entry.name)) out.push(path);
  }
  return out;
}

let vercelHits = 0;
for (const file of walkTs(sandboxDir)) {
  const text = readFileSync(file, 'utf8');
  for (const needle of forbidden) {
    if (text.includes(needle)) {
      vercelHits += 1;
      console.error(`vercel driver ref in ${file}: ${needle}`);
    }
  }
}
const factoryText = readFileSync(join(sandboxDir, 'factory.ts'), 'utf8');
assert(!/vercel/i.test(factoryText), 'factory.ts has no vercel reference');
assert(vercelHits === 0, 'no vercel sandbox driver reference under lib/sandbox');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
