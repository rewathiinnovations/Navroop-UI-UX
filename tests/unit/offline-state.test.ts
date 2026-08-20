import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  connectionState,
  isNetworkFailure,
  OFFLINE_BANNER_LINE,
  OFFLINE_MESSAGE,
  reportNetworkFailure,
  reportNetworkSuccess,
  resetConnectionState,
  setBrowserOnline,
  subscribeToConnection,
} from '@/lib/net/connection';

/**
 * F-446: offline is a state the product names, not a stream of "Failed to fetch"
 * toasts.
 *
 * Two signals, because either alone lies. `navigator.onLine` is false only when
 * the OS says the interface is down — a captive portal, a dead DNS resolver or a
 * suspended laptop keeps it true while every request fails. A rejected `fetch` is
 * the other half: no response at all, which is a transport failure rather than a
 * server error. A 500 is NOT offline, and asserting that is the point — calling a
 * broken server "offline" is the same lie in the other direction.
 *
 * The states are mutually exclusive, in the shape `paletteView` established:
 * `online` | `offline`. Nothing here says "reconnecting"; the product has no way
 * to know that and a cheerful reconnect banner over a dead network is exactly the
 * class of copy this engagement removed.
 */

beforeEach(() => {
  resetConnectionState();
});

describe('connectionState', () => {
  it('starts online', () => {
    expect(connectionState()).toBe('online');
  });

  it('is offline while the browser reports the interface down', () => {
    setBrowserOnline(false);
    expect(connectionState()).toBe('offline');
    setBrowserOnline(true);
    expect(connectionState()).toBe('online');
  });

  it('is offline after a request never reached the server, even with the interface up', () => {
    // The captive-portal case: navigator.onLine stays true.
    reportNetworkFailure();
    expect(connectionState()).toBe('offline');
  });

  it('clears the failed-request signal on the next request that did reach the server', () => {
    reportNetworkFailure();
    reportNetworkSuccess();
    expect(connectionState()).toBe('online');
  });

  it('stays offline on a success while the interface is still down', () => {
    // A cached response can resolve with no network. The OS signal outranks it.
    setBrowserOnline(false);
    reportNetworkSuccess();
    expect(connectionState()).toBe('offline');
  });

  it('notifies subscribers only when the state actually changes', () => {
    const seen = vi.fn();
    const stop = subscribeToConnection(seen);
    reportNetworkFailure();
    reportNetworkFailure();
    expect(seen).toHaveBeenCalledTimes(1);
    reportNetworkSuccess();
    expect(seen).toHaveBeenCalledTimes(2);
    stop();
    reportNetworkFailure();
    expect(seen).toHaveBeenCalledTimes(2);
  });
});

describe('isNetworkFailure', () => {
  it('recognises the shapes a browser throws when the request never left', () => {
    // Chrome/Firefox, Safari, and Firefox's own wording.
    expect(isNetworkFailure(new TypeError('Failed to fetch'))).toBe(true);
    expect(isNetworkFailure(new TypeError('Load failed'))).toBe(true);
    expect(isNetworkFailure(new TypeError('NetworkError when attempting to fetch resource.'))).toBe(
      true,
    );
    expect(isNetworkFailure(new TypeError('network error'))).toBe(true);
  });

  it('does not call a server error offline', () => {
    expect(isNetworkFailure(new Error('Request failed (500)'))).toBe(false);
    expect(isNetworkFailure(new Error('Forbidden'))).toBe(false);
    expect(isNetworkFailure(new DOMException('The user aborted a request.', 'AbortError'))).toBe(
      false,
    );
    expect(isNetworkFailure(null)).toBe(false);
    expect(isNetworkFailure('Failed to fetch')).toBe(false);
  });
});

describe('the copy', () => {
  it('says the connection is gone and that nothing was saved — and promises no reconnect', () => {
    expect(OFFLINE_MESSAGE).toMatch(/offline/i);
    expect(OFFLINE_MESSAGE).not.toMatch(/reconnect|retrying|will retry/i);
    expect(OFFLINE_BANNER_LINE).toMatch(/offline/i);
    expect(OFFLINE_BANNER_LINE).not.toMatch(/reconnect|retrying/i);
  });
});
