import type { MockInstance } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What a redeploy is allowed to cost.
 *
 * The SIGTERM handler existed to make a deploy honest: mark this instance's in-flight jobs
 * `deploying` so the workspace recovery panel appears at once instead of after a 60-second
 * stale heartbeat. It awaited `abandonInstanceJobs` with no deadline, and that function writes
 * one row per job serially — so when Postgres was the reason for the restart, or merely slow,
 * the await never settled, `process.exit(0)` was never reached, and the container sat there
 * until Docker's SIGKILL. The jobs then stayed RUNNING under a dead instance and only surfaced
 * a minute later through `reap-jobs`, which is the frozen-generation symptom draining exists to
 * prevent — paid for with a stuck deploy.
 *
 * Goes red if the drain becomes unbounded again, if a drain error or a timeout stops the
 * process from exiting, if the jobs stop being marked recoverable, or if SIGINT loses its
 * handler.
 */

const lifecycle = vi.hoisted(() => ({ abandonInstanceJobs: vi.fn() }));

vi.mock('@/lib/jobs/lifecycle', () => ({ abandonInstanceJobs: lifecycle.abandonInstanceJobs }));

const SIGNALS = ['SIGTERM', 'SIGINT'] as const;

let exit: MockInstance<(code?: number) => never>;
let before: Record<string, unknown[]>;

/**
 * The listener is invoked directly rather than through `process.emit`, because emitting a real
 * signal in the worker would also run Vitest's own handlers and take the run down with it.
 */
function listenerFor(signal: (typeof SIGNALS)[number]) {
  const added = process.listeners(signal).filter((fn) => !before[signal].includes(fn));
  expect(added, `${signal} has no handler`).toHaveLength(1);
  return added[0] as () => void;
}

async function wire() {
  vi.resetModules();
  const { wireShutdownDrain } = await import('@/lib/runtime/shutdown');
  wireShutdownDrain();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  before = Object.fromEntries(SIGNALS.map((signal) => [signal, [...process.listeners(signal)]]));
  exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
});

afterEach(() => {
  // Every listener this file added is removed again: a leaked handler would call
  // `process.exit` for real the next time anything signals the worker.
  for (const signal of SIGNALS) {
    for (const fn of process.listeners(signal)) {
      if (!before[signal].includes(fn)) process.off(signal, fn as never);
    }
  }
  exit.mockRestore();
  vi.useRealTimers();
});

describe('the shutdown drain', () => {
  it('marks this instance\u2019s jobs recoverable and then exits', async () => {
    lifecycle.abandonInstanceJobs.mockResolvedValue(3);
    await wire();

    listenerFor('SIGTERM')();
    await vi.advanceTimersByTimeAsync(0);

    // `deploying` is the reason the recovery panel shows "the server is deploying" rather than
    // an unexplained abandoned job.
    expect(lifecycle.abandonInstanceJobs).toHaveBeenCalledWith('deploying');
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits on a drain that never settles, instead of waiting for SIGKILL', async () => {
    // Resolvers are captured and never called: this is the slow-Postgres case.
    lifecycle.abandonInstanceJobs.mockReturnValue(Promise.withResolvers<number>().promise);
    await wire();

    listenerFor('SIGTERM')();
    await vi.advanceTimersByTimeAsync(1_000);
    // Still draining: the deadline is a backstop, not a race the drain usually loses.
    expect(exit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits when the drain throws, because the jobs are recoverable either way', async () => {
    lifecycle.abandonInstanceJobs.mockRejectedValue(new Error('connection terminated'));
    await wire();

    listenerFor('SIGTERM')();
    await vi.advanceTimersByTimeAsync(0);

    expect(exit).toHaveBeenCalledWith(0);
  });

  it('drains on SIGINT too, so a local Ctrl-C leaves the same recoverable state', async () => {
    lifecycle.abandonInstanceJobs.mockResolvedValue(1);
    await wire();

    listenerFor('SIGINT')();
    await vi.advanceTimersByTimeAsync(0);

    expect(lifecycle.abandonInstanceJobs).toHaveBeenCalledWith('deploying');
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('wires each signal once, however many times it is called', async () => {
    lifecycle.abandonInstanceJobs.mockResolvedValue(0);
    vi.resetModules();
    const { wireShutdownDrain } = await import('@/lib/runtime/shutdown');
    wireShutdownDrain();
    wireShutdownDrain();

    // A second registration would drain and exit twice per signal.
    for (const signal of SIGNALS) listenerFor(signal);
  });
});
