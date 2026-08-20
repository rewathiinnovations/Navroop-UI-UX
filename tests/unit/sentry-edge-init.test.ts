/**
 * F-786: `sentry.edge.config.ts` was a comment plus `export {}`, so a throw in `proxy.ts` —
 * the auth gate in front of every /api and /preview-static request — was reported nowhere.
 *
 * The edge isolate has no filesystem, so it cannot read the DSN saved in /admin/integrations
 * (the runtime config file on the /data volume) and cannot query the database either. The one
 * value it can carry is the build-time `NEXT_PUBLIC_SENTRY_DSN` literal, which the client
 * bundle already falls back to and the Dockerfile already passes as a build argument. That
 * makes edge coverage optional, which is why /admin/health states which way it went.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@sentry/nextjs', () => ({ init: vi.fn() }));

const DSN = 'https://publickey@o1.ingest.sentry.io/42';

async function loadEdgeConfig() {
  // Dynamic import on purpose: the config file inits on import, so each case needs a fresh
  // module instance. `resetModules` does not re-run the mock factory, so the shared spy has
  // to be cleared before the module under test runs.
  vi.resetModules();
  const sentry = await import('@sentry/nextjs');
  const init = vi.mocked(sentry.init);
  init.mockClear();
  await import('../../sentry.edge.config');
  return init;
}

const savedEnvDsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

beforeEach(() => {
  delete process.env.NEXT_PUBLIC_SENTRY_DSN;
});

afterEach(() => {
  if (savedEnvDsn === undefined) delete process.env.NEXT_PUBLIC_SENTRY_DSN;
  else process.env.NEXT_PUBLIC_SENTRY_DSN = savedEnvDsn;
});

describe('edge runtime error reporting', () => {
  it('initialises Sentry from the build-time DSN, with the shared scrubbing beforeSend', async () => {
    process.env.NEXT_PUBLIC_SENTRY_DSN = DSN;
    const init = await loadEdgeConfig();

    expect(init).toHaveBeenCalledTimes(1);
    const options = init.mock.calls[0]?.[0] as {
      dsn?: string;
      beforeSend?: unknown;
      sendDefaultPii?: boolean;
      tracesSampleRate?: number;
    };
    expect(options.dsn).toBe(DSN);
    expect(options.sendDefaultPii).toBe(false);
    // Same suppression and secret scrubbing as the Node and browser inits: an edge event
    // must not be the one path that ships an unscrubbed authorization header.
    const { observabilityBeforeSend } = await import('../../lib/observability/noise');
    expect(options.beforeSend).toBe(observabilityBeforeSend);
    // Performance sampling is a runtime-config knob this isolate cannot read.
    expect(options.tracesSampleRate).toBe(0);
  });

  it('stays a silent no-op when the build did not carry a DSN', async () => {
    const init = await loadEdgeConfig();
    expect(init).not.toHaveBeenCalled();
  });

  it('reports coverage from the same expression the isolate initialises from', async () => {
    const { edgeReportingCovered, edgeSentryDsn } = await import('../../lib/sentry/edge');
    expect(edgeSentryDsn()).toBe('');
    expect(edgeReportingCovered()).toBe(false);

    // Trimmed, so a variable set to whitespace in a compose file is "not configured"
    // rather than a DSN Sentry would reject at runtime.
    process.env.NEXT_PUBLIC_SENTRY_DSN = `  ${DSN}  `;
    expect(edgeSentryDsn()).toBe(DSN);
    expect(edgeReportingCovered()).toBe(true);
  });
});
