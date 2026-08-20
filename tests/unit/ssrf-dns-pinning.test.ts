import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SAFE_TRANSPORT,
  safeFetch,
  type SafeFetchOptions,
} from '@/lib/security/safe-fetch';
import { createPinnedLookup, pinnedFetch } from '@/lib/security/pinned-fetch';
import type { PinnedAddress } from '@/lib/security/pinned-fetch';
import { allowHost } from '../setup/network-guard';

/**
 * F-308: `assertSafeUrl` resolved the hostname, rejected private ranges and
 * handed back a URL — and then `fetch` resolved that hostname a *second* time
 * and connected to whatever the second answer said. A host on a one-second
 * TTL that replies with a public address for the guard and 169.254.169.254
 * for the connection walked through the SSRF check untouched, with the
 * metadata response handed back to the caller. Every redirect hop reopened
 * the same window.
 *
 * The fix is resolve-once-then-dial: the guard returns the addresses it
 * approved and the transport pins the socket to one of them, keeping the
 * hostname for the request line, `Host` and TLS SNI.
 */

const PUBLIC_ADDRESS = '93.184.216.34';
const METADATA_ADDRESS = '169.254.169.254';

/** A hostname that can never resolve (RFC 2606), so any success proves the pin. */
const UNRESOLVABLE_HOST = 'rebind-target.invalid';

describe('createPinnedLookup ignores DNS entirely', () => {
  const pinned: PinnedAddress[] = [{ address: PUBLIC_ADDRESS, family: 4 }];

  it('answers the single-address form with the pinned address', () => {
    const lookup = createPinnedLookup(pinned);
    const seen: unknown[] = [];
    lookup('anything.example', {}, (...args) => seen.push(args));
    expect(seen).toEqual([[null, PUBLIC_ADDRESS, 4]]);
  });

  it('answers the all:true form with the pinned list', () => {
    const lookup = createPinnedLookup(pinned);
    let result: unknown;
    lookup('anything.example', { all: true }, (_err, addresses) => {
      result = addresses;
    });
    expect(result).toEqual([{ address: PUBLIC_ADDRESS, family: 4 }]);
  });

  it('errors rather than falling back to a resolver when nothing was approved', () => {
    const lookup = createPinnedLookup([]);
    let error: unknown;
    lookup('anything.example', {}, (err) => {
      error = err;
    });
    expect(error).toBeInstanceOf(Error);
  });
});

describe('pinnedFetch dials the approved address, not the hostname', () => {
  let server: Server;
  let port = 0;
  const hostHeaders: (string | undefined)[] = [];

  // Per test, not per file: an `allowHost` grant is dropped after each test so it
  // cannot leak into a suite that never asked for it (F-618).
  beforeEach(() => {
    allowHost(UNRESOLVABLE_HOST, 'the pinned transport must reach the stub server');
  });

  beforeAll(async () => {
    // The harness blocks outbound http/https, including the pinned transport.
    // This name resolves nowhere; the socket only ever reaches the stub server
    // below, which is the entire point of the test.
    server = createServer((request, response) => {
      hostHeaders.push(request.headers.host);
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('served-from-the-pinned-address');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('reaches a server whose hostname does not resolve at all', async () => {
    const response = await pinnedFetch(
      new URL(`http://${UNRESOLVABLE_HOST}:${port}/page`),
      [{ address: '127.0.0.1', family: 4 }],
      {},
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('served-from-the-pinned-address');
    // The hostname survives where the server can see it: only the socket was pinned.
    expect(hostHeaders.at(-1)).toBe(`${UNRESOLVABLE_HOST}:${port}`);
  });

  it('fails when no address was approved instead of resolving the name', async () => {
    await expect(
      pinnedFetch(new URL(`http://${UNRESOLVABLE_HOST}:${port}/page`), [], {}),
    ).rejects.toThrow(/validated address/i);
  });
});

describe('safeFetch connects to what the guard validated (F-308)', () => {
  /**
   * The rebinding answer: the first lookup — the guard's — is public, and every
   * later one is the cloud metadata address. Under the old code the connection
   * took the second answer.
   */
  function rebindingLookup() {
    let calls = 0;
    const lookup = async () => {
      calls += 1;
      return calls === 1
        ? [{ address: PUBLIC_ADDRESS, family: 4 }]
        : [{ address: METADATA_ADDRESS, family: 4 }];
    };
    return { lookup, callCount: () => calls };
  }

  it('hands the transport the guard-approved address and resolves only once', async () => {
    const { lookup, callCount } = rebindingLookup();
    const dialled: PinnedAddress[][] = [];
    const transport = vi.fn(async (_url: URL, pinned: PinnedAddress[]) => {
      dialled.push(pinned);
      return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
    });

    const response = await safeFetch('https://rebind.example/page', {
      lookup,
      transport,
    } satisfies SafeFetchOptions);

    expect(response.status).toBe(200);
    expect(callCount()).toBe(1);
    expect(dialled).toEqual([[{ address: PUBLIC_ADDRESS, family: 4 }]]);
    expect(dialled.flat().map((entry) => entry.address)).not.toContain(METADATA_ADDRESS);
  });

  it('re-pins on a redirect instead of reopening the window', async () => {
    const hostsResolved: string[] = [];
    const lookup = async (hostname: string) => {
      hostsResolved.push(hostname);
      return hostname === 'first.example'
        ? [{ address: PUBLIC_ADDRESS, family: 4 }]
        : [{ address: '198.51.100.7', family: 4 }];
    };
    const dialled: Array<{ host: string; address: string }> = [];
    const transport = async (url: URL, pinned: PinnedAddress[]) => {
      dialled.push({ host: url.hostname, address: pinned[0].address });
      return dialled.length === 1
        ? new Response(null, { status: 302, headers: { location: 'https://second.example/next' } })
        : new Response('done', { status: 200, headers: { 'content-type': 'text/plain' } });
    };

    const response = await safeFetch('https://first.example/page', { lookup, transport });

    expect(await response.text()).toBe('done');
    // One resolution per hop, and each hop dialled the address that hop validated.
    expect(hostsResolved).toEqual(['first.example', 'second.example']);
    expect(dialled).toEqual([
      { host: 'first.example', address: PUBLIC_ADDRESS },
      { host: 'second.example', address: '198.51.100.7' },
    ]);
  });

  it('uses the pinned transport by default, so product callers are pinned', () => {
    expect(DEFAULT_SAFE_TRANSPORT).toBe(pinnedFetch);
  });
});
