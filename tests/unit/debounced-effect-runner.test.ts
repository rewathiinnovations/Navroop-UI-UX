import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDebouncedEffectRunner } from '@/hooks/debounce-timer';

/**
 * F-424 and F-437, at the level the bugs actually live.
 *
 * `tests/unit/debounce-timer.test.ts` covers the timer and the dependency
 * comparison in isolation. What neither of them can see is the *sequence* — the
 * thing React drives — and both defects were sequence defects:
 *
 * - F-424: `useDebouncedEffect` put the caller's inline `callback` in its own
 *   dependency list and spread `deps` into it. A new arrow identity arrived every
 *   render, so the effect re-ran and the timer was cleared and re-armed each time.
 *   A component re-rendering faster than `timeout` therefore never fired the
 *   debounced callback at all, and a `deps` array that grew or shrank changed the
 *   size of a React dependency list, which React does not allow.
 * - F-437: a pending run survived unmount and invoked the stored callback — in
 *   practice a `setState` into a tree that no longer existed.
 *
 * The runner is the hook's whole state machine with the React plumbing removed:
 * `sync` is what the every-render effect calls, `dispose` is what the unmount
 * cleanup calls. Driving it by hand is driving the hook. There is no DOM
 * environment in this suite (`environment: 'node'`, no jsdom), so this is also the
 * only way to exercise the sequence at all.
 */
describe('createDebouncedEffectRunner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** F-437: the unmount path. */
  it('never runs a callback armed before unmount', () => {
    const runner = createDebouncedEffectRunner();
    let ran = 0;

    runner.sync(() => void (ran += 1), [1], 100, false);
    vi.advanceTimersByTime(50);
    expect(runner.pending()).toBe(true);

    runner.dispose();

    vi.advanceTimersByTime(10_000);
    expect(ran).toBe(0);
    expect(runner.pending()).toBe(false);
  });

  /**
   * F-424, the observable symptom: with a new inline callback on every render and
   * `deps` unchanged, the run must still happen at the deadline set when `deps`
   * last changed. The old dependency list re-armed the timer on every render, so
   * this callback never ran.
   */
  it('fires at the original deadline however many times the component re-renders', () => {
    const runner = createDebouncedEffectRunner();
    let ran = 0;
    const render = () => runner.sync(() => void (ran += 1), ['stable'], 100, false);

    render();
    // Nine re-renders inside the debounce window, each with a fresh arrow and a
    // fresh (equal, not identical) deps array — exactly what a caller like
    // `Pixi.tsx` produces under parent re-render pressure.
    for (let i = 0; i < 9; i += 1) {
      vi.advanceTimersByTime(10);
      render();
    }
    expect(ran).toBe(0);

    vi.advanceTimersByTime(10);
    expect(ran).toBe(1);

    // And not again: the deadline is consumed, not rolling.
    vi.advanceTimersByTime(10_000);
    expect(ran).toBe(1);
  });

  /** The other half of holding `callback` out of the dependency list. */
  it('runs the latest render’s callback, not the one that armed the timer', () => {
    const runner = createDebouncedEffectRunner();
    const ran: string[] = [];

    runner.sync(() => void ran.push('first'), ['stable'], 100, false);
    runner.sync(() => void ran.push('second'), ['stable'], 100, false);
    vi.advanceTimersByTime(100);

    expect(ran).toEqual(['second']);
  });

  it('re-arms when a dep identity changes, dropping the pending run', () => {
    const runner = createDebouncedEffectRunner();
    const ran: string[] = [];

    runner.sync(() => void ran.push('a'), ['a'], 100, false);
    vi.advanceTimersByTime(90);
    runner.sync(() => void ran.push('b'), ['b'], 100, false);

    vi.advanceTimersByTime(10);
    expect(ran).toEqual([]);

    vi.advanceTimersByTime(90);
    expect(ran).toEqual(['b']);
  });

  /**
   * The case that used to be React's "size of dependency list changed" warning
   * and undefined behaviour. Here it is an ordinary change.
   */
  it('treats a deps array that grew or shrank as a change', () => {
    const runner = createDebouncedEffectRunner();
    let ran = 0;

    runner.sync(() => void (ran += 1), ['a'], 10, false);
    vi.advanceTimersByTime(10);
    expect(ran).toBe(1);

    runner.sync(() => void (ran += 1), ['a', 'b'], 10, false);
    vi.advanceTimersByTime(10);
    expect(ran).toBe(2);

    runner.sync(() => void (ran += 1), [], 10, false);
    vi.advanceTimersByTime(10);
    expect(ran).toBe(3);
  });

  it('skips only the mount when ignoreInitialCall is set', () => {
    const runner = createDebouncedEffectRunner();
    let ran = 0;

    runner.sync(() => void (ran += 1), ['a'], 10, true);
    vi.advanceTimersByTime(1_000);
    expect(ran).toBe(0);

    runner.sync(() => void (ran += 1), ['b'], 10, true);
    vi.advanceTimersByTime(10);
    expect(ran).toBe(1);
  });

  /**
   * StrictMode runs a mount effect, tears it down, and runs it again — inside a
   * single render, so `deps` is the very same array instance both times. React
   * also re-runs an effect on remount whatever its dependency list says. A runner
   * that remembered the inputs across `dispose` would see no change on the second
   * pass and the effect would never run in development.
   */
  it('arms again after the teardown-and-rerun StrictMode performs on mount', () => {
    const runner = createDebouncedEffectRunner();
    let ran = 0;
    const deps = ['stable'];

    runner.sync(() => void (ran += 1), deps, 10, false);
    runner.dispose();
    runner.sync(() => void (ran += 1), deps, 10, false);

    vi.advanceTimersByTime(10);
    expect(ran).toBe(1);
  });

  it('re-arms when the timeout changes even though deps did not', () => {
    const runner = createDebouncedEffectRunner();
    let ran = 0;

    runner.sync(() => void (ran += 1), ['a'], 1_000, false);
    vi.advanceTimersByTime(500);
    runner.sync(() => void (ran += 1), ['a'], 10, false);

    vi.advanceTimersByTime(10);
    expect(ran).toBe(1);
  });

  it('runs the callback’s cleanup before the next run and again on dispose', () => {
    const runner = createDebouncedEffectRunner();
    const events: string[] = [];

    const render = (tag: string, deps: readonly unknown[]) =>
      runner.sync(
        () => {
          events.push(`run:${tag}`);
          return () => events.push(`cleanup:${tag}`);
        },
        deps,
        10,
        false,
      );

    render('a', ['a']);
    vi.advanceTimersByTime(10);
    expect(events).toEqual(['run:a']);

    render('b', ['b']);
    expect(events).toEqual(['run:a', 'cleanup:a']);
    vi.advanceTimersByTime(10);
    expect(events).toEqual(['run:a', 'cleanup:a', 'run:b']);

    runner.dispose();
    expect(events).toEqual(['run:a', 'cleanup:a', 'run:b', 'cleanup:b']);

    // Idempotent: a second dispose must not run the cleanup twice.
    runner.dispose();
    expect(events).toEqual(['run:a', 'cleanup:a', 'run:b', 'cleanup:b']);
  });
});

/**
 * The runner and the timer are only correct if the hooks still call `dispose` /
 * `cancel` from an unmount cleanup. That wiring is one line each and is precisely
 * what was missing (F-437), and there is no renderer in this suite to observe it,
 * so assert it on the source.
 */
describe('the debounced hooks keep their unmount cleanup', () => {
  it('useDebouncedCallback cancels its timer when the component goes away', () => {
    const source = readFileSync('hooks/useDebouncedCallback.ts', 'utf8');
    expect(source).toMatch(/useEffect\(\s*\(\)\s*=>\s*\(\)\s*=>\s*timer\.cancel\(\)/);
  });

  it('useDebouncedEffect disposes its runner when the component goes away', () => {
    const source = readFileSync('hooks/useDebouncedEffect.ts', 'utf8');
    expect(source).toMatch(/useEffect\(\s*\(\)\s*=>\s*\(\)\s*=>\s*runner\.dispose\(\)/);
  });
});
