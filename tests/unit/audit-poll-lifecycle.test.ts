import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Fix round 3, defects A and B: the Quality poll's lifecycle.
 *
 * Round 1 made the poll run while `!hasFiles` and called it self-terminating.
 * Round 2 found that it never terminated and answered with a tick budget —
 * `{ intervalMs: 10_000, maxTicks: 30 }` — which introduced a worse bug and left
 * the original one half-open:
 *
 *  A. **The Scan button dead-ended.** After 30 ticks the interval callback
 *     cleared its own timer, and nothing could re-arm it: the effect's deps were
 *     `[projectId, refresh, scanning, hasFiles]`, `refresh` was keyed on
 *     `projectId` alone, and neither `scanning` nor `hasFiles` can move without a
 *     refresh. So a user who approved a plan and switched to Quality while the
 *     build ran burned the five-minute budget on `hasFiles: false`; the build
 *     finished at minute seven and stored a full site; and `disabled={scanning ||
 *     !hasFiles}` kept Scan dead under the hint "Generate the project first" on a
 *     project that by then had a whole site, until the user switched views or
 *     reloaded.
 *
 *  B. **`scanning` latched on a failing refresh.** The scanning branch kept
 *     `maxTicks: Number.POSITIVE_INFINITY` on the grounds that a scan always
 *     ends — but the applier never cleared `scanning` when the refresh failed.
 *     Delete the project in another tab, or let the session cookie expire, and
 *     every `getLatestCodeAudit` answers `notFound()` / `unauthorized()` forever
 *     while `scanning` stays true, so the tab POSTed a server action every two
 *     seconds for its whole life, on both sub-tabs.
 *
 * This repo has no DOM testing library and Vitest runs in `node` (see the note at
 * the head of `tests/unit/quality-scan-requires-files.test.ts`), so the effect's
 * lifecycle is modelled below — a virtual clock plus React's own re-run rule,
 * driving the real `auditPollDecision` and the real appliers — rather than
 * rendered. The parts that are structural rather than behavioural (which signal
 * the panel learns about new files from, and what disables the button) are
 * asserted against the source, the same pattern those files already use.
 *
 * Round 2 shipped its own suite, `audit-poll-terminates.test.ts`, written against
 * the API it invented — `auditPollPlan(scanning, hasFiles)` answering `{ intervalMs,
 * maxTicks }`. Round 3 replaced that planner with `auditPollDecision` and left the
 * old suite in the tree untouched, so `verify` went red on a symbol that no longer
 * exists. That file is gone and its assertions live here. Most of them only
 * described the tick budget and had to go with it — a test that requires
 * `maxTicks` to be finite is defect A written down — but four described the
 * applier, or a shape that must not come back, and those were carried over rather
 * than dropped along with the file: `void apply(…)` raising no unhandled
 * rejection, `lastError` surviving a *successful* refresh (F-819), a server's own
 * sentence not being overwritten by the transport message, and the round-1
 * condition staying out of the poll effect.
 */

const codeActions = vi.hoisted(() => ({
  getLatestCodeAudit: vi.fn(),
  runCodeAudit: vi.fn(),
  fixCodeFinding: vi.fn(),
  fixAllCodeFindings: vi.fn(),
  toggleIgnoreCodeFinding: vi.fn(),
}));
const seoActions = vi.hoisted(() => ({
  getLatestSeoAudit: vi.fn(),
  runSeoAudit: vi.fn(),
  fixSeoFinding: vi.fn(),
  fixAllSeoFindings: vi.fn(),
  toggleIgnoreFinding: vi.fn(),
}));

vi.mock('@/lib/audit/actions', () => codeActions);
vi.mock('@/lib/seo/actions', () => seoActions);

// Dynamic so the mocks above are installed before the hook modules evaluate; a
// static import would be hoisted past them and pull the real server actions (and
// Prisma) in.
const poll = await import('@/components/workspace/audit-poll');
const code = await import('@/components/workspace/useCodeAudit');
const seo = await import('@/components/workspace/useSeoAudit');

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
function readSource(relative: string): string {
  return readFileSync(join(ROOT, relative), 'utf8');
}

type HarnessSetters = {
  setError: (value: string | null) => void;
  setAudit: (value: unknown) => void;
  setScanning: (value: boolean) => void;
  setHasFiles: (value: boolean) => void;
  setFilesHint: (value: string | null) => void;
};

/**
 * The hook's poll, without React.
 *
 * It holds the same five pieces of state the hook does, runs the same three
 * effects (mount refresh, `PROJECT_FILES_CHANGED_EVENT` refresh, poll interval),
 * and re-runs the poll effect exactly when React would — when one of the deps it
 * actually watches (`scanning`, `failures`, `stopped`) changed value, which tears
 * the old interval down through the cleanup and arms a fresh one. `now` is
 * virtual, so a seven-minute wait or an hour of tab time costs no wall time.
 */
class PollSim {
  now = 0;
  scanning = false;
  hasFiles = false;
  filesHint: string | null = null;
  error: string | null = null;
  audit: unknown = null;
  failures = 0;
  stopped = false;
  /** One entry per interval armed, in order — the backoff ladder, observable. */
  intervals: number[] = [];
  refreshes = 0;
  /** Virtual clock reading of the last tick, so "it stopped trying" has a time. */
  lastRefreshAt = 0;

  private lastDeps = '';
  private dueAt: number | null = null;
  private intervalMs: number | null = null;

  constructor(private readonly apply: (set: HarnessSetters) => Promise<poll.AuditRefreshOutcome>) {}

  private setters(): HarnessSetters {
    return {
      setError: (value) => {
        this.error = value;
      },
      setAudit: (value) => {
        this.audit = value;
      },
      setScanning: (value) => {
        this.scanning = value;
      },
      setHasFiles: (value) => {
        this.hasFiles = value;
      },
      setFilesHint: (value) => {
        this.filesHint = value;
      },
    };
  }

  /** The hook's `refresh`, including what it does with the outcome. */
  async refresh(): Promise<void> {
    this.refreshes += 1;
    this.lastRefreshAt = this.now;
    const outcome = await this.apply(this.setters());
    if (outcome === 'terminal') {
      this.stopped = true;
    } else {
      this.failures = outcome === 'transient' ? this.failures + 1 : 0;
    }
    this.runPollEffect();
  }

  /** The polling effect, re-run the way React re-runs it. */
  private runPollEffect(): void {
    const deps = `${this.scanning}|${this.failures}|${this.stopped}`;
    if (deps === this.lastDeps) return;
    this.lastDeps = deps;
    const decision = poll.auditPollDecision({
      scanning: this.scanning,
      failures: this.failures,
      stopped: this.stopped,
    });
    if (!decision.poll) {
      this.dueAt = null;
      this.intervalMs = null;
      if (decision.reason === 'unreachable') {
        this.error = poll.AUDIT_UNREACHABLE;
        this.scanning = false;
        this.runPollEffect();
      }
      return;
    }
    this.intervalMs = decision.intervalMs;
    this.intervals.push(decision.intervalMs);
    this.dueAt = this.now + decision.intervalMs;
  }

  /** The mount effect. */
  async mount(): Promise<void> {
    await this.refresh();
  }

  /** What the `PROJECT_FILES_CHANGED_EVENT` listener does. */
  async filesChanged(): Promise<void> {
    await this.refresh();
  }

  /** What pressing Scan does to this state, before the server is asked. */
  pressScan(): void {
    this.error = null;
    this.failures = 0;
    this.stopped = false;
    this.scanning = true;
    this.runPollEffect();
  }

  /** Runs the virtual clock forward by `ms`, firing every tick that comes due. */
  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    let fired = 0;
    while (this.dueAt !== null && this.dueAt <= target) {
      if ((fired += 1) > 50_000) throw new Error('the poll never stopped');
      const firedAt = this.dueAt;
      this.now = firedAt;
      await this.refresh();
      // A tick that did not change a dep leaves the same interval running.
      if (this.dueAt === firedAt) this.dueAt = firedAt + (this.intervalMs ?? 0);
    }
    this.now = target;
  }
}

type HookUnderTest = {
  name: string;
  load: ReturnType<typeof vi.fn>;
  sim: () => PollSim;
  source: string;
  panel: string;
};

const HOOKS: HookUnderTest[] = [
  {
    name: 'useCodeAudit',
    load: codeActions.getLatestCodeAudit,
    sim: () => new PollSim((set) => code.applyLatestCodeAudit('p1', set)),
    source: 'components/workspace/useCodeAudit.ts',
    panel: 'components/workspace/CodeAuditPanel.tsx',
  },
  {
    name: 'useSeoAudit',
    load: seoActions.getLatestSeoAudit,
    sim: () => new PollSim((set) => seo.applyLatestSeoAudit('p1', set)),
    source: 'components/workspace/useSeoAudit.ts',
    panel: 'components/workspace/SeoPanel.tsx',
  },
];

function answered(data: {
  scanning?: boolean;
  hasFiles?: boolean;
  filesHint?: string | null;
  lastError?: string | null;
}) {
  return {
    ok: true,
    data: {
      audit: null,
      scanning: data.scanning ?? false,
      lastError: data.lastError ?? null,
      hasFiles: data.hasFiles ?? false,
      filesHint: data.filesHint ?? null,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe.each(HOOKS)('$name: defect A — the wait for files never dead-ends', (hook) => {
  it('costs nothing while no scan is running, and still learns the build finished', async () => {
    // The defect verbatim: plan approved, user switches to Quality while the build
    // runs, `hasFiles` false. Round 2 spent a 30-tick budget here and then cleared
    // its own interval for good.
    hook.load.mockResolvedValue(
      answered({ hasFiles: false, filesHint: 'Generate the project first' }),
    );
    const sim = hook.sim();
    await sim.mount();
    expect(sim.hasFiles).toBe(false);

    // Seven minutes of build. Nothing is in flight, so nothing is polled: the
    // budget that used to expire in here does not exist.
    await sim.advance(7 * 60_000);
    expect(sim.refreshes).toBe(1);
    expect(sim.intervals).toEqual([]);

    // The build settles and stores a full site. `generation-runtime` dispatches
    // PROJECT_FILES_CHANGED_EVENT, the same signal the preview rebuilds on.
    hook.load.mockResolvedValue(answered({ hasFiles: true }));
    await sim.filesChanged();

    // Two minutes past where the old budget ran out, and the panel knows.
    expect(sim.hasFiles).toBe(true);
    expect(sim.filesHint).toBeNull();
  });

  it('has no tick budget that can expire under a scan that is still running', async () => {
    // Round 2's budget lived on the idle branch, but the shape is what matters:
    // a countdown is only ever right if it can be re-armed, and this effect could
    // not be. A thousand ticks in, the watch is still armed at full speed.
    hook.load.mockResolvedValue(answered({ scanning: true, hasFiles: true }));
    const sim = hook.sim();
    sim.pressScan();
    await sim.advance(1000 * poll.AUDIT_SCAN_POLL_MS);

    expect(sim.refreshes).toBe(1000);
    expect(sim.scanning).toBe(true);
    expect(sim.stopped).toBe(false);
    expect(new Set(sim.intervals)).toEqual(new Set([poll.AUDIT_SCAN_POLL_MS]));

    // And it ends the moment the scan does, without a timer deciding it.
    hook.load.mockResolvedValue(answered({ scanning: false, hasFiles: true }));
    await sim.advance(60 * 60_000);
    expect(sim.scanning).toBe(false);
    expect(sim.refreshes).toBe(1001);
  });

  it('listens for the workspace signal instead of asking on a timer', () => {
    // "Does this project have files yet" is not the poll's question — the
    // workspace already broadcasts when a generation settles or a checkpoint is
    // restored, and that is the signal that must re-enable Scan.
    const src = readSource(hook.source);
    expect(src).toMatch(/PROJECT_FILES_CHANGED_EVENT/);
    expect(src).toMatch(/window\.addEventListener\(PROJECT_FILES_CHANGED_EVENT/);
    expect(src).toMatch(/window\.removeEventListener\(PROJECT_FILES_CHANGED_EVENT/);
    // No budget survives anywhere in the hook.
    expect(src).not.toMatch(/maxTicks|ticksLeft|IDLE_POLL_TICKS/);
    // Nor round 1's shape, which is the other way this effect stops terminating:
    // it claimed to be self-terminating because `hasFiles` "stays true once it
    // flips", and a project stuck in PLANNING never flips it. Anchored to the start
    // of a line so the doc comment that quotes the condition, to say why it went,
    // does not satisfy the check.
    expect(src).not.toMatch(/^\s*if \(!projectId \|\| \(!scanning && hasFiles\)\) return;/m);
  });

  it('does not let a stale hasFiles disable Scan', () => {
    // The user-facing half of defect A. `hasFiles` is the last answer this panel
    // heard, not a fact about the project now, so it may inform the hint and must
    // not gate the button.
    const panel = readSource(hook.panel);
    expect(panel).toMatch(/disabled=\{scanning\}/);
    expect(panel).not.toMatch(/disabled=\{scanning \|\| !hasFiles\}/);
    // The hint still says what to expect before the click.
    expect(panel).toMatch(/filesHint \?\? 'Generate the project first'/);
  });
});

describe.each(HOOKS)('$name: defect B — a scan that can no longer be observed', (hook) => {
  it('stops for good when the project is deleted in another tab', async () => {
    hook.load.mockResolvedValue(answered({ scanning: true, hasFiles: true }));
    const sim = hook.sim();
    sim.pressScan();
    await sim.advance(10_000);
    const beforeDelete = sim.refreshes;
    expect(beforeDelete).toBe(5);

    // The project is deleted elsewhere: `getLatest*Audit` answers notFound() from
    // here on. Before the fix `scanning` stayed true (the `!ok` branch set only
    // the error) and `ticksLeft -= 1` on Infinity is Infinity, so this ran every
    // two seconds for the life of the tab.
    hook.load.mockResolvedValue({ ok: false, error: 'Project not found', status: 404 });
    await sim.advance(60 * 60_000);

    expect(sim.refreshes).toBe(beforeDelete + 1);
    expect(sim.scanning).toBe(false);
    expect(sim.stopped).toBe(true);
    expect(sim.error).toBe(poll.terminalAuditMessage(404, 'Project not found'));
    expect(sim.error).toMatch(/no longer exists/);
  });

  it('stops for good when the session cookie expires, and says what to do', async () => {
    hook.load.mockResolvedValue(answered({ scanning: true, hasFiles: true }));
    const sim = hook.sim();
    sim.pressScan();
    await sim.advance(4000);

    hook.load.mockResolvedValue({ ok: false, error: 'Sign in required', status: 401 });
    await sim.advance(60 * 60_000);

    expect(sim.refreshes).toBe(3);
    expect(sim.scanning).toBe(false);
    expect(sim.error).toMatch(/session has expired/i);
    // Actionable: the terse server sentence would read as a bug on a panel the
    // user is staring at.
    expect(sim.error).not.toBe('Sign in required');
  });

  it('retries a transient failure with backoff, then gives up and hands the panel back', async () => {
    hook.load.mockResolvedValue(answered({ scanning: true, hasFiles: true }));
    const sim = hook.sim();
    sim.pressScan();
    hook.load.mockRejectedValue(new Error('fetch failed'));

    await sim.advance(60 * 60_000);

    // 2s, then doubling to the one-a-minute ceiling — about two minutes of trying
    // rather than two seconds forever.
    expect(sim.intervals).toEqual([2000, 4000, 8000, 16_000, 32_000, 60_000]);
    expect(sim.refreshes).toBe(poll.AUDIT_GIVE_UP_AFTER);
    // It gave up inside a few minutes rather than at the end of the hour.
    expect(sim.lastRefreshAt).toBeLessThanOrEqual(4 * 60_000);
    expect(sim.error).toBe(poll.AUDIT_UNREACHABLE);
    // The spinner stops and the button comes back, which is the only thing the
    // user can still act on.
    expect(sim.scanning).toBe(false);
  });

  it('a transient blip does not stop the watch', async () => {
    hook.load.mockResolvedValue(answered({ scanning: true, hasFiles: true }));
    const sim = hook.sim();
    sim.pressScan();
    await sim.advance(2000);

    hook.load.mockResolvedValueOnce({ ok: false, error: 'Something went wrong', status: 500 });
    await sim.advance(4000);
    expect(sim.failures).toBe(1);
    expect(sim.scanning).toBe(true);
    expect(sim.stopped).toBe(false);

    // The next answer clears the count and the cadence returns to full speed.
    await sim.advance(4000);
    expect(sim.failures).toBe(0);
    expect(sim.intervals).toEqual([2000, 4000, 2000]);
  });

  it('a press of Scan restarts a watch that had stopped', async () => {
    hook.load.mockResolvedValue({ ok: false, error: 'Project not found', status: 404 });
    const sim = hook.sim();
    sim.pressScan();
    await sim.advance(60 * 60_000);
    expect(sim.stopped).toBe(true);

    hook.load.mockResolvedValue(answered({ scanning: true, hasFiles: true }));
    sim.pressScan();
    await sim.advance(6000);

    expect(sim.stopped).toBe(false);
    expect(sim.failures).toBe(0);
    expect(sim.scanning).toBe(true);
  });
});

describe('auditPollDecision owns the rule for both hooks', () => {
  it('is imported, not restated — round 2 fixed one copy and left the other', () => {
    for (const hook of HOOKS) {
      const src = readSource(hook.source);
      expect(src).toMatch(/from '\.\/audit-poll'/);
      expect(src).toMatch(/auditPollDecision\(\{ scanning, failures, stopped \}\)/);
      // No second, drifting copy of the decision in either hook.
      expect(src).not.toMatch(/function auditPoll/);
    }
  });

  it('costs nothing while nothing is in flight', () => {
    expect(poll.auditPollDecision({ scanning: false, failures: 0, stopped: false })).toEqual({
      poll: false,
      reason: 'idle',
    });
    // Including on a project with no files — that wait is an event now, not a timer.
    expect(poll.auditPollDecision({ scanning: false, failures: 4, stopped: false })).toEqual({
      poll: false,
      reason: 'idle',
    });
  });

  it('never returns an unbounded watch on an endpoint that has stopped answering', () => {
    expect(poll.auditPollDecision({ scanning: true, failures: 0, stopped: true })).toEqual({
      poll: false,
      reason: 'terminal',
    });
    expect(
      poll.auditPollDecision({
        scanning: true,
        failures: poll.AUDIT_GIVE_UP_AFTER,
        stopped: false,
      }),
    ).toEqual({ poll: false, reason: 'unreachable' });
  });

  it('caps the backoff so a long outage still costs about one read a minute', () => {
    for (let failures = 1; failures < poll.AUDIT_GIVE_UP_AFTER; failures += 1) {
      const decision = poll.auditPollDecision({ scanning: true, failures, stopped: false });
      expect(decision.poll).toBe(true);
      if (!decision.poll) throw new Error('unreachable');
      expect(decision.intervalMs).toBeGreaterThanOrEqual(poll.AUDIT_RETRY_BASE_MS);
      expect(decision.intervalMs).toBeLessThanOrEqual(poll.AUDIT_RETRY_MAX_MS);
    }
  });

  it('treats exactly the refusals that will not change as terminal', () => {
    expect([401, 403, 404].map(poll.isTerminalAuditStatus)).toEqual([true, true, true]);
    expect([400, 409, 500, 502, 503, undefined].map(poll.isTerminalAuditStatus)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it('keeps the server sentence for a terminal status it does not recognise', () => {
    expect(poll.terminalAuditMessage(418, 'Teapot')).toBe('Teapot');
  });

  it('is the same rule on both sides of the Quality tab', () => {
    expect(code.AUDIT_REFRESH_FAILED).toBe(seo.AUDIT_REFRESH_FAILED);
    expect(code.AUDIT_UNREACHABLE).toBe(seo.AUDIT_UNREACHABLE);
    expect(code.AUDIT_REFRESH_FAILED).toBe(poll.AUDIT_REFRESH_FAILED);
  });
});

describe.each(HOOKS)('$name: the applier reports the outcome the poll acts on', (hook) => {
  const APPLIERS = {
    useCodeAudit: (set: HarnessSetters) => code.applyLatestCodeAudit('p1', set),
    useSeoAudit: (set: HarnessSetters) => seo.applyLatestSeoAudit('p1', set),
  } as const;

  function setters() {
    return {
      setError: vi.fn(),
      setAudit: vi.fn(),
      setScanning: vi.fn(),
      setHasFiles: vi.fn(),
      setFilesHint: vi.fn(),
    };
  }

  const apply = APPLIERS[hook.name as keyof typeof APPLIERS];

  // Node reports an unhandled rejection on the process, not to the caller, so the
  // only way to see one is to listen for it. Registered per-test and removed
  // again: a listener left attached would swallow the report for every suite that
  // runs after this one in the same worker.
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };

  beforeEach(() => {
    unhandled.length = 0;
    process.on('unhandledRejection', onUnhandled);
  });

  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
  });

  it('clears scanning on a terminal refusal — the latch that kept the poll alive', async () => {
    hook.load.mockResolvedValue({ ok: false, error: 'Project not found', status: 404 });
    const set = setters();

    await expect(apply(set)).resolves.toBe('terminal');

    expect(set.setScanning).toHaveBeenCalledWith(false);
    expect(set.setAudit).not.toHaveBeenCalled();
  });

  it('leaves scanning alone on a transient failure — the scan may still be running', async () => {
    hook.load.mockResolvedValue({ ok: false, error: 'Something went wrong', status: 500 });
    const set = setters();

    await expect(apply(set)).resolves.toBe('transient');

    expect(set.setScanning).not.toHaveBeenCalled();
    expect(set.setError).toHaveBeenCalledWith('Something went wrong');
    // The server said something specific about why it refused; the generic
    // "check your connection" line is for a call that never got an answer at all,
    // and replacing one with the other tells the user to fix the wrong thing.
    expect(set.setError).not.toHaveBeenCalledWith(poll.AUDIT_REFRESH_FAILED);
  });

  it('reports a rejected call as transient rather than throwing at the poll', async () => {
    hook.load.mockRejectedValue(new Error('offline'));
    const set = setters();

    await expect(apply(set)).resolves.toBe('transient');

    expect(set.setError).toHaveBeenCalledWith(poll.AUDIT_REFRESH_FAILED);
  });

  it('still reports a detached scan failure through lastError on the success path (F-819)', async () => {
    // The refresh succeeded; the *scan* it is reporting on did not. The hook used
    // to clear its own error unconditionally on every good tick, so a paid audit
    // that failed in the background left a stopped spinner and no explanation.
    hook.load.mockResolvedValue(
      answered({ lastError: 'The scan could not read the preview.', hasFiles: true }),
    );
    const set = setters();

    await expect(apply(set)).resolves.toBe('ok');

    expect(set.setError).toHaveBeenCalledWith('The scan could not read the preview.');
    expect(set.setHasFiles).toHaveBeenCalledWith(true);
  });

  it('produces no unhandled rejection when called the way the poll calls it', async () => {
    hook.load.mockRejectedValue(new Error('offline'));

    // `void refresh()` is exactly how the mount effect, the files-changed listener
    // and every poll tick call this. Nothing awaits the promise, so a throw that
    // escapes the applier is an unhandled rejection — once per tick, for as long
    // as the tab is open, which is what the catch inside it exists to stop.
    void apply(setters());
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(unhandled).toEqual([]);
  });
});
