import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDebounceTimer, depsChanged } from '@/hooks/debounce-timer';

/**
 * F-437 and F-424. Both hooks' defects live in state that outlives a single
 * render, which is why they were invisible: `useDebouncedCallback` cleared its
 * timeout id only on the *next* invocation, so a pending call survived unmount and
 * fired a `setState` into a tree that no longer existed; `useDebouncedEffect`
 * spread a caller-supplied array into its own dependency list, which React
 * requires to keep a constant size, and put the inline `callback` in there too so
 * the timer was re-armed on every render and never fired under render pressure.
 *
 * The two pieces the hooks now delegate to are plain functions, so the timer is
 * testable with fake timers and the dependency comparison is testable directly.
 */
describe('createDebounceTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs once, after the timeout', () => {
    const run = vi.fn();
    const timer = createDebounceTimer();
    timer.schedule(run, 500);
    vi.advanceTimersByTime(499);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('keeps only the last scheduled run', () => {
    const first = vi.fn();
    const second = vi.fn();
    const timer = createDebounceTimer();
    timer.schedule(first, 500);
    vi.advanceTimersByTime(400);
    timer.schedule(second, 500);
    vi.advanceTimersByTime(500);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  /** The unmount path: this is what the hook's cleanup effect now calls. */
  it('never runs a cancelled call, however long the clock advances', () => {
    const run = vi.fn();
    const timer = createDebounceTimer();
    timer.schedule(run, 500);
    expect(timer.pending()).toBe(true);
    timer.cancel();
    expect(timer.pending()).toBe(false);
    vi.advanceTimersByTime(100_000);
    expect(run).not.toHaveBeenCalled();
  });

  it('reports nothing pending once the run has happened', () => {
    const timer = createDebounceTimer();
    timer.schedule(() => undefined, 10);
    vi.advanceTimersByTime(10);
    expect(timer.pending()).toBe(false);
  });

  it('is safe to cancel when nothing is armed', () => {
    const timer = createDebounceTimer();
    expect(() => {
      timer.cancel();
      timer.cancel();
    }).not.toThrow();
    expect(timer.pending()).toBe(false);
  });

  it('can be re-armed after a cancel', () => {
    const run = vi.fn();
    const timer = createDebounceTimer();
    timer.schedule(run, 500);
    timer.cancel();
    timer.schedule(run, 500);
    vi.advanceTimersByTime(500);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('depsChanged', () => {
  it('treats the first render as a change', () => {
    expect(depsChanged(null, [])).toBe(true);
    expect(depsChanged(null, [1])).toBe(true);
  });

  it('sees no change when every entry keeps its identity', () => {
    const object = { a: 1 };
    expect(depsChanged([1, 'two', object], [1, 'two', object])).toBe(false);
    expect(depsChanged([], [])).toBe(false);
  });

  it('compares by identity, not by shape', () => {
    expect(depsChanged([{ a: 1 }], [{ a: 1 }])).toBe(true);
  });

  /**
   * The case the old spread turned into React's "size of dependency list changed"
   * warning and undefined behaviour. Here it is simply a change.
   */
  it('treats a deps array that grew or shrank as a change', () => {
    expect(depsChanged([1], [1, 2])).toBe(true);
    expect(depsChanged([1, 2], [1])).toBe(true);
  });

  it('notices a single replaced entry', () => {
    expect(depsChanged([1, 2, 3], [1, 9, 3])).toBe(true);
  });

  it('treats NaN as unchanged and +0/-0 as changed, like React does', () => {
    // React compares dependencies with Object.is, so this must too — otherwise a
    // NaN dependency would re-run the effect on every single render.
    expect(depsChanged([Number.NaN], [Number.NaN])).toBe(false);
    expect(depsChanged([0], [-0])).toBe(true);
  });
});
