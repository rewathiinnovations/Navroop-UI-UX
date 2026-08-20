/**
 * The non-React halves of `useDebouncedCallback` and `useDebouncedEffect`.
 *
 * Both hooks had a defect that only shows up over time — a timer surviving
 * unmount, and a dependency array whose size React is not allowed to see change —
 * and neither is reachable from a test while it is tangled up in a hook. They
 * live here so they are.
 */

/** The platform timer handle: a number in the browser, a `Timeout` under Node. */
type TimerHandle = ReturnType<typeof setTimeout>;

export type DebounceTimer = {
  /** Arms the timer, replacing any pending run. */
  schedule: (run: () => void, timeout: number) => void;
  /** Drops a pending run. Safe to call when nothing is pending. */
  cancel: () => void;
  /** Whether a run is currently armed. */
  pending: () => boolean;
};

/**
 * One at-most-pending timer.
 *
 * `useDebouncedCallback` used to hold a bare timeout id in a ref and clear it only
 * on the *next* invocation, so a pending call outlived the component and fired
 * `callbackRef.current` — in practice a `setState` on a tree that no longer
 * exists. An unmount effect calling `cancel` is what closes that; the state lives
 * here so the hook has one thing to clean up rather than an id it must remember to
 * clear from two places.
 */
export function createDebounceTimer(): DebounceTimer {
  let handle: TimerHandle | undefined;
  return {
    schedule(run, timeout) {
      clearTimeout(handle);
      handle = setTimeout(() => {
        handle = undefined;
        run();
      }, timeout);
    },
    cancel() {
      clearTimeout(handle);
      handle = undefined;
    },
    pending() {
      return handle !== undefined;
    },
  };
}

/**
 * Whether a caller-supplied dependency array differs from the last one seen.
 *
 * `useDebouncedEffect` spread `deps` into its own dependency list
 * (`[callback, ignoreInitialCall, timeout, ...deps]`). React requires that list to
 * be a constant size between renders, nothing enforced it, and eslint cannot check
 * a spread — a `deps` array that grows or shrinks produces React's "size of
 * dependency list changed" warning and undefined behaviour. The comparison lives
 * here instead, driven from `createDebouncedEffectRunner` below, so the hook never
 * needs a variable-length React dependency list — while preserving exactly the
 * semantics a dependency array has: re-run when any entry's identity changes.
 */
export function depsChanged(previous: readonly unknown[] | null, next: readonly unknown[]) {
  if (previous === null) return true;
  if (previous.length !== next.length) return true;
  return next.some((dep, index) => !Object.is(dep, previous[index]));
}

export type DebouncedEffectRunner = {
  /**
   * The caller's current inputs. Called from an effect on every render: `deps` may
   * legally change length here, because this is an ordinary array comparison and
   * not a React dependency list. Re-arms the timer only when a dep identity or the
   * timeout changed; otherwise it just adopts the new `callback`.
   */
  sync: (
    callback: () => void | (() => void),
    deps: readonly unknown[],
    timeout: number,
    ignoreInitialCall: boolean,
  ) => void;
  /** Unmount: drops any pending run and runs the last callback's cleanup. */
  dispose: () => void;
  /** Whether a run is currently armed. */
  pending: () => boolean;
};

/**
 * The whole state machine behind `useDebouncedEffect`, with the React plumbing
 * removed so the sequence is testable.
 *
 * The hook used to pass `[callback, ignoreInitialCall, timeout, ...deps]` to
 * `useEffect`. Two defects came out of that (F-424). Callers pass an inline arrow,
 * so `callback` brought a new identity every render and the effect re-ran,
 * clearing and re-arming the timer each time — a component re-rendering faster
 * than `timeout` never fired the debounced callback at all. And spreading `deps`
 * made the list a size React is not allowed to see change. Holding the callback
 * outside the change signal fixes the first; comparing `deps` here fixes the
 * second.
 */
export function createDebouncedEffectRunner(): DebouncedEffectRunner {
  const timer = createDebounceTimer();
  let callback: () => void | (() => void) = () => undefined;
  let seenDeps: readonly unknown[] | null = null;
  let seenTimeout: number | null = null;
  let synced = false;
  let cleanup: (() => void) | undefined;

  const runCleanup = () => {
    const previous = cleanup;
    cleanup = undefined;
    previous?.();
  };

  return {
    sync(next, deps, timeout, ignoreInitialCall) {
      // Always the latest render's callback, never a reason to re-arm.
      callback = next;
      if (!depsChanged(seenDeps, deps) && seenTimeout === timeout) return;
      seenDeps = deps;
      seenTimeout = timeout;

      timer.cancel();
      runCleanup();

      const isMount = !synced;
      synced = true;
      if (isMount && ignoreInitialCall) return;

      timer.schedule(() => {
        cleanup = callback() ?? undefined;
      }, timeout);
    },
    dispose() {
      timer.cancel();
      runCleanup();
      // Forget the inputs, so a `sync` after this arms again even with the very
      // same `deps`. StrictMode tears an effect down and runs it again inside one
      // render, and React re-runs an effect on remount regardless of its
      // dependency list; without this, the second pass would see no change and
      // the effect would never run. `synced` is deliberately not reset —
      // `ignoreInitialCall` is spent on the real mount, exactly as the old
      // `firstTimeRef` spent it.
      seenDeps = null;
      seenTimeout = null;
    },
    pending: timer.pending,
  };
}
