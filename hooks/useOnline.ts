'use client';

import { useEffect, useRef, useSyncExternalStore } from 'react';
import {
  bindConnectionEvents,
  connectionState,
  subscribeToConnection,
  type ConnectionState,
} from '@/lib/net/connection';

/**
 * The one reader of connection state in React (F-446).
 *
 * `useSyncExternalStore` rather than `useState` + an effect, because the store is
 * shared: the banner, the dashboard poller and the projects poller must all see
 * the same transition in the same render, and a per-component listener would let
 * one of them keep polling for a tick after the banner had already appeared.
 *
 * The server snapshot is always `'online'`. Server-rendered HTML has no browser
 * to ask, and rendering "you are offline" into the document that just arrived
 * over the network would be false by construction.
 */
export function useOnline(): ConnectionState {
  return useSyncExternalStore(
    (onChange) => {
      bindConnectionEvents();
      return subscribeToConnection(onChange);
    },
    connectionState,
    () => 'online' as const,
  );
}

/**
 * One catch-up refetch when the connection comes back — never a burst.
 *
 * The pollers that call this stop ticking while offline, so the page they leave
 * on screen is stale by exactly the length of the outage. This is what closes
 * that gap; the interval resumes on its own from the next tick, so nothing here
 * needs to reschedule anything.
 *
 * Tracks the previous state rather than firing on `'online'`: the first render is
 * already online, and refetching there would double every page's initial load.
 */
export function useRefetchOnReconnect(refetch: () => void) {
  const connection = useOnline();
  const previous = useRef(connection);
  useEffect(() => {
    const cameBack = previous.current === 'offline' && connection === 'online';
    previous.current = connection;
    if (cameBack) refetch();
  }, [connection, refetch]);
}
