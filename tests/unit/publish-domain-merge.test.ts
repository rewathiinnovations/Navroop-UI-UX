import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addApplicationDomain, listApplicationHosts } from '@/lib/coolify/client';

/**
 * Re-publishing must not unroute a verified custom domain.
 *
 * The publish loop used to PATCH the Coolify application with `setDomain`, which wrote the
 * whole hostname list down to the single publish host. A site live on `shop.client.test`
 * therefore lost its Traefik route on the next Publish — 404/502 on the custom domain while
 * the Domains tab still showed it ACTIVE and primary — and any primary 301 went with it.
 * Every re-publish hit this: `step()` only skips steps that already succeeded *within the
 * same job*, and each publish creates a fresh job whose steps all start `pending`.
 *
 * These cases pin the read-modify-write contract at the wire: whatever the application
 * already answers with has to survive the PATCH. Goes red if the merge is replaced by an
 * overwrite again, or if an alias's `:redirect` suffix stops being recognised as the same
 * host and gets duplicated.
 */

const SERVER = {
  apiUrl: 'https://coolify.example.com',
  // Short and unpadded, so `tokenForServer` passes it through instead of calling decrypt.
  apiToken: 'plain-token',
};
const APP = 'coolify-app-1';
const PUBLISH_HOST = 'live-shop.navroop.example.com';

type Call = { url: string; method: string; body: Record<string, unknown> | null };

const calls: Call[] = [];
let fqdn = '';

function jsonResponse(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body =
        typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
      calls.push({ url: String(input), method, body });
      if (method === 'PATCH') {
        fqdn = String(body?.fqdn ?? '');
        return jsonResponse({ uuid: APP });
      }
      return jsonResponse({ uuid: APP, fqdn });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('addApplicationDomain', () => {
  it('keeps an existing custom domain when the publish host is (re-)attached', async () => {
    fqdn = 'https://shop.client.test,https://www.shop.client.test:redirect';

    await addApplicationDomain(SERVER, APP, PUBLISH_HOST);

    const patch = calls.find((call) => call.method === 'PATCH');
    expect(patch?.body?.fqdn).toBe(
      `https://shop.client.test,https://www.shop.client.test:redirect,https://${PUBLISH_HOST}`,
    );
    // Coolify reads both keys; sending only one silently leaves the other stale.
    expect(patch?.body?.domains).toBe(patch?.body?.fqdn);
    expect(await listApplicationHosts(SERVER, APP)).toEqual([
      'shop.client.test',
      'www.shop.client.test',
      PUBLISH_HOST,
    ]);
  });

  it('is idempotent — a second publish does not duplicate the publish host', async () => {
    fqdn = `https://shop.client.test,https://${PUBLISH_HOST}`;

    await addApplicationDomain(SERVER, APP, PUBLISH_HOST);

    const patch = calls.find((call) => call.method === 'PATCH');
    expect(patch?.body?.fqdn).toBe(`https://shop.client.test,https://${PUBLISH_HOST}`);
  });

  it('matches on host, so a scheme-qualified argument is not added twice', async () => {
    fqdn = `https://${PUBLISH_HOST}`;

    await addApplicationDomain(SERVER, APP, `https://${PUBLISH_HOST}`);

    expect(calls.find((call) => call.method === 'PATCH')?.body?.fqdn).toBe(
      `https://${PUBLISH_HOST}`,
    );
  });
});
