import http from 'node:http';
import https from 'node:https';
import { describe, expect, it } from 'vitest';
import { allowHost } from './network-guard';

/**
 * The guard used to wrap global `fetch` only. That was enough while every
 * outbound request in the product went through `fetch` — and then `safeFetch`
 * started driving `node:http` directly so it could pin the socket to the
 * address the SSRF guard approved (F-308). For one commit a unit test could
 * reach the live internet again, which showed up as a fifteen-second hang
 * rather than a refusal.
 *
 * These keep both doors shut. A block surfaces as an `error` event, the way an
 * unreachable host does, so a library flushing something in the background is
 * not surprised by a throw from `http.request`.
 */

function requestError(
  open: () => { on: (event: string, handler: (error: Error) => void) => void },
) {
  // Awaits the event the guard actually emits; vitest's own timeout is the
  // watchdog, so there is no guessed delay here.
  return new Promise<Error>((resolve) => {
    open().on('error', resolve);
  });
}

describe('the network guard covers the pinned transport', () => {
  it('blocks node:http to a host that is not allowlisted', async () => {
    const error = await requestError(() =>
      http.request({ hostname: 'blocked.example.net', path: '/' }),
    );
    expect(error.message).toMatch(/Network guard blocked outbound http request/);
  });

  it('blocks node:https to a host that is not allowlisted', async () => {
    const error = await requestError(() =>
      https.request({ hostname: 'blocked.example.net', path: '/' }),
    );
    expect(error.message).toMatch(/Network guard blocked outbound https request/);
  });

  it('blocks loopback until a test opts in, and says how', async () => {
    const error = await requestError(() => http.request('http://127.0.0.1:9/'));
    expect(error.message).toMatch(/allowLocalhost/);
  });

  it('still blocks global fetch', async () => {
    await expect(fetch('https://blocked.example.net/')).rejects.toThrow(/Network guard blocked/);
  });
});

/**
 * `allowHost` used to add to a module-level Set that nothing ever cleared, so an
 * allowance granted by one test outlived it for every later test in the same
 * worker (F-618). `tests/unit/ssrf-dns-pinning.test.ts` really does call it, so
 * the leak was live rather than theoretical.
 */
describe('an allowHost opt-in does not outlive its test', () => {
  it('allows the host it was given, for this test only', async () => {
    allowHost('leak-probe.example.net', 'proves the allowance is scoped to one test');
    const error = await requestError(() =>
      http.request({ hostname: 'leak-probe.example.net', path: '/' }),
    );
    // Allowlisted, so the guard is out of the way and the request fails on DNS.
    expect(error.message).not.toMatch(/Network guard blocked/);
  });

  it('has forgotten the previous test\u2019s host', async () => {
    const error = await requestError(() =>
      http.request({ hostname: 'leak-probe.example.net', path: '/' }),
    );
    expect(error.message).toMatch(/Network guard blocked outbound http request/);
  });

  it('refuses an opt-in with no reason', () => {
    expect(() => allowHost('unreasoned.example.net', '')).toThrow(/reason/);
  });
});
