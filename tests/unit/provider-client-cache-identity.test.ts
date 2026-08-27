/**
 * The cached provider client is retired by everything that changes what it does, not only
 * by the credential.
 *
 * `provider-manager` keeps one client per process and keyed it on `apiKey + ':' + baseURL`,
 * which described the client exactly until the client started closing over a third input.
 * `clientForEntry` reads `DEEPSEEK_THINKING` once, at construction, and hands it to
 * `createDeepSeekReasoningFetch`, so an operator who set Admin → Configuration's
 * "Thinking / reasoning" to Disabled changed nothing the key could see: the cached client
 * was never retired, and every `getProviderForModel` caller — the audit AI review,
 * follow-up edit-intent planning, skill matching, memory extraction, URL-import sectioning
 * — kept sending `thinking: { type: 'enabled' }, reasoning_effort: 'high'` until the
 * container restarted. Generation builds a fresh client per call through
 * `chatModelForEntry`, so it obeyed the toggle immediately. One setting, live on half the
 * product and stuck on the other — the precise thing the cache comment ("changing the key
 * in Admin → Configuration must retire this client") exists to prevent.
 *
 * The database is mocked underneath the real settings resolver, so the whole chain runs for
 * real: AppSetting row → getSetting → provider-env overlay → provider chain → client. The
 * client is the real one too, and the outgoing request body is read off a stubbed
 * `globalThis.fetch`, because "the toggle is honoured" is a claim about the wire.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  rows: new Map<string, string>(),
  /** Fixture, not a credential: nothing asserts on the value. */
  KEY_PREFIX: 'fixture-admin-config-key-',
}));

vi.mock('@/lib/logger', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  logError: vi.fn(),
  formatLogLine: vi.fn(() => ''),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    appSetting: {
      findUnique: async ({ where }: { where: { key: string } }) => {
        const value = fake.rows.get(where.key);
        return value === undefined ? null : { value };
      },
    },
    orgApiKey: { findFirst: async () => null },
    apiKey: { findFirst: async () => null },
  },
}));

// Dynamic, so the mocks above are registered before these modules evaluate their imports.
const { invalidateSettingsCache } = await import('@/lib/settings/resolve');
const { chatModelForProvider, clientForEntry, clientIdentityForEntry } =
  await import('@/lib/ai/client-for-entry');
const { getProviderForModel } = await import('@/lib/ai/provider-manager');
const { generateText } = await import('ai');
type ProviderEntry = import('@/lib/ai/providers').ProviderEntry;

const ENTRY: ProviderEntry = {
  id: 'deepseek',
  provider: 'deepseek',
  model: 'deepseek-v4-flash',
  apiKeyEnv: 'DEEPSEEK_API_KEY',
};

const COMPLETION = {
  id: 'chatcmpl-fixture',
  object: 'chat.completion',
  created: 0,
  model: ENTRY.model,
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

const realFetch = globalThis.fetch;

/**
 * `clientForEntry` builds its reasoning fetch over whatever `globalThis.fetch` is at
 * construction time, so the stub goes in before the client is built. Nothing leaves the
 * process: the stub answers every call itself.
 */
function captureRequests() {
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(typeof init?.body === 'string' ? JSON.parse(init.body) : {});
    return new Response(JSON.stringify(COMPLETION), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return bodies;
}

let nonce = 0;

function storeSetting(key: string, value: string) {
  fake.rows.set(`setting:${key}`, JSON.stringify({ value, encrypted: false }));
  invalidateSettingsCache(key);
}

/** A distinct value per test, so the module-level client memo starts cold. */
function saveAdminKey() {
  nonce += 1;
  storeSetting('ai.deepseek.apiKey', `${fake.KEY_PREFIX}${nonce}`);
}

beforeEach(() => {
  fake.rows.clear();
  invalidateSettingsCache();
  // The install this defends: everything configured on /admin/config, empty environment.
  vi.stubEnv('DEEPSEEK_API_KEY', '');
  vi.stubEnv('DEEPSEEK_BASE_URL', '');
  vi.stubEnv('DEEPSEEK_THINKING', '');
  vi.stubEnv('AI_PRIMARY_MODEL', '');
  saveAdminKey();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.unstubAllEnvs();
});

describe('clientIdentityForEntry covers every input clientForEntry reads', () => {
  const base: Record<string, string | undefined> = {
    DEEPSEEK_API_KEY: 'fixture-key',
    DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
    DEEPSEEK_THINKING: 'enabled',
  };

  it('is stable for the same env', () => {
    expect(clientIdentityForEntry(ENTRY, { ...base })).toBe(
      clientIdentityForEntry(ENTRY, { ...base }),
    );
  });

  it('changes when the thinking toggle changes — the input the old key could not see', () => {
    expect(clientIdentityForEntry(ENTRY, { ...base, DEEPSEEK_THINKING: 'disabled' })).not.toBe(
      clientIdentityForEntry(ENTRY, base),
    );
  });

  it('changes when the credential or the base URL changes', () => {
    expect(clientIdentityForEntry(ENTRY, { ...base, DEEPSEEK_API_KEY: 'fixture-other' })).not.toBe(
      clientIdentityForEntry(ENTRY, base),
    );
    expect(
      clientIdentityForEntry(ENTRY, { ...base, DEEPSEEK_BASE_URL: 'https://proxy.example.com' }),
    ).not.toBe(clientIdentityForEntry(ENTRY, base));
  });

  it('tracks the effective values, so a no-op edit does not churn the cache', () => {
    // Both spellings mean the same client: thinking defaults to on, and a blank base URL
    // resolves to the documented default. Rebuilding for these would be harmless but it
    // would also mean the identity is describing the env instead of the client.
    expect(clientIdentityForEntry(ENTRY, { ...base, DEEPSEEK_THINKING: undefined })).toBe(
      clientIdentityForEntry(ENTRY, base),
    );
    expect(clientIdentityForEntry(ENTRY, { ...base, DEEPSEEK_BASE_URL: '  ' })).toBe(
      clientIdentityForEntry(ENTRY, base),
    );
  });

  it('cannot be collided by a value containing the old separator', () => {
    // `${apiKey}:${baseURL}` spelled these two configurations the same string, so one
    // could be served the other's client.
    expect(
      clientIdentityForEntry(ENTRY, {
        ...base,
        DEEPSEEK_API_KEY: 'fixture-key',
        DEEPSEEK_BASE_URL: 'https://one.example.com',
      }),
    ).not.toBe(
      clientIdentityForEntry(ENTRY, {
        ...base,
        DEEPSEEK_API_KEY: 'fixture-key:https',
        DEEPSEEK_BASE_URL: '//one.example.com',
      }),
    );
  });

  it('is different exactly when the client behaves differently', async () => {
    const on: Record<string, string | undefined> = { ...base, DEEPSEEK_THINKING: 'enabled' };
    const off: Record<string, string | undefined> = { ...base, DEEPSEEK_THINKING: 'disabled' };
    const bodies = captureRequests();

    for (const env of [on, off]) {
      await generateText({
        model: chatModelForProvider(clientForEntry(ENTRY, env), ENTRY.model),
        prompt: 'hi',
      });
    }

    expect(bodies[0]?.thinking).toEqual({ type: 'enabled' });
    expect(bodies[1]?.thinking).toEqual({ type: 'disabled' });
    expect(clientIdentityForEntry(ENTRY, on)).not.toBe(clientIdentityForEntry(ENTRY, off));
  });
});

describe('the cached helper client tracks the Thinking / reasoning toggle', () => {
  it('reuses one client while nothing has changed', async () => {
    const first = await getProviderForModel(null, null);
    const second = await getProviderForModel(null, null);

    expect(second.client).toBe(first.client);
  });

  it('retires the client when the operator disables thinking', async () => {
    const before = await getProviderForModel(null, null);
    storeSetting('ai.deepseek.thinking', 'disabled');
    const after = await getProviderForModel(null, null);

    expect(after.client).not.toBe(before.client);
  });

  it('and again when they turn it back on', async () => {
    storeSetting('ai.deepseek.thinking', 'disabled');
    const off = await getProviderForModel(null, null);
    storeSetting('ai.deepseek.thinking', 'enabled');
    const on = await getProviderForModel(null, null);

    expect(on.client).not.toBe(off.client);
  });

  it('sends what the toggle says on the helper path, not what it said at boot', async () => {
    const bodies = captureRequests();

    const on = await getProviderForModel(null, null);
    await generateText({
      model: chatModelForProvider(on.client, on.actualModel),
      prompt: 'first, while the toggle is enabled',
    });

    storeSetting('ai.deepseek.thinking', 'disabled');
    const off = await getProviderForModel(null, null);
    await generateText({
      model: chatModelForProvider(off.client, off.actualModel),
      prompt: 'second, after the operator turned it off',
    });

    expect(bodies[0]?.thinking).toEqual({ type: 'enabled' });
    // Under the credential-only key this was still `{ type: 'enabled' }`, and stayed that
    // way for the life of the container, while generation had already switched over.
    expect(bodies[1]?.thinking).toEqual({ type: 'disabled' });
    expect(bodies[1]?.reasoning_effort).toBeUndefined();
  });

  it('still retires on the credential and the base URL it always covered', async () => {
    const before = await getProviderForModel(null, null);
    saveAdminKey();
    const afterKey = await getProviderForModel(null, null);
    expect(afterKey.client).not.toBe(before.client);

    storeSetting('ai.deepseek.baseUrl', 'https://deepseek.proxy.example.com');
    const afterBaseUrl = await getProviderForModel(null, null);
    expect(afterBaseUrl.client).not.toBe(afterKey.client);
  });
});
