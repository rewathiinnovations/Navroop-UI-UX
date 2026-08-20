/**
 * F-446 — whether this browser can currently reach the server, in one place.
 *
 * TWO SIGNALS, BECAUSE EITHER ALONE LIES
 * `navigator.onLine` is false only when the operating system says the interface
 * is down. A captive portal, a dead resolver, a VPN that dropped or a laptop
 * that just woke all keep it true while every request fails. So a `fetch` that
 * *rejected* — no response at all, as opposed to a 4xx/5xx that arrived — is the
 * second signal. Either one makes the state `offline`; only the absence of both
 * makes it `online`.
 *
 * A 500 IS NOT OFFLINE
 * `isNetworkFailure` matches the transport-level shapes browsers throw and
 * nothing else. Calling a broken server "offline" sends the user to check their
 * wifi over a bug in the product, which is the same lie in the other direction.
 *
 * NO "RECONNECTING"
 * The state is `online | offline`, and the copy says what is true: requests are
 * not reaching the server and nothing is being saved. There is no timer, no
 * retry ladder and no reconnect promise, because there is nothing to promise —
 * the pollers resume on the browser's own `online` event.
 *
 * This module is imported by `'use client'` code, so it touches no Node builtin
 * and reads `navigator`/`window` only behind a guard: it is also loaded on the
 * server as part of `lib/notify.ts`'s graph.
 */

export type ConnectionState = 'online' | 'offline';

/** For a toast or an inline error, in place of "Failed to fetch". */
export const OFFLINE_MESSAGE =
  'You are offline, so that did not reach the server. Nothing was saved — try again once you have a connection.';

/** For the persistent banner. Present tense: it is true for as long as it shows. */
export const OFFLINE_BANNER_LINE =
  'You are offline. Nothing is being saved and this page has stopped updating.';

const NETWORK_FAILURE_TEXT =
  /failed to fetch|load failed|networkerror|network request failed|network error|err_internet_disconnected/i;

/**
 * Whether this is the browser saying the request never left, rather than the
 * server answering. `TypeError` is what `fetch` rejects with in every engine;
 * an `AbortError` is a `DOMException` and is a cancellation, not a failure.
 */
export function isNetworkFailure(error: unknown): boolean {
  return error instanceof TypeError && NETWORK_FAILURE_TEXT.test(error.message);
}

let browserOnline = true;
let lastRequestFailed = false;
let bound = false;
const listeners = new Set<() => void>();

export function connectionState(): ConnectionState {
  return browserOnline && !lastRequestFailed ? 'online' : 'offline';
}

function publish(previous: ConnectionState) {
  if (connectionState() === previous) return;
  for (const listener of listeners) listener();
}

/** The browser's own `online`/`offline` event, and the seam the tests drive. */
export function setBrowserOnline(next: boolean) {
  const previous = connectionState();
  browserOnline = next;
  // Coming back up clears the stale failure too, or one dropped request would
  // hold the banner open until the next successful call.
  if (next) lastRequestFailed = false;
  publish(previous);
}

/** A `fetch` that rejected: the request did not reach the server. */
export function reportNetworkFailure() {
  const previous = connectionState();
  lastRequestFailed = true;
  publish(previous);
}

/** A request that did reach the server, whatever it answered. */
export function reportNetworkSuccess() {
  const previous = connectionState();
  lastRequestFailed = false;
  publish(previous);
}

/**
 * Binds the browser events once per document. Called by the hook rather than at
 * module load: this module is in a server graph too, and a top-level
 * `addEventListener` there would be a crash on import.
 */
export function bindConnectionEvents() {
  if (bound || typeof window === 'undefined') return;
  bound = true;
  browserOnline = window.navigator.onLine;
  window.addEventListener('online', () => setBrowserOnline(true));
  window.addEventListener('offline', () => setBrowserOnline(false));
}

export function subscribeToConnection(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam. Never called by product code. */
export function resetConnectionState() {
  browserOnline = true;
  lastRequestFailed = false;
  listeners.clear();
}
