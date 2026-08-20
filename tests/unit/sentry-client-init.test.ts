/**
 * F-703: `initSentryClient()` must actually call `Sentry.init` when a DSN is
 * available, wire the existing beforeSend scrubber, and stay a silent no-op
 * when Sentry is not configured. The DSN reaches the browser through a meta
 * tag the root layout renders from the server runtime config, with
 * NEXT_PUBLIC_SENTRY_DSN as the build-time fallback for static pages.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@sentry/nextjs', () => ({ init: vi.fn() }));

const DSN = 'https://publickey@o1.ingest.sentry.io/42';

async function freshModules() {
  // Dynamic import on purpose: vi.resetModules() must produce a fresh module
  // instance per test so the module-level `started` guard resets.
  vi.resetModules();
  const sentry = await import('@sentry/nextjs');
  const init = vi.mocked(sentry.init);
  // resetModules does not re-run the mock factory, so calls from the previous
  // test leak into the shared spy: clear them before the module under test runs.
  init.mockClear();
  const client = await import('../../lib/sentry/client');
  return { init, client };
}

function metaDocument(content: string): Pick<Document, 'querySelector'> {
  // Node test environment has no DOM; the reader only calls
  // querySelector(...).getAttribute('content'), so a structural stand-in
  // asserted as Element is the whole surface it can observe.
  const metaStandIn = { getAttribute: () => content } as unknown as Element;
  return {
    querySelector: (selector: string) => (selector.includes('navroop-sentry') ? metaStandIn : null),
  };
}

const savedEnvDsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

beforeEach(() => {
  delete process.env.NEXT_PUBLIC_SENTRY_DSN;
});

afterEach(() => {
  if (savedEnvDsn === undefined) delete process.env.NEXT_PUBLIC_SENTRY_DSN;
  else process.env.NEXT_PUBLIC_SENTRY_DSN = savedEnvDsn;
});

describe('initSentryClient', () => {
  it('calls Sentry.init with the DSN and the scrubbing beforeSend when configured', async () => {
    const { init, client } = await freshModules();
    client.initSentryClient({ dsn: DSN, environment: 'staging', tracesSampleRate: 0.25 });

    expect(init).toHaveBeenCalledTimes(1);
    const options = init.mock.calls[0][0];
    expect(options.dsn).toBe(DSN);
    expect(options.environment).toBe('staging');
    expect(options.tracesSampleRate).toBe(0.25);
    expect(options.sendDefaultPii).toBe(false);
    expect(typeof options.beforeSend).toBe('function');

    // The wired beforeSend must be the existing scrubber, not a passthrough.
    const dirty = { request: { data: { password: 'hunter2' } } };
    const scrubbed = options.beforeSend?.(
      dirty as never,
      { originalException: new Error('boom') } as never,
    );
    expect(JSON.stringify(scrubbed)).not.toContain('hunter2');
  });

  it('is a silent no-op when Sentry is not configured', async () => {
    const { init, client } = await freshModules();
    expect(() => client.initSentryClient(null)).not.toThrow();
    expect(client.readSentryClientConfig(undefined)).toBeNull();
    client.initSentryClient(client.readSentryClientConfig(undefined));
    expect(init).not.toHaveBeenCalled();
  });

  it('never initialises twice', async () => {
    const { init, client } = await freshModules();
    client.initSentryClient({ dsn: DSN });
    client.initSentryClient({ dsn: DSN });
    expect(init).toHaveBeenCalledTimes(1);
  });
});

describe('readSentryClientConfig', () => {
  it('reads the layout-rendered meta tag', async () => {
    const { client } = await freshModules();
    const doc = metaDocument(
      JSON.stringify({ dsn: DSN, environment: 'production', tracesSampleRate: 0.1 }),
    );
    expect(client.readSentryClientConfig(doc)).toEqual({
      dsn: DSN,
      environment: 'production',
      tracesSampleRate: 0.1,
    });
  });

  it('falls back to NEXT_PUBLIC_SENTRY_DSN when no meta tag is present', async () => {
    const { client } = await freshModules();
    process.env.NEXT_PUBLIC_SENTRY_DSN = DSN;
    expect(client.readSentryClientConfig(undefined)?.dsn).toBe(DSN);
  });

  it('returns null for malformed meta content with no fallback', async () => {
    const { client } = await freshModules();
    expect(client.readSentryClientConfig(metaDocument('{not json'))).toBeNull();
    expect(client.readSentryClientConfig(metaDocument(JSON.stringify({ dsn: ' ' })))).toBeNull();
  });
});
