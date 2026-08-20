import { EventEmitter } from 'node:events';
import http from 'node:http';
import https from 'node:https';

/** Permanently allowed: the RFC 2606 example hosts the suites use as stand-ins. */
const ALLOWED_HOSTS = new Set(['example.com', 'www.example.com']);

/**
 * Granted by `allowHost` and cleared after every test by `vitest.setup.ts`. These
 * used to be added straight into `ALLOWED_HOSTS`, which nothing ever cleared, so one
 * test's allowance silently applied to every later test in the same worker (F-618).
 */
const TEMPORARY_HOSTS = new Set<string>();

let localhostAllowed = false;

function hostOf(input: unknown): string | null {
  try {
    if (typeof input === 'string') return new URL(input).hostname;
    if (input instanceof URL) return input.hostname;
    if (input && typeof input === 'object' && 'url' in input) {
      return new URL(String((input as { url: string }).url)).hostname;
    }
  } catch {
    return null;
  }
  return null;
}

function normalizeHost(host: string) {
  return host.toLowerCase().replace(/^\[|\]$/g, '');
}

function isLoopbackIPv4(host: string) {
  const parts = host.split('.');
  if (parts.length !== 4 || parts[0] !== '127') return false;
  return parts.every((part) => /^\d+$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}

export function isLoopbackHost(host: string) {
  const normalized = normalizeHost(host);
  if (normalized === 'localhost' || normalized === '::1') return true;
  if (normalized.endsWith('.localhost')) return true;
  if (normalized.startsWith('::ffff:') && isLoopbackIPv4(normalized.slice('::ffff:'.length))) {
    return true;
  }
  return isLoopbackIPv4(normalized);
}

function isAllowed(host: string | null) {
  if (!host) return false;
  if (isLoopbackHost(host)) return localhostAllowed;
  const normalized = normalizeHost(host);
  if (ALLOWED_HOSTS.has(normalized) || TEMPORARY_HOSTS.has(normalized)) return true;
  return false;
}

function localhostBlockedMessage(host: string | null, input: unknown) {
  return (
    `Network guard blocked a localhost request to ${host || String(input)}. ` +
    `Unit tests must not reach the live app. ` +
    `If this test genuinely needs the running server, call ` +
    `allowLocalhost('why this test needs the live app') from tests/setup/network-guard.`
  );
}

const originalFetch = globalThis.fetch;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const host = hostOf(input);
  if (host && isLoopbackHost(host) && !localhostAllowed) {
    throw new Error(localhostBlockedMessage(host, input));
  }
  if (!isAllowed(host)) {
    throw new Error(`Network guard blocked outbound request to ${host || String(input)}`);
  }
  return originalFetch(input as RequestInfo, init);
}) as typeof fetch;

/**
 * `safeFetch` no longer goes through global `fetch`: it pins the socket to the
 * address the SSRF guard approved and drives `node:http` / `node:https`
 * directly (F-308). Guarding only `fetch` would therefore have left a hole
 * wide enough for a unit test to reach the live internet — which is exactly
 * what it did, as a 15-second hang rather than a refusal.
 *
 * A blocked call fails the way an unreachable host fails — an asynchronous
 * `error` event on the returned request — rather than throwing out of
 * `http.request`. Callers deep in a library (a tracker flushing an event, say)
 * already handle a connection error; none of them expect the constructor to
 * throw.
 */
function hostOfRequestArgs(args: unknown[]) {
  for (const arg of args) {
    if (typeof arg === 'string' || arg instanceof URL) {
      const host = hostOf(arg);
      if (host) return host;
    } else if (arg && typeof arg === 'object') {
      const options = arg as { hostname?: unknown; host?: unknown };
      const raw = options.hostname ?? options.host;
      if (typeof raw === 'string' && raw) return normalizeHost(raw.replace(/:\d+$/, ''));
    }
  }
  return null;
}

function blockedRequest(message: string) {
  const request = new EventEmitter() as EventEmitter & Record<string, unknown>;
  request.write = () => true;
  request.end = () => request;
  request.destroy = () => request;
  request.setTimeout = () => request;
  request.setHeader = () => request;
  request.abort = () => undefined;
  setImmediate(() => request.emit('error', new Error(message)));
  return request;
}

function guardRequestFn<T extends (...args: never[]) => unknown>(label: string, original: T): T {
  return function guarded(this: unknown, ...args: unknown[]) {
    const host = hostOfRequestArgs(args);
    if (host && isLoopbackHost(host) && !localhostAllowed) {
      return blockedRequest(localhostBlockedMessage(host, host));
    }
    if (!isAllowed(host)) {
      return blockedRequest(
        `Network guard blocked outbound ${label} request to ${host ?? args[0]}`,
      );
    }
    return (original as (...inner: unknown[]) => unknown).apply(this, args);
  } as unknown as T;
}

http.request = guardRequestFn('http', http.request);
http.get = guardRequestFn('http', http.get);
https.request = guardRequestFn('https', https.request);
https.get = guardRequestFn('https', https.get);

/**
 * Opt in to loopback (`localhost`, `127.0.0.0/8`, `::1`, `*.localhost`) for one test.
 * Reset automatically after each test via `vitest.setup.ts`. A missing reason is
 * rejected so the call cannot hide in a bare `allowLocalhost()`.
 */
export function allowLocalhost(reason: string) {
  if (typeof reason !== 'string' || !reason.trim()) {
    throw new Error(
      'allowLocalhost requires a non-empty reason so the opt-in is visible in the test file',
    );
  }
  localhostAllowed = true;
}

export function revokeLocalhost() {
  localhostAllowed = false;
}

/**
 * Opt in to one non-loopback host for one test. Reset automatically after each test
 * via `vitest.setup.ts`. A missing reason is rejected, so the opt-in cannot hide.
 */
export function allowHost(host: string, reason: string) {
  if (typeof reason !== 'string' || !reason.trim()) {
    throw new Error(
      'allowHost requires a non-empty reason so the opt-in is visible in the test file',
    );
  }
  if (isLoopbackHost(host)) {
    throw new Error(
      `Use allowLocalhost('reason') to opt in to localhost; allowHost(${host}) is not enough.`,
    );
  }
  TEMPORARY_HOSTS.add(normalizeHost(host));
}

/** Drops every `allowHost` grant. Called from the same `afterEach` as `revokeLocalhost`. */
export function resetAllowedHosts() {
  TEMPORARY_HOSTS.clear();
}

export { originalFetch };
