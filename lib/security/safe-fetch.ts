import { assertSafeUrl, UnsafeUrlError, type AssertSafeUrlOptions } from './url-guard.ts';
import { logRejectedUrl } from './reject-log.ts';

export const SAFE_FETCH_TIMEOUT_MS = 15_000;
export const SAFE_FETCH_MAX_BYTES = 10 * 1024 * 1024;
export const SAFE_FETCH_MAX_REDIRECTS = 3;
export const NAVROOP_USER_AGENT = 'Navroop/1.0 (URL-import; +https://navroop.app)';

const ACCEPTED_TYPES = new Set(['text/html', 'text/plain', 'text/css', 'application/json']);

export type SafeFetchOptions = AssertSafeUrlOptions & {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  headers?: HeadersInit;
  method?: string;
  body?: BodyInit | null;
};

function isAcceptedContentType(value: string | null) {
  if (!value) return true;
  const mime = value.split(';')[0]?.trim().toLowerCase();
  if (!mime) return true;
  if (mime.startsWith('image/')) return true;
  return ACCEPTED_TYPES.has(mime);
}

async function readLimitedBody(response: Response, maxBytes: number, userId?: string, raw?: string) {
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
  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let current = await assertSafeUrl(raw, opts);
    for (let hops = 0; hops <= maxRedirects; hops += 1) {
      const response = await fetchImpl(current.href, {
        method: opts.method ?? 'GET',
        body: hops === 0 ? opts.body : undefined,
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': NAVROOP_USER_AGENT,
          ...(opts.headers ?? {}),
        },
      });

      if (response.status >= 300 && response.status < 400) {
        if (hops >= maxRedirects) {
          const error = new UnsafeUrlError('redirect');
          await logRejectedUrl({ code: 'redirect', userId: opts.userId, raw: current.href });
          throw error;
        }
        const location = response.headers.get('location');
        if (!location) {
          const error = new UnsafeUrlError('redirect');
          await logRejectedUrl({ code: 'redirect', userId: opts.userId, raw: current.href });
          throw error;
        }
        current = await assertSafeUrl(new URL(location, current).href, opts);
        continue;
      }

      if (!isAcceptedContentType(response.headers.get('content-type'))) {
        const error = new UnsafeUrlError('content_type');
        await logRejectedUrl({ code: 'content_type', userId: opts.userId, raw: current.href });
        throw error;
      }

      const body = await readLimitedBody(response, maxBytes, opts.userId, current.href);
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
