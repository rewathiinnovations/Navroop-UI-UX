import { useEffect, useState } from 'react';
import { createDebouncedEffectRunner } from './debounce-timer';

const DEFAULT_CONFIG = {
  timeout: 0,
  ignoreInitialCall: true,
};

/**
 * An effect that runs `timeout` ms after `deps` last changed.
 *
 * The dependency list used to be `[callback, ignoreInitialCall, timeout, ...deps]`,
 * which was wrong twice over (F-424):
 *
 * - `callback` was in it. Every caller passes an inline arrow, so a new identity
 *   arrived on every render and the effect re-ran, clearing and re-arming the timer
 *   each time — a component re-rendering faster than `timeout` never fired the
 *   debounced callback at all.
 * - `deps` was spread into it. React requires the list to keep a constant size
 *   between renders, and a spread is something eslint cannot check.
 *
 * Both live in `createDebouncedEffectRunner` now: one runner per mount, fed the
 * current render's inputs from an effect with no dependency list at all, and
 * disposed on unmount so nothing fires into a tree that has gone away.
 */
export function useDebouncedEffect(
  callback: () => void | (() => void),
  config: number | { timeout?: number; ignoreInitialCall?: boolean },
  deps: readonly unknown[] = [],
): void {
  const currentConfig =
    typeof config === 'object'
      ? { ...DEFAULT_CONFIG, ...config }
      : { ...DEFAULT_CONFIG, timeout: config };
  const { timeout, ignoreInitialCall } = currentConfig;

  // `useState`'s lazy initialiser, not a ref: one runner for the lifetime of the
  // component, and readable during render.
  const [runner] = useState(createDebouncedEffectRunner);

  // Deliberately no dependency array. `deps` is caller-supplied and may change
  // length, which a React dependency list may not; the comparison that decides
  // whether to re-arm happens inside `sync`. This body only forwards, so running
  // it after every render is the point rather than a cost.
  useEffect(() => {
    runner.sync(callback, deps, timeout, ignoreInitialCall);
  });

  useEffect(() => () => runner.dispose(), [runner]);
}

export default useDebouncedEffect;
