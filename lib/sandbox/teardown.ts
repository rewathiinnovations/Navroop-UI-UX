/**
 * Typed sandbox teardown. A kill that fails is a fact — not a swallowed log.
 * Open leaks live on AppSetting `sandbox.teardownLeaks` (same counter pattern
 * as `ssrf.privateRejects`) so an admin and the idle reaper can find them
 * without a schema change.
 */
import { log } from '@/lib/logger';

export const SANDBOX_TEARDOWN_LEAKS_KEY = 'sandbox.teardownLeaks';

export type TeardownStatus = 'stopped' | 'already_gone' | 'could_not_stop';

export type TeardownResult =
  | { status: 'stopped'; sandboxId: string | null }
  | { status: 'already_gone'; sandboxId: string | null }
  | { status: 'could_not_stop'; reason: string; sandboxId: string | null };

export type TeardownLeakSource = 'create' | 'boot' | 'kill' | 'test' | 'ephemeral';

export type TeardownLeak = {
  sandboxId: string | null;
  projectId: string | null;
  providerConfigId: string | null;
  driver: string | null;
  reason: string;
  source: TeardownLeakSource;
  at: string;
};

export type TeardownLeakCounts = {
  total: number;
  open: TeardownLeak[];
};

export function teardownStopped(sandboxId: string | null = null): TeardownResult {
  return { status: 'stopped', sandboxId };
}

export function teardownAlreadyGone(sandboxId: string | null = null): TeardownResult {
  return { status: 'already_gone', sandboxId };
}

export function teardownCouldNotStop(reason: string, sandboxId: string | null): TeardownResult {
  return { status: 'could_not_stop', reason, sandboxId };
}

export function isTeardownLeak(outcome: TeardownResult): outcome is Extract<
  TeardownResult,
  { status: 'could_not_stop' }
> {
  return outcome.status === 'could_not_stop';
}

/** Positive gone evidence — reuse each driver's isXSandboxGone at the call site. */
export async function runTeardown(
  sandboxId: string | null,
  kill: () => Promise<void>,
  isGone: (error: unknown) => boolean,
): Promise<TeardownResult> {
  try {
    await kill();
    return teardownStopped(sandboxId);
  } catch (error) {
    if (isGone(error)) return teardownAlreadyGone(sandboxId);
    return teardownCouldNotStop(error instanceof Error ? error.message : String(error), sandboxId);
  }
}

export function unusedSandboxTeardownSuffix(label: string, outcome?: TeardownResult): string {
  if (outcome?.status === 'could_not_stop') {
    return (
      `The sandbox could not be shut down and may still be billed. Try again, or ask an admin to test the ${label} provider on /admin/sandbox-providers.`
    );
  }
  if (outcome?.status === 'stopped' || outcome?.status === 'already_gone') {
    return (
      `The unused sandbox was stopped so it is not billed. Try again, or ask an admin to test the ${label} provider on /admin/sandbox-providers.`
    );
  }
  return (
    `The unused sandbox was asked to stop. Try again, or ask an admin to test the ${label} provider on /admin/sandbox-providers.`
  );
}

const UNUSED_SANDBOX_CLAUSES = [
  'The unused sandbox was asked to stop.',
  'The unused sandbox was stopped so it is not billed.',
  'The sandbox could not be shut down and may still be billed.',
] as const;

/**
 * Swap a placeholder "asked to stop" (or any prior unused-sandbox clause)
 * for the clause that matches a teardown we have now run. Leaves reconnect
 * copy ("is still running") alone — that sentence is a different fact.
 */
export function bindUnusedSandboxOutcome(
  message: string,
  label: string,
  outcome: TeardownResult,
): string {
  const next = unusedSandboxTeardownSuffix(label, outcome);
  const previous = [
    unusedSandboxTeardownSuffix(label),
    unusedSandboxTeardownSuffix(label, { status: 'stopped', sandboxId: null }),
    unusedSandboxTeardownSuffix(label, { status: 'already_gone', sandboxId: null }),
    unusedSandboxTeardownSuffix(label, { status: 'could_not_stop', reason: '', sandboxId: null }),
  ];
  for (const old of previous) {
    if (message.includes(old)) return message.replace(old, next);
  }
  const nextClause = next.replace(
    ` Try again, or ask an admin to test the ${label} provider on /admin/sandbox-providers.`,
    '',
  );
  for (const old of UNUSED_SANDBOX_CLAUSES) {
    if (message.includes(old)) return message.replace(old, nextClause);
  }
  return message;
}

function parseLeaks(value: string | null | undefined): TeardownLeakCounts {
  if (!value) return { total: 0, open: [] };
  try {
    const parsed = JSON.parse(value) as TeardownLeakCounts;
    return {
      total: typeof parsed.total === 'number' ? parsed.total : 0,
      open: Array.isArray(parsed.open) ? parsed.open : [],
    };
  } catch {
    return { total: 0, open: [] };
  }
}

function sameLeak(a: Pick<TeardownLeak, 'sandboxId' | 'projectId'>, b: Pick<TeardownLeak, 'sandboxId' | 'projectId'>) {
  if (a.projectId && b.projectId) return a.projectId === b.projectId;
  if (a.sandboxId && b.sandboxId) return a.sandboxId === b.sandboxId;
  return false;
}

export async function recordSandboxLeak(input: {
  sandboxId: string | null;
  projectId?: string | null;
  providerConfigId?: string | null;
  driver?: string | null;
  reason: string;
  source: TeardownLeakSource;
}): Promise<TeardownLeakCounts> {
  const { prisma } = await import('../db');
  const next: TeardownLeak = {
    sandboxId: input.sandboxId,
    projectId: input.projectId ?? null,
    providerConfigId: input.providerConfigId ?? null,
    driver: input.driver ?? null,
    reason: input.reason,
    source: input.source,
    at: new Date().toISOString(),
  };
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${SANDBOX_TEARDOWN_LEAKS_KEY}))`;
      const row = await tx.appSetting.findUnique({
        where: { key: SANDBOX_TEARDOWN_LEAKS_KEY },
        select: { value: true },
      });
      const counts = parseLeaks(row?.value);
      const existing = counts.open.findIndex((leak) => sameLeak(leak, next));
      if (existing >= 0) {
        counts.open[existing] = next;
      } else {
        counts.total += 1;
        counts.open.push(next);
      }
      const value = JSON.stringify(counts);
      await tx.appSetting.upsert({
        where: { key: SANDBOX_TEARDOWN_LEAKS_KEY },
        create: { key: SANDBOX_TEARDOWN_LEAKS_KEY, value },
        update: { value },
      });
      return counts;
    });
  } catch (error) {
    log.error('sandbox.teardown_leak_record_failed', {
      sandboxId: input.sandboxId,
      projectId: input.projectId ?? null,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function clearSandboxLeak(input: {
  sandboxId?: string | null;
  projectId?: string | null;
}): Promise<TeardownLeakCounts> {
  const { prisma } = await import('../db');
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${SANDBOX_TEARDOWN_LEAKS_KEY}))`;
    const row = await tx.appSetting.findUnique({
      where: { key: SANDBOX_TEARDOWN_LEAKS_KEY },
      select: { value: true },
    });
    const counts = parseLeaks(row?.value);
    counts.open = counts.open.filter((leak) => !sameLeak(leak, { sandboxId: input.sandboxId ?? null, projectId: input.projectId ?? null }));
    const value = JSON.stringify(counts);
    await tx.appSetting.upsert({
      where: { key: SANDBOX_TEARDOWN_LEAKS_KEY },
      create: { key: SANDBOX_TEARDOWN_LEAKS_KEY, value },
      update: { value },
    });
    return counts;
  });
}

export async function getSandboxTeardownLeaks(): Promise<TeardownLeakCounts> {
  try {
    const { prisma } = await import('../db');
    const row = await prisma.appSetting.findUnique({
      where: { key: SANDBOX_TEARDOWN_LEAKS_KEY },
      select: { value: true },
    });
    return parseLeaks(row?.value);
  } catch (error) {
    log.warn('sandbox.teardown_leak_read_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { total: 0, open: [] };
  }
}

export type TeardownCapable = {
  driver?: string;
  terminate: () => Promise<TeardownResult | void>;
  getSandboxInfo?: () => { sandboxId?: string; provider?: string } | null;
};

export function sandboxProviderId(driver: TeardownCapable): string | null {
  if (typeof driver.driver === 'string' && driver.driver.trim()) return driver.driver;
  return driver.getSandboxInfo?.()?.provider ?? null;
}

/**
 * Never throws. A terminate() that still rejects is could_not_stop so the
 * original boot/create cause can stay the thrown error.
 */
export async function teardownProvider(driver: TeardownCapable): Promise<TeardownResult> {
  const sandboxId = driver.getSandboxInfo?.()?.sandboxId ?? null;
  try {
    const result = await driver.terminate();
    if (result && typeof result === 'object' && 'status' in result) return result;
    return teardownStopped(sandboxId);
  } catch (error) {
    return teardownCouldNotStop(error instanceof Error ? error.message : String(error), sandboxId);
  }
}

export async function recordTeardownIfLeaked(
  outcome: TeardownResult,
  extra: {
    projectId?: string | null;
    providerConfigId?: string | null;
    driver?: string | null;
    source: TeardownLeakSource;
  },
): Promise<TeardownResult> {
  if (!isTeardownLeak(outcome)) return outcome;
  try {
    await recordSandboxLeak({
      sandboxId: outcome.sandboxId,
      projectId: extra.projectId,
      providerConfigId: extra.providerConfigId,
      driver: extra.driver,
      reason: outcome.reason,
      source: extra.source,
    });
  } catch (error) {
    log.error('sandbox.teardown_leak_record_failed', {
      sandboxId: outcome.sandboxId,
      source: extra.source,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return outcome;
}
