import { useCallback, useEffect, useRef, useState } from 'react';
import { createDebounceTimer } from './debounce-timer';

const DEFAULT_TIMEOUT = 0;

/**
 * A callback that runs `timeout` ms after the last call, and never after unmount.
 */
export function useDebouncedCallback<A extends unknown[]>(
  callback: (...args: A) => unknown,
  config: number | { timeout?: number },
): (...args: A) => void {
  // `useState`'s lazy initialiser, not a ref: one timer for the lifetime of the
  // component, and readable during render.
  const [timer] = useState(createDebounceTimer);
  const callbackRef = useRef(callback);
  useEffect(() => {
    callbackRef.current = callback;
  });

  // Without this, a call armed just before the component went away still fired,
  // invoking `callbackRef.current` — in practice a `setState` on an unmounted tree
  // — and held the closure over that tree alive until it did.
  useEffect(() => () => timer.cancel(), [timer]);

  const timeout = typeof config === 'object' ? (config.timeout ?? DEFAULT_TIMEOUT) : config;

  return useCallback(
    (...args: A) => {
      timer.schedule(() => callbackRef.current(...args), timeout);
    },
    [timer, timeout],
  );
}

export default useDebouncedCallback;
