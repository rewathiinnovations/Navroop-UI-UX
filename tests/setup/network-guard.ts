const ALLOWED_HOSTS = new Set(['example.com', 'www.example.com']);

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
  if (ALLOWED_HOSTS.has(normalizeHost(host))) return true;
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

export function allowHost(host: string) {
  if (isLoopbackHost(host)) {
    throw new Error(
      `Use allowLocalhost('reason') to opt in to localhost; allowHost(${host}) is not enough.`,
    );
  }
  ALLOWED_HOSTS.add(normalizeHost(host));
}

export { originalFetch };
