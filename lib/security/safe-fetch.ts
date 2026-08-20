import { resolveSafeUrl, UnsafeUrlError, type AssertSafeUrlOptions } from './url-guard.ts';
import { pinnedFetch, type PinnedTransport } from './pinned-fetch.ts';
import { logRejectedUrl } from './reject-log.ts';

export const SAFE_FETCH_TIMEOUT_MS = 15_000;
export const SAFE_FETCH_MAX_BYTES = 10 * 1024 * 1024;
export const SAFE_FETCH_MAX_REDIRECTS = 3;
export const NAVROOP_USER_AGENT = 'Navroop/1.0 (URL-import; +https://navroop.app)';

const ACCEPTED_TYPES = new Set(['text/html', 'text/plain', 'text/css', 'application/json']);

/**
 * The connection the guard approved. Every hop resolves once and dials that
 * address; nothing here ever hands a hostname to a second resolver (F-308).
 */
export const DEFAULT_SAFE_TRANSPORT: PinnedTransport = pinnedFetch;

export type SafeFetchOptions = AssertSafeUrlOptions & {
  /**
   * Test seam that replaces the whole transport, pinning included. Callers in
   * the product leave it unset; anything passed here is responsible for its own
   * address discipline, which is why the pinned addresses are handed to it.
   */
  transport?: PinnedTransport;
  /**
   * Older, coarser seam: a plain `fetch` stand-in that never sees the pinned
   * addresses. Kept for the existing suites; it bypasses pinning, so it must not
   * be used from product code.
   */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  headers?: HeadersInit;
  method?: string;
  body?: BodyInit | null;
};

/**
 * Allowlist, so silence is a rejection (F-317). The header used to be treated as
 * a pass when it was absent and again when the mime parsed to an empty string,
 * which meant an origin could ship 10 MB of arbitrary bytes into the import
 * pipeline simply by omitting `Content-Type`. Only a declared, recognised type
 * gets through.
 */
function isAcceptedContentType(value: string | null) {
  if (!value) return false;
  const mime = value.split(';')[0]?.trim().toLowerCase();
  if (!mime) return false;
  if (mime.startsWith('image/')) return true;
  return ACCEPTED_TYPES.has(mime);
}

async function readLimitedBody(
  response: Response,
  maxBytes: number,
  userId?: string,
  raw?: string,
) {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        const error = new UnsafeUrlError('too_large');
        await logRejectedUrl({ code: 'too_large', userId, raw });
        throw error;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function safeFetch(raw: string, opts: SafeFetchOptions = {}): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? SAFE_FETCH_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? SAFE_FETCH_MAX_BYTES;
  const maxRedirects = opts.maxRedirects ?? SAFE_FETCH_MAX_REDIRECTS;
  // `fetchImpl` never learns the pinned addresses, so it is only ever a test
  // stand-in; product callers get the pinned transport.
  const transport: PinnedTransport =
    opts.transport ??
    (opts.fetchImpl
      ? (url, _pinned, init) => (opts.fetchImpl as typeof fetch)(url.href, init as RequestInit)
      : DEFAULT_SAFE_TRANSPORT);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let current = await resolveSafeUrl(raw, opts);
    for (let hops = 0; hops <= maxRedirects; hops += 1) {
      const response = await transport(current.url, current.addresses, {
        method: opts.method ?? 'GET',
        body: hops === 0 ? opts.body : undefined,
        signal: controller.signal,
        headers: {
          'User-Agent': NAVROOP_USER_AGENT,
          ...(opts.headers ?? {}),
        },
      });

      if (response.status >= 300 && response.status < 400) {
        if (hops >= maxRedirects) {
          const error = new UnsafeUrlError('redirect');
          await logRejectedUrl({ code: 'redirect', userId: opts.userId, raw: current.url.href });
          throw error;
        }
        const location = response.headers.get('location');
        if (!location) {
          const error = new UnsafeUrlError('redirect');
          await logRejectedUrl({ code: 'redirect', userId: opts.userId, raw: current.url.href });
          throw error;
        }
        // A fresh resolution *and* a fresh pin: the next hop's host gets the same
        // resolve-once-then-dial treatment rather than being handed to a resolver
        // twice (F-308).
        current = await resolveSafeUrl(new URL(location, current.url).href, opts);
        continue;
      }

      if (!isAcceptedContentType(response.headers.get('content-type'))) {
        const error = new UnsafeUrlError('content_type');
        await logRejectedUrl({ code: 'content_type', userId: opts.userId, raw: current.url.href });
        throw error;
      }

      const body = await readLimitedBody(response, maxBytes, opts.userId, current.url.href);
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }

    const error = new UnsafeUrlError('redirect');
    await logRejectedUrl({ code: 'redirect', userId: opts.userId, raw });
    throw error;
  } catch (error) {
    if (error instanceof UnsafeUrlError) throw error;
    if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
      const timeout = new UnsafeUrlError('timeout');
      await logRejectedUrl({ code: 'timeout', userId: opts.userId, raw });
      throw timeout;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
