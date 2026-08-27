/*
 * The harness below calls `useGenerationJob` from a plain render loop, against the hooks
 * dispatcher this file installs in place of React's. That is the point of it — the defect
 * here is only visible when the effects re-run for the reasons a browser re-runs them — and
 * it is exactly what this rule exists to forbid in application code.
 */
/* eslint-disable react-hooks/rules-of-hooks */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * MEASURED on the running app: forty seconds with nothing happening, and
 * `GET /api/projects/{id}/job` eleven times, roughly one every 3.6s, forever. The project row
 * said phase COMPLETE, the BUILD job said SUCCEEDED with a `finishedAt`, and no scan was in
 * flight — so `jobWatchIsLive` should have been false and `tick` would have bailed on the
 * first settled read. It polled anyway.
 *
 * The cadence was the tell: it is not `POLL_FAST_MS` and not `POLL_SLOW_MS`. Those reads came
 * from the focus/visibility catch-up, which listens for window `focus` as well as
 * `visibilitychange` — the preview iframe hands focus back on its own — and which the
 * generation runtime's `isJobActive` reopened on its own. That flag is `generating` /
 * `applying` in this tab; a run that never cleared it left all three guards
 * (`jobWatchIsLive`, `shouldFetchOnWatchStart`, `shouldCatchUpOnVisible`) holding the watch
 * open on a row that could not change again.
 *
 * These drive the shipped hook rather than its predicates: each of the predicates answered
 * correctly for the arguments it was given, and the defect was in the argument. `react` is
 * replaced with a minimal hooks runtime — state, refs, callbacks and effects with dependency
 * comparison and cleanup — so effects re-run for the reasons they re-run in a browser and
 * every request the hook makes is counted.
 */

type Cell = { value?: unknown; deps?: unknown[]; cleanup?: (() => void) | void };

/**
 * A hooks dispatcher standing in for React, faithful in the parts this hook uses: cells keyed
 * by call order, `useState` bailing out on an `Object.is`-equal write, `useCallback`
 * re-creating only on a dependency change, an effect's cleanup running before its next create,
 * and a write during render re-running the render before effects (which is how the hook
 * records the row it held when a stream began). Concurrent rendering and Strict Mode's
 * double-invoke are not modelled; neither changes what is measured here.
 */
const runtime = vi.hoisted(() => {
  const cells: Cell[] = [];
  let index = 0;
  let onUpdate: (() => void) | null = null;
  let queue: Array<{ cell: Cell; create: () => (() => void) | void; deps?: unknown[] }> = [];

  const sameDeps = (a: unknown[] | undefined, b: unknown[] | undefined) =>
    Boolean(a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i])));

  function cell(): Cell {
    const found = cells[index] ?? (cells[index] = {});
    index += 1;
    return found;
  }

  return {
    beginRender(update: () => void) {
      index = 0;
      onUpdate = update;
    },
    /** After the render commits, in React's order: every destroy, then every create. */
    flushEffects() {
      const pending = queue;
      queue = [];
      for (const entry of pending) entry.cell.cleanup?.();
      for (const entry of pending) {
        entry.cell.cleanup = entry.create();
        entry.cell.deps = entry.deps;
      }
    },
    /** Tears the whole tree down, so nothing from one case can run inside the next. */
    unmount() {
      for (const entry of cells) entry.cleanup?.();
      cells.length = 0;
      index = 0;
      queue = [];
      onUpdate = null;
    },
    useState(initial: unknown) {
      const slot = cell();
      if (!('value' in slot)) {
        slot.value = typeof initial === 'function' ? (initial as () => unknown)() : initial;
      }
      const set = (next: unknown) => {
        const value =
          typeof next === 'function' ? (next as (prev: unknown) => unknown)(slot.value) : next;
        if (Object.is(value, slot.value)) return;
        slot.value = value;
        onUpdate?.();
      };
      return [slot.value, set];
    },
    useRef(initial: unknown) {
      const slot = cell();
      if (!('value' in slot)) slot.value = { current: initial };
      return slot.value;
    },
    useCallback(fn: unknown, deps: unknown[]) {
      const slot = cell();
      if (!sameDeps(slot.deps, deps)) {
        slot.deps = deps;
        slot.value = fn;
      }
      return slot.value;
    },
    useEffect(create: () => (() => void) | void, deps?: unknown[]) {
      const slot = cell();
      if (slot.deps && deps && sameDeps(slot.deps, deps)) return;
      queue.push({ cell: slot, create, deps });
    },
  };
});

vi.mock('react', () => ({
  useState: runtime.useState,
  useRef: runtime.useRef,
  useCallback: runtime.useCallback,
  useEffect: runtime.useEffect,
}));

const { streamOutrunsHeldRow, useGenerationJob } = await import(
  '@/components/workspace/useGenerationJob'
);

type Props = Parameters<typeof useGenerationJob>[0];

type JobRow = {
  id: string;
  kind: string;
  status: string;
  startedAt?: string | null;
  createdAt?: string | null;
  heartbeatAt?: string | null;
  finishedAt?: string | null;
};

const fetchSpy = vi.fn();
/** What `GET /api/projects/{id}/job` answers, swapped as a test moves the world on. */
let served: JobRow | null = null;
const windowListeners = new Map<string, Set<() => void>>();
const documentListeners = new Map<string, Set<() => void>>();

function bind(store: Map<string, Set<() => void>>) {
  return {
    addEventListener: (type: string, fn: () => void) => {
      const set = store.get(type) ?? new Set();
      set.add(fn);
      store.set(type, set);
    },
    removeEventListener: (type: string, fn: () => void) => {
      store.get(type)?.delete(fn);
    },
  };
}

beforeAll(() => {
  Object.assign(globalThis, {
    window: {
      ...bind(windowListeners),
      // Resolved at call time, so the fake timers installed per test own them.
      setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms) as unknown as number,
      clearTimeout: (id: number) => clearTimeout(id as unknown as NodeJS.Timeout),
    },
    document: { ...bind(documentListeners), visibilityState: 'visible' },
    fetch: fetchSpy,
  });
});

afterAll(() => {
  Reflect.deleteProperty(globalThis, 'window');
  Reflect.deleteProperty(globalThis, 'document');
  Reflect.deleteProperty(globalThis, 'fetch');
});

beforeEach(() => {
  // Fake timers keep every wait in this file bounded: the catch-up has a POLL_FAST_MS floor
  // under it, and a running build reschedules itself for as long as it is watched.
  vi.useFakeTimers();
  fetchSpy.mockReset();
  fetchSpy.mockImplementation(async () => ({ ok: true, json: async () => ({ job: served }) }));
  windowListeners.clear();
  documentListeners.clear();
  served = null;
});

afterEach(() => {
  runtime.unmount();
  vi.clearAllTimers();
  vi.useRealTimers();
});

/** One mounted `useGenerationJob`, re-rendered the way a parent re-renders it. */
function mount(initial: Props) {
  let props = initial;
  let result: ReturnType<typeof useGenerationJob> | null = null;
  let rendering = false;
  let scheduled = false;
  let again = false;
  let live = true;
  // A hard ceiling. Without it a state write that re-triggers itself turns this harness into
  // an unbounded render/fetch loop that eats the whole heap and takes the vitest run with it.
  let renders = 0;

  const onUpdate = () => {
    if (!live) return;
    if (rendering) {
      again = true;
      return;
    }
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      renderLoop();
    });
  };

  const renderLoop = () => {
    if (!live || rendering) return;
    rendering = true;
    for (let pass = 0; pass < 20; pass += 1) {
      renders += 1;
      if (renders > 500) throw new Error('render loop did not settle');
      again = false;
      runtime.beginRender(onUpdate);
      result = useGenerationJob(props);
      runtime.flushEffects();
      if (!again) break;
    }
    rendering = false;
  };

  renderLoop();
  return {
    get result() {
      if (!result) throw new Error('not rendered');
      return result;
    },
    get reads() {
      return fetchSpy.mock.calls.length;
    },
    rerender(next?: Partial<Props>) {
      props = { ...props, ...next };
      renderLoop();
    },
    unmount() {
      live = false;
      runtime.unmount();
    },
  };
}

/** Flush the promises a read is made of, plus any render they scheduled. */
async function settle() {
  for (let i = 0; i < 4; i += 1) await vi.advanceTimersByTimeAsync(0);
}

/** Everything that reaches the catch-up listeners, spaced past its POLL_FAST_MS floor. */
async function lookBackAtTheTab(times = 3) {
  for (let i = 0; i < times; i += 1) {
    await vi.advanceTimersByTimeAsync(2_500);
    for (const fn of [...(windowListeners.get('focus') ?? [])]) fn();
    for (const fn of [...(documentListeners.get('visibilitychange') ?? [])]) fn();
    await settle();
  }
}

const PLAN_DONE: JobRow = {
  id: 'job-plan-1',
  kind: 'PLAN',
  status: 'SUCCEEDED',
  startedAt: new Date(Date.now() - 120_000).toISOString(),
  createdAt: new Date(Date.now() - 125_000).toISOString(),
  heartbeatAt: new Date(Date.now() - 110_000).toISOString(),
  finishedAt: new Date(Date.now() - 110_000).toISOString(),
};

const BUILD_RUNNING: JobRow = {
  id: 'job-build-1',
  kind: 'BUILD',
  status: 'RUNNING',
  startedAt: new Date().toISOString(),
  createdAt: new Date().toISOString(),
  heartbeatAt: new Date().toISOString(),
  finishedAt: null,
};

describe('a build this tab ran, then finished', () => {
  /**
   * The measured sequence, start to finish: a plan is approved, the build streams into this
   * tab, the build succeeds, the phase settles to COMPLETE — and the runtime is left on
   * `generating`, which is the state the capture was taken in. From there the workspace is
   * doing nothing, and it has to cost nothing.
   */
  async function runABuildAndLeaveTheFlagStuck() {
    served = PLAN_DONE;
    const view = mount({ projectId: 'proj-1', phase: 'PLANNING', isJobActive: false });
    await settle();
    expect(view.result.job?.id).toBe('job-plan-1');

    // Approve. `approvePlan` writes the BUILD row inside the same POST, so it is already
    // there when the phase flips and the stream starts.
    served = { ...BUILD_RUNNING, status: 'QUEUED', startedAt: null, heartbeatAt: null };
    view.rerender({ phase: 'BUILDING', isJobActive: true });
    await settle();
    served = BUILD_RUNNING;
    await vi.advanceTimersByTimeAsync(2_500);
    await settle();
    expect(view.result.job?.id).toBe('job-build-1');
    expect(view.result.job?.status).toBe('RUNNING');

    // It finishes. `isJobActive` stays true — the defect is that nothing here may depend on
    // the runtime clearing it.
    served = {
      ...BUILD_RUNNING,
      status: 'SUCCEEDED',
      heartbeatAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    };
    await vi.advanceTimersByTimeAsync(2_500);
    await settle();
    view.rerender({ phase: 'COMPLETE' });
    await settle();
    return view;
  }

  it('stops reading the job endpoint once the build has settled', async () => {
    const view = await runABuildAndLeaveTheFlagStuck();
    const settledAt = view.reads;
    await lookBackAtTheTab();
    await vi.advanceTimersByTimeAsync(40_000);
    await settle();

    expect(view.reads).toBe(settledAt);
    view.unmount();
  });

  it('buys nothing from a parent re-rendering for its own reasons', async () => {
    const view = await runABuildAndLeaveTheFlagStuck();
    const settledAt = view.reads;

    // Presence, the preview, a hover: whatever re-renders the workspace at rest.
    for (let i = 0; i < 12; i += 1) {
      view.rerender({});
      await settle();
    }

    expect(view.reads).toBe(settledAt);
    view.unmount();
  });

  it('shows the chat the row rather than hiding it behind a stream that ended', async () => {
    // The mask exists so the previous turn's SUCCEEDED cannot silence the next one. Held over
    // a row that *is* this stream's outcome it does the opposite: the chat waits forever on a
    // turn that finished.
    const view = await runABuildAndLeaveTheFlagStuck();
    expect(view.result.job?.status).toBe('SUCCEEDED');
    expect(view.result.recovery).toBe(false);
    view.unmount();
  });

  it('stops just as flatly when the workspace was reopened after the fact', async () => {
    // Navigating away and back remounts the workspace while the module-level runtime is still
    // flagged, so this hook holds no row at all when it first sees the flag.
    served = {
      ...BUILD_RUNNING,
      status: 'SUCCEEDED',
      finishedAt: new Date(Date.now() - 60_000).toISOString(),
      heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
    };
    const view = mount({ projectId: 'proj-1', phase: 'COMPLETE', isJobActive: true });
    await settle();
    const opening = view.reads;
    expect(opening).toBeGreaterThan(0);

    await lookBackAtTheTab();
    await vi.advanceTimersByTimeAsync(40_000);
    await settle();

    expect(view.reads).toBe(opening);
    view.unmount();
  });
});

describe('a build still being watched keeps being watched', () => {
  it('polls a RUNNING job on its own interval', async () => {
    served = BUILD_RUNNING;
    const view = mount({ projectId: 'proj-1', phase: 'BUILDING', isJobActive: false });
    await settle();
    const opening = view.reads;
    expect(opening).toBeGreaterThan(0);

    await vi.advanceTimersByTimeAsync(2_500);
    await settle();
    expect(view.reads).toBeGreaterThan(opening);
    view.unmount();
  });

  it('polls a QUEUED job, which has no heartbeat to be judged by', async () => {
    served = { ...BUILD_RUNNING, status: 'QUEUED', startedAt: null, heartbeatAt: null };
    const view = mount({ projectId: 'proj-1', phase: 'BUILDING', isJobActive: false });
    await settle();
    const opening = view.reads;

    await vi.advanceTimersByTimeAsync(2_500);
    await settle();
    expect(view.reads).toBeGreaterThan(opening);
    expect(view.result.clientStop).toBeNull();
    view.unmount();
  });

  /**
   * The trade this fix must not make. Between a send and the server writing the job row, the
   * newest row the endpoint can answer with is the *previous* turn's, and it is settled. The
   * catch-up is what carries the workspace across that gap, so a stream in this tab has to
   * keep overriding a settled row for as long as that row is the one it started with.
   */
  it('keeps reading across the gap before the new job row exists', async () => {
    served = PLAN_DONE;
    const view = mount({ projectId: 'proj-1', phase: 'COMPLETE', isJobActive: false });
    await settle();
    const idle = view.reads;

    view.rerender({ isJobActive: true });
    await settle();
    await lookBackAtTheTab(2);
    expect(view.reads).toBeGreaterThan(idle);

    // And when the row does land, the workspace follows it.
    served = BUILD_RUNNING;
    await lookBackAtTheTab(1);
    expect(view.result.job?.id).toBe('job-build-1');
    expect(view.result.job?.status).toBe('RUNNING');
    view.unmount();
  });

  it('reads the row a project it just switched to has', async () => {
    served = PLAN_DONE;
    const view = mount({ projectId: 'proj-1', phase: 'COMPLETE', isJobActive: false });
    await settle();
    const first = view.reads;

    served = { ...BUILD_RUNNING, id: 'job-build-9' };
    view.rerender({ projectId: 'proj-2', phase: 'BUILDING' });
    await settle();
    expect(view.reads).toBeGreaterThan(first);
    expect(view.result.job?.id).toBe('job-build-9');
    view.unmount();
  });
});

/**
 * The predicate the three guards now take instead of the raw runtime flag. Stated directly so
 * the rule is readable without reconstructing it from the hook: the row this hook was already
 * holding when the stream began cannot be that stream's outcome, and every other settled row
 * is.
 */
describe('streamOutrunsHeldRow', () => {
  it('is false whenever no stream is running in this tab', () => {
    expect(streamOutrunsHeldRow({ isJobActive: false, jobId: 'j1', jobStatus: 'RUNNING' })).toBe(
      false,
    );
    expect(streamOutrunsHeldRow({ jobId: 'j1', jobStatus: 'QUEUED' })).toBe(false);
  });

  it('holds while the row is the one held before the stream began', () => {
    expect(
      streamOutrunsHeldRow({
        isJobActive: true,
        jobId: 'j1',
        jobStatus: 'SUCCEEDED',
        rowIdWhenStreamBegan: 'j1',
      }),
    ).toBe(true);
  });

  it('falls away for any other settled row, whatever the flag says', () => {
    for (const status of ['SUCCEEDED', 'FAILED', 'CANCELLED', 'ABANDONED']) {
      expect(
        streamOutrunsHeldRow({
          isJobActive: true,
          jobId: 'j2',
          jobStatus: status,
          rowIdWhenStreamBegan: 'j1',
        }),
      ).toBe(false);
      // Nothing was held when the stream began, so the row cannot predate it.
      expect(
        streamOutrunsHeldRow({
          isJobActive: true,
          jobId: 'j2',
          jobStatus: status,
          rowIdWhenStreamBegan: null,
        }),
      ).toBe(false);
    }
  });

  it('holds for a row still in flight, and for no row at all', () => {
    expect(
      streamOutrunsHeldRow({ isJobActive: true, jobId: 'j2', jobStatus: 'RUNNING' }),
    ).toBe(true);
    expect(streamOutrunsHeldRow({ isJobActive: true, jobId: 'j2', jobStatus: 'QUEUED' })).toBe(
      true,
    );
    expect(streamOutrunsHeldRow({ isJobActive: true, jobId: null, jobStatus: null })).toBe(true);
  });
});
