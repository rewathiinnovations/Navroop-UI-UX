import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Test button on /admin/config is the only diagnostic an operator has for
 * the credentials this installation runs on, so a green check has to mean the
 * saved value was exercised — not that an environment variable happens to be
 * set, and not that a field is merely non-empty.
 *
 * Both ways it lied are pinned here. The AI group probed `ai.anthropic.apiKey`
 * and four other keys that had been deleted from the registry; `getSetting`
 * answers null for an unknown key, so every branch was skipped and the button
 * reported "No AI provider key is set" on installs where generation was working.
 * The tooling group confirmed "E2B key is set" for a subsystem that no longer
 * exists. Both are presence-versus-proof mistakes, and both are asserted below
 * against a database value that deliberately differs from the environment.
 */

const rows = new Map<string, string>();

vi.mock('@/lib/db', () => ({
  prisma: {
    appSetting: {
      findUnique: async ({ where }: { where: { key: string } }) => {
        const value = rows.get(where.key);
        return value === undefined ? null : { value };
      },
      findMany: async () => [],
    },
  },
}));

// Dynamic, not static: the resolver reads `@/lib/db` at module scope, so the
// `vi.mock` above has to be registered before either module evaluates.
const { invalidateSettingsCache } = await import('@/lib/settings/resolve');
const { testSettingGroup } = await import('@/lib/settings/test-group');

/** Fixtures, not credentials: the assertions name the source, never the value. */
const ADMIN_KEY = 'fixture-admin-config-key';
const ENV_KEY = 'fixture-environment-key';

function storeSetting(key: string, value: string) {
  rows.set(`setting:${key}`, JSON.stringify({ value, encrypted: false }));
  invalidateSettingsCache(key);
}

type StubResponse = { ok?: boolean; status?: number; body?: unknown };

/** Records every request the checks make, and answers without leaving the process. */
function stubFetch(answer: (url: string) => StubResponse) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const reply = answer(url);
    const status = reply.status ?? 200;
    return {
      ok: reply.ok ?? status < 400,
      status,
      json: async () => {
        if (reply.body === undefined) throw new Error('no body');
        return reply.body;
      },
    };
  });
  return calls;
}

/** The shape `GET /api/health` answers with, trimmed to what the check reads. */
const HEALTH_BODY = { ok: true, checks: { db: 'ok', storage: 'ok' }, version: '0.1.0' };

beforeEach(() => {
  rows.clear();
  invalidateSettingsCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  invalidateSettingsCache();
});

describe('the AI check exercises the saved DeepSeek credential', () => {
  it('dials the database key and base URL, not the environment ones', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', ENV_KEY);
    vi.stubEnv('DEEPSEEK_BASE_URL', 'https://env.deepseek.invalid');
    storeSetting('ai.deepseek.apiKey', ADMIN_KEY);
    storeSetting('ai.deepseek.baseUrl', 'https://admin.deepseek.invalid');
    const calls = stubFetch(() => ({ status: 200 }));

    const result = await testSettingGroup('ai');

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://admin.deepseek.invalid/models');
    expect(calls[0].headers.authorization).toBe(`Bearer ${ADMIN_KEY}`);
    expect(result.ok).toBe(true);
    // A green result has to come from a call, never from a presence check.
    expect(result.checks[0].depth).toBe('live');
  });

  it('falls back to the environment key only when nothing is saved', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', ENV_KEY);
    vi.stubEnv('DEEPSEEK_BASE_URL', '');
    const calls = stubFetch(() => ({ status: 200 }));

    const result = await testSettingGroup('ai');

    expect(calls[0].headers.authorization).toBe(`Bearer ${ENV_KEY}`);
    expect(result.ok).toBe(true);
  });

  it('names a rejected key instead of reporting a missing provider', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '');
    storeSetting('ai.deepseek.apiKey', ADMIN_KEY);
    stubFetch(() => ({ status: 401 }));

    const result = await testSettingGroup('ai');

    expect(result.ok).toBe(false);
    expect(result.checks[0].message).toContain('401');
    expect(result.checks[0].message).not.toContain('No AI provider key is set');
  });

  it('says the key is missing when it is configured nowhere', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '');
    const calls = stubFetch(() => ({ status: 200 }));

    const result = await testSettingGroup('ai');

    expect(calls).toHaveLength(0);
    expect(result.ok).toBe(false);
    expect(result.checks[0].depth).toBe('local');
    expect(result.checks[0].message).toContain('No AI provider key is set');
  });
});

describe('the tooling check reports only keys something reads', () => {
  it('probes Firecrawl with the saved key', async () => {
    vi.stubEnv('FIRECRAWL_API_KEY', ENV_KEY);
    vi.stubEnv('UNSPLASH_ACCESS_KEY', '');
    storeSetting('tooling.firecrawl.apiKey', ADMIN_KEY);
    const calls = stubFetch(() => ({ status: 200 }));

    const result = await testSettingGroup('tooling');
    const firecrawl = result.checks.find((check) => check.label === 'Firecrawl');

    expect(calls[0].url).toContain('api.firecrawl.dev');
    expect(calls[0].headers.authorization).toBe(`Bearer ${ADMIN_KEY}`);
    expect(firecrawl?.ok).toBe(true);
    expect(firecrawl?.depth).toBe('live');
  });

  it('has no E2B check to go green on a key nothing reads', async () => {
    vi.stubEnv('E2B_API_KEY', ENV_KEY);
    vi.stubEnv('FIRECRAWL_API_KEY', '');
    vi.stubEnv('UNSPLASH_ACCESS_KEY', '');
    stubFetch(() => ({ status: 200 }));

    const result = await testSettingGroup('tooling');

    expect(result.checks.map((check) => check.label)).not.toContain('E2B');
  });

  it('says a saved Morph key is never used rather than calling it configured', async () => {
    vi.stubEnv('FIRECRAWL_API_KEY', '');
    vi.stubEnv('UNSPLASH_ACCESS_KEY', '');
    storeSetting('tooling.morph.apiKey', ADMIN_KEY);
    stubFetch(() => ({ status: 200 }));

    const morph = (await testSettingGroup('tooling')).checks.find(
      (check) => check.label === 'Morph',
    );

    expect(morph?.message).toMatch(/nothing applies Morph edit blocks/i);
  });
});

describe('the application check dials the address that was saved', () => {
  it('reaches this installation at the database URL, not the environment one', async () => {
    vi.stubEnv('APP_URL', 'https://env.navroop.invalid');
    storeSetting('app.url', 'https://admin.navroop.invalid');
    const calls = stubFetch(() => ({ status: 200, body: HEALTH_BODY }));

    const result = await testSettingGroup('app');
    const reachable = result.checks.find((check) => check.label === 'Reachable');

    expect(calls[0].url).toBe('https://admin.navroop.invalid/api/health');
    expect(reachable?.ok).toBe(true);
    expect(reachable?.depth).toBe('live');
  });

  it('fails when the address answers with something that is not this app', async () => {
    vi.stubEnv('APP_URL', '');
    storeSetting('app.url', 'https://someone-elses.navroop.invalid');
    stubFetch(() => ({ status: 200, body: { hello: 'world' } }));

    const result = await testSettingGroup('app');
    const reachable = result.checks.find((check) => check.label === 'Reachable');

    expect(result.ok).toBe(false);
    expect(reachable?.message).toContain('https://someone-elses.navroop.invalid/api/health');
    expect(reachable?.message).toContain('points at something else');
  });

  it('does not dial an address it could not parse', async () => {
    vi.stubEnv('APP_URL', '');
    vi.stubEnv('NEXTAUTH_URL', '');
    vi.stubEnv('AUTH_URL', '');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '');
    storeSetting('app.url', 'navroop.example');
    const calls = stubFetch(() => ({ status: 200, body: HEALTH_BODY }));

    const result = await testSettingGroup('app');

    expect(calls).toHaveLength(0);
    expect(result.ok).toBe(false);
    expect(result.checks[0].message).toContain('not a valid URL');
  });
});
