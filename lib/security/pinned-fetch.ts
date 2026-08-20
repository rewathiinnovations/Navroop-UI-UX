import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import type { LookupFunction } from 'node:net';
import type { ClientRequestArgs, IncomingMessage } from 'node:http';

/**
 * A fetch that connects to an address somebody else already approved.
 *
 * `assertSafeUrl` resolved the hostname and rejected private ranges, and then
 * `fetch` resolved it a *second* time and connected to whatever came back.
 * A hostname on a one-second TTL that answers with a public address for the
 * guard and `169.254.169.254` for the connection walked straight through the
 * SSRF check — reachable from any signed-in member via URL import (F-308).
 *
 * Node's `fetch` (undici) can only be pinned through a `dispatcher`, and
 * undici is not a dependency of this app, so the transport here is
 * `node:http` / `node:https`, which take a `lookup` directly. The hostname is
 * still what goes into the request line, the `Host` header and the TLS SNI —
 * only the address the socket dials is fixed — so certificate validation and
 * virtual hosting behave exactly as before.
 */

export type PinnedAddress = { address: string; family: number };

export type PinnedFetchInit = {
  method?: string;
  headers?: HeadersInit;
  body?: BodyInit | null;
  signal?: AbortSignal;
};

/** The transport seam `safeFetch` calls; also what a test substitutes. */
export type PinnedTransport = (
  url: URL,
  pinned: PinnedAddress[],
  init: PinnedFetchInit,
) => Promise<Response>;

export class NoPinnedAddressError extends Error {
  constructor() {
    super('No validated address to connect to');
    this.name = 'NoPinnedAddressError';
  }
}

/**
 * A `dns.lookup` replacement that ignores the hostname and answers with the
 * approved addresses. Exported so the pinning itself is testable without a
 * socket.
 */
export function createPinnedLookup(pinned: PinnedAddress[]): LookupFunction {
  return (_hostname, options, callback) => {
    const usable = options?.family
      ? pinned.filter((entry) => entry.family === options.family)
      : pinned;
    const chosen = usable.length > 0 ? usable : pinned;
    if (chosen.length === 0) {
      callback(new NoPinnedAddressError() as NodeJS.ErrnoException, '', 0);
      return;
    }
    if (options?.all) {
      callback(
        null,
        chosen.map((entry) => ({ address: entry.address, family: entry.family })),
      );
      return;
    }
    callback(null, chosen[0].address, chosen[0].family);
  };
}

function toHeaderRecord(headers: HeadersInit | undefined) {
  const record: Record<string, string> = {};
  if (!headers) return record;
  new Headers(headers).forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

function responseHeaders(message: IncomingMessage) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(message.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else if (typeof value === 'string') headers.append(name, value);
  }
  return headers;
}

export const pinnedFetch: PinnedTransport = async (url, pinned, init) => {
  if (pinned.length === 0) throw new NoPinnedAddressError();

  const secure = url.protocol === 'https:';
  // Read off the module object at call time rather than binding the named export
  // at import time: the test harness's network guard patches `http.request` /
  // `https.request`, and a snapshotted named import would slip straight past it.
  const send = secure ? https.request : http.request;
  // `new Response(body)` normalises every BodyInit shape for us; these requests
  // are small (an import POST at most), so buffering is not the streaming loss
  // it would be on the response side.
  const body = init.body == null ? null : Buffer.from(await new Response(init.body).arrayBuffer());

  const headers = toHeaderRecord(init.headers);
  // Node sends neither by default. `identity` is deliberate: without a decompressor
  // in this transport, an encoded body would reach the caller unreadable — and the
  // byte cap in `safeFetch` counts wire bytes either way.
  headers.accept ??= '*/*';
  headers['accept-encoding'] = 'identity';
  if (body) headers['content-length'] = String(body.byteLength);

  const options: ClientRequestArgs = {
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port || (secure ? 443 : 80),
    path: `${url.pathname}${url.search}`,
    method: init.method ?? 'GET',
    headers,
    lookup: createPinnedLookup(pinned),
    signal: init.signal,
  };

  return new Promise<Response>((resolve, reject) => {
    const request = send(options, (message) => {
      const status = message.statusCode ?? 502;
      // `Response` refuses a body for these, and the socket has to be drained
      // regardless or the connection is never released.
      const bodyless = status === 204 || status === 304 || (status >= 100 && status < 200);
      if (bodyless) message.resume();
      resolve(
        new Response(
          bodyless ? null : (Readable.toWeb(message) as unknown as ReadableStream<Uint8Array>),
          {
            status,
            statusText: message.statusMessage || '',
            headers: responseHeaders(message),
          },
        ),
      );
    });
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
};
