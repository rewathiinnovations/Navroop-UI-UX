import { describe, expect, it } from 'vitest';
import { allowHost, allowLocalhost, revokeLocalhost } from '../setup/network-guard';

/**
 * Localhost is not on the default allowlist. A unit test that reaches the live
 * app on :3000 can pass only because someone is watching the server — CI has
 * nothing listening. Opt-in is `allowLocalhost('reason')`.
 */
const LOCALHOST_OPT_IN = /allowLocalhost/;

describe('network guard', () => {
  it('fails real outbound requests to non-allowlisted hosts', async () => {
    await expect(fetch('https://example.invalid/secret')).rejects.toThrow(/Network guard blocked/);
  });

  it('blocks localhost without an explicit opt-in', async () => {
    await expect(fetch('http://localhost:3000/api/health')).rejects.toThrow(LOCALHOST_OPT_IN);
  });

  it('blocks 127.0.0.1 without an explicit opt-in', async () => {
    await expect(fetch('http://127.0.0.1:3000/api/health')).rejects.toThrow(LOCALHOST_OPT_IN);
  });

  it('blocks ::1 without an explicit opt-in', async () => {
    await expect(fetch('http://[::1]:3000/api/health')).rejects.toThrow(LOCALHOST_OPT_IN);
  });

  it('blocks *.localhost without an explicit opt-in', async () => {
    await expect(fetch('http://app.localhost/api/health')).rejects.toThrow(LOCALHOST_OPT_IN);
  });

  it('explains how to opt in when localhost is blocked', async () => {
    const error = await fetch('http://localhost:3000/api/github/connect').then(
      () => {
        throw new Error('expected the network guard to reject localhost');
      },
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toMatch(/Network guard blocked a localhost request/);
    expect(message).toMatch(/allowLocalhost\(/);
    expect(message).toMatch(/live app/);
  });

  it('requires a non-empty reason for allowLocalhost', () => {
    expect(() => allowLocalhost('')).toThrow(/reason/);
    expect(() => allowLocalhost('   ')).toThrow(/reason/);
  });

  it('does not treat allowHost as a localhost opt-in', () => {
    // `allowHost` takes a reason of its own now, so both calls get past the reason
    // check and reach the loopback branch this test is about: a loopback host is
    // refused even with a reason, and the message names the one opt-in that works.
    expect(() => allowHost('localhost', 'proving allowHost cannot open loopback')).toThrow(
      LOCALHOST_OPT_IN,
    );
    expect(() => allowHost('127.0.0.1', 'proving allowHost cannot open loopback')).toThrow(
      LOCALHOST_OPT_IN,
    );
  });

  it('lets a test reach loopback after allowLocalhost', async () => {
    allowLocalhost('proving the opt-in reaches the network layer, not the app on :3000');
    // Port 1 is never the app. A connection error means the guard let the request through.
    await expect(fetch('http://127.0.0.1:1/')).rejects.toThrow(
      /fetch failed|ECONNREFUSED|connect/i,
    );
  });

  it('clears the opt-in after each test', async () => {
    await expect(fetch('http://localhost:3000/api/health')).rejects.toThrow(LOCALHOST_OPT_IN);
  });

  it('revokes localhost access so a later test cannot inherit the opt-in', async () => {
    allowLocalhost('temporary opt-in that must not leak');
    revokeLocalhost();
    await expect(fetch('http://localhost:3000/api/health')).rejects.toThrow(LOCALHOST_OPT_IN);
  });
});
