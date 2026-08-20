/**
 * Request-id helper + structured logger: shape AND redaction.
 *
 * This file was `tests/logger-scrub.test.ts`, a tsx script that nothing ran and that
 * asserted only the *shape* of a log line — the name was the only thing suggesting the
 * logger redacted anything (F-633). It is now a vitest file under `tests/unit/`, in the
 * default run, and it was dropped from `tests/setup/suites.ts` when it moved: the
 * registry is for the assert-style suites at the root of `tests/`, and a registered path
 * with no file on disk fails `tests/unit/test-suites-reachable.test.ts`.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, expect, it, vi } from 'vitest';
import { createRequestId, REQUEST_ID_HEADER, readRequestId } from '@/lib/request-id';
import { getRequestId, runWithRequestContext } from '@/lib/request-context';
import { formatLogLine, logError } from '@/lib/logger';
import { jsonError, errorPayload } from '@/lib/api/error-response';

describe('request id helper', () => {
  it('mints a 12-char url-safe id', () => {
    const id = createRequestId();
    expect(id).toHaveLength(12);
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(createRequestId()).not.toBe(createRequestId());
    expect(REQUEST_ID_HEADER).toBe('x-request-id');
  });

  it('reads the inbound header and mints one when it is absent', () => {
    expect(
      readRequestId({ get: (name: string) => (name === 'x-request-id' ? 'abc123xyz999' : null) }),
    ).toBe('abc123xyz999');
    expect(readRequestId({ get: () => null })).toHaveLength(12);
  });
});

describe('log line shape', () => {
  it('carries level, event, ALS ids and stays on one line', async () => {
    await runWithRequestContext(
      { requestId: 'req_test_12', userId: 'u1', workspaceId: 'ws1' },
      async () => {
        expect(getRequestId()).toBe('req_test_12');
        const line = formatLogLine('info', 'generation.start', {
          durationMs: 12,
          stack: 'NEXTJS',
        });
        const parsed = JSON.parse(line) as Record<string, unknown>;
        expect(parsed.level).toBe('info');
        expect(parsed.event).toBe('generation.start');
        expect(parsed.requestId).toBe('req_test_12');
        expect(parsed.userId).toBe('u1');
        expect(parsed.workspaceId).toBe('ws1');
        expect(parsed.durationMs).toBe(12);
        expect(typeof parsed.timestamp).toBe('string');
        expect(line).not.toContain('\n');
      },
    );
    expect(getRequestId() === undefined || getRequestId() === '').toBe(true);
    expect(AsyncLocalStorage).toBeDefined();
  });
});

/**
 * The logger is the one destination that had no redactor while Sentry and the audit log
 * both used `lib/sentry/scrub.ts`. It now runs caller fields through the same
 * `redactText`, so there is one pattern list, not a second one drifting next to it.
 */
describe('log line redaction', () => {
  it('filters a database URL password out of a field value', () => {
    const line = formatLogLine('error', 'backup.failed', {
      detail: 'pg_dump: error: connection to postgresql://navroop:hunter2@postgres:5432/db failed',
    });
    expect(line).not.toContain('hunter2');
    expect(line).toContain('[Filtered]');
    // The surrounding message survives: a redacted line is still a diagnosable one.
    expect(line).toContain('pg_dump');
    expect(line).toContain('@postgres:5432/db');
  });

  it('filters an Authorization header echoed in an upstream error message', () => {
    const line = formatLogLine('error', 'provider.failed', {
      error: '401 from provider (sent header Authorization: Bearer abcdefghijklmnop1234)',
    });
    expect(line).not.toContain('abcdefghijklmnop1234');
    expect(line).toContain('[Filtered]');
  });

  it('filters a provider key by its value shape regardless of the field name', () => {
    const key = `sk-${'a1b2c3d4e5'.repeat(3)}`;
    const line = formatLogLine('warn', 'provider.configured', { note: `using ${key}` });
    expect(line).not.toContain(key);
    expect(line).toContain('[Filtered]');
  });

  it('filters a value whose key names a secret', () => {
    const line = formatLogLine('info', 'integration.saved', {
      authToken: 'abcd1234efgh',
      workspaceId: 'ws1',
    });
    expect(line).not.toContain('abcd1234efgh');
    expect(JSON.parse(line).workspaceId).toBe('ws1');
  });

  it('filters inside nested field objects', () => {
    const line = formatLogLine('error', 'publish.failed', {
      context: { retryUrl: 'https://user:s3cret@git.example.com/repo.git' },
    });
    expect(line).not.toContain('s3cret');
    expect(line).toContain('[Filtered]');
  });

  it('leaves ordinary diagnostic fields untouched', () => {
    const parsed = JSON.parse(
      formatLogLine('info', 'generation.done', { durationMs: 812, files: 4, model: 'gpt-5' }),
    ) as Record<string, unknown>;
    expect(parsed.durationMs).toBe(812);
    expect(parsed.files).toBe(4);
    expect(parsed.model).toBe('gpt-5');
  });
});

/**
 * F-735: `logError` used to reduce an error to `error.message` — no stack, no
 * constructor name — and never reached Sentry, so every failure routed through it was
 * invisible to the error tracker the whole of `lib/observability/` exists to feed.
 */
describe('logError', () => {
  it('records the error name, message and stack', () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      errors.push(String(line));
    });
    try {
      const error = new TypeError('cannot read x of undefined');
      logError('generation.failed', error, { action: 'generate' }, { capture: false });
      const parsed = JSON.parse(errors[0]) as Record<string, unknown>;
      expect(parsed.error).toBe('cannot read x of undefined');
      expect(parsed.errorName).toBe('TypeError');
      expect(String(parsed.stack)).toContain('logger-scrub.test.ts');
      expect(parsed.action).toBe('generate');
    } finally {
      spy.mockRestore();
    }
  });

  it('names the cause when the error carries one', () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      errors.push(String(line));
    });
    try {
      logError(
        'publish.failed',
        new Error('deploy failed', { cause: new Error('coolify 502') }),
        {},
        { capture: false },
      );
      expect(JSON.parse(errors[0]).cause).toBe('coolify 502');
    } finally {
      spy.mockRestore();
    }
  });

  it('redacts the error message in the log line', () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      errors.push(String(line));
    });
    try {
      logError(
        'db.failed',
        new Error('connect postgresql://app:pw12345@db:5432/x'),
        {},
        {
          capture: false,
        },
      );
      expect(errors[0]).not.toContain('pw12345');
      expect(errors[0]).toContain('[Filtered]');
    } finally {
      spy.mockRestore();
    }
  });

  it('captures the error to Sentry', () => {
    const captured: unknown[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const error = new Error('boom');
      logError(
        'job.failed',
        error,
        { action: 'publish' },
        {
          captureException: ((thrown: unknown) => {
            captured.push(thrown);
            return 'evt_1';
          }) as never,
        },
      );
      expect(captured).toEqual([error]);
    } finally {
      spy.mockRestore();
    }
  });

  it('does not capture noise the SDK filter already drops', () => {
    const captured: unknown[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const aborted = new Error('The operation was aborted');
      aborted.name = 'AbortError';
      logError(
        'probe.aborted',
        aborted,
        {},
        {
          captureException: ((thrown: unknown) => {
            captured.push(thrown);
            return 'evt_2';
          }) as never,
        },
      );
      expect(captured).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('api error payloads', () => {
  it('carries message, code and request id', async () => {
    const payload = errorPayload('Something went wrong', 'GENERATION_FAILED', 'req_err_12ab');
    expect(payload.error.message).toBe('Something went wrong');
    expect(payload.error.code).toBe('GENERATION_FAILED');
    expect(payload.error.requestId).toBe('req_err_12ab');

    const response = jsonError('Something went wrong', 'INTERNAL', 500, 'req_json_12x');
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: { requestId: string; code: string } };
    expect(body.error.requestId).toBe('req_json_12x');
    expect(body.error.code).toBe('INTERNAL');
  });
});
