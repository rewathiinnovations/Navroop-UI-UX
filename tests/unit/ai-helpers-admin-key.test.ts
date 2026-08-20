/**
 * A DeepSeek key saved in Admin → Configuration and set nowhere else has to
 * reach every AI-backed feature, not only generation.
 *
 * It did not. Generation read the settings overlay; the five other helpers
 * built their client straight from `process.env`, and nothing hydrates
 * settings into the environment at boot. On a database-only install the first
 * build worked and then: follow-up edits failed at "Plan the edit", URL import
 * could not section a page, skill matching returned nothing, memory extraction
 * was silently dead and the audit AI review errored — while /admin/config
 * showed the key green as "Set here".
 *
 * The database is mocked underneath the real settings resolver, so the whole
 * chain runs for real: AppSetting row → getSetting → getEffectiveApiKey →
 * provider-env overlay → provider chain. Only `clientForEntry` is replaced, so
 * a test can see which source the credential came from without ever asserting
 * on key material.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => {
  // Fixtures, not credentials: tests assert on the source these name, never on
  // the value itself.
  const ADMIN_PREFIX = 'fixture-admin-config-key-';
  const ENV_PREFIX = 'fixture-environment-key-';
  const PERSONAL_PREFIX = 'fixture-personal-key-';
  return {
    ADMIN_PREFIX,
    ENV_PREFIX,
    PERSONAL_PREFIX,
    rows: new Map<string, string>(),
    /** Legacy personal ApiKey row served by the prisma mock (F-073). */
    personalRow: null as { id: string; secret: string } | null,
    clients: [] as Array<{ source: string; client: unknown }>,
    sourceOf(value?: string) {
      if (!value) return 'none';
      if (value.startsWith(ADMIN_PREFIX)) return 'admin-config';
      if (value.startsWith(ENV_PREFIX)) return 'environment';
      if (value.startsWith(PERSONAL_PREFIX)) return 'personal';
      return 'unrecognised';
    },
  };
});

const logSpies = vi.hoisted(() => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  logError: vi.fn(),
  formatLogLine: vi.fn(() => ''),
}));

vi.mock('@/lib/logger', () => logSpies);

vi.mock('@/lib/db', () => ({
  prisma: {
    appSetting: {
      findUnique: async ({ where }: { where: { key: string } }) => {
        const value = fake.rows.get(where.key);
        return value === undefined ? null : { value };
      },
    },
    orgApiKey: { findFirst: async () => null },
    apiKey: {
      findFirst: async ({ where }: { where: { userId?: string } }) =>
        where?.userId ? fake.personalRow : null,
    },
  },
}));

vi.mock('@/lib/ai/client-for-entry', () => ({
  clientForEntry: (_entry: unknown, env: Record<string, string | undefined>) => {
    const client = (modelId: string) => ({ modelId });
    fake.clients.push({ source: fake.sourceOf(env.DEEPSEEK_API_KEY), client });
    return client;
  },
}));

const ai = vi.hoisted(() => ({ generateObject: vi.fn(), generateText: vi.fn() }));
vi.mock('ai', () => ai);

/** The import fallback also books usage; the credential is what is under test. */
vi.mock('@/lib/usage-costs', () => ({ logGenerationEvent: vi.fn(async () => undefined) }));

// Dynamic, not static: every `vi.mock` above has to be registered before the
// modules under test evaluate their own imports.
const { invalidateSettingsCache } = await import('@/lib/settings/resolve');
const { getProviderForModel } = await import('@/lib/ai/provider-manager');
const { NO_PROVIDER_CONFIGURED_MESSAGE, ProviderNotConfiguredError } =
  await import('@/lib/ai/providers');
const { analyzeEditIntent } = await import('@/lib/generation/analyze-edit-intent');
const { defaultSkillRanker } = await import('@/lib/skills/match');
const { extractMemoriesAfterGeneration } = await import('@/lib/memory/extract');
const { runAiReview } = await import('@/lib/audit/ai-review');
const { segmentPage } = await import('@/lib/import/segment');
const { generateImportFallback } = await import('@/lib/import/generate-sections');
const { importJobErrorCode } = await import('@/lib/import/errors');

/** Carries an old vendor prefix, like every `appConfig.ai.defaultModel` caller. */
const LEGACY_MODEL_ID = 'google/gemini-3-pro-preview';
const ADMIN_MODEL = 'deepseek-v4-pro';

let nonce = 0;

function storeSetting(key: string, value: string) {
  fake.rows.set(`setting:${key}`, JSON.stringify({ value, encrypted: false }));
  invalidateSettingsCache(key);
}

function clearSetting(key: string) {
  fake.rows.delete(`setting:${key}`);
  invalidateSettingsCache(key);
}

/** A distinct value per test, so the module-level client memo starts cold. */
function saveAdminKey() {
  nonce += 1;
  storeSetting('ai.deepseek.apiKey', `${fake.ADMIN_PREFIX}${nonce}`);
}

function keySourceOfLastClient() {
  return fake.clients.at(-1)?.source ?? 'no client was built';
}

/** The model id the helper actually handed to the AI SDK on this call. */
function lastModelId() {
  const calls = [...ai.generateObject.mock.calls, ...ai.generateText.mock.calls];
  const last = calls.at(-1)?.[0] as { model?: { modelId?: string } } | undefined;
  return last?.model?.modelId;
}

function pageCapture() {
  return {
    sourceUrl: 'https://example.com',
    desktopPng: Buffer.from('desktop'),
    tokens: {
      fontFamily: 'Inter',
      fontSizes: ['16px'],
      colors: ['#111111'],
      radii: ['8px'],
      spacingRhythm: ['8px'],
    },
    images: [],
    firecrawlText: 'Hero headline. Pricing. Footer.',
    capturedAt: new Date('2026-08-19T00:00:00Z'),
  };
}

beforeEach(() => {
  fake.rows.clear();
  fake.clients.length = 0;
  fake.personalRow = null;
  invalidateSettingsCache();
  ai.generateObject.mockReset();
  ai.generateText.mockReset();
  logSpies.log.warn.mockClear();
  // The install this defends: the operator configured everything on
  // /admin/config and left the environment empty.
  vi.stubEnv('DEEPSEEK_API_KEY', '');
  vi.stubEnv('DEEPSEEK_BASE_URL', '');
  vi.stubEnv('AI_PRIMARY_MODEL', '');
  saveAdminKey();
  storeSetting('ai.primaryModel', ADMIN_MODEL);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('AI helpers run on the key saved in Admin → Configuration', () => {
  it('plans a follow-up edit — the step the operator hits first', async () => {
    ai.generateObject.mockResolvedValue({
      object: {
        editType: 'UPDATE_COMPONENT',
        reasoning: 'search for the quoted text',
        searchTerms: ['Start Deploying'],
        fileTypesToSearch: ['.tsx'],
        expectedMatches: 1,
      },
    });

    const result = await analyzeEditIntent({
      prompt: 'change "Start Deploying" to "Go Now"',
      manifest: { files: { 'src/App.tsx': {} } },
      userId: null,
    });

    expect(result.ok).toBe(true);
    expect(keySourceOfLastClient()).toBe('admin-config');
    expect(lastModelId()).toBe(ADMIN_MODEL);
  });

  it('sections an imported page', async () => {
    ai.generateObject.mockResolvedValue({
      object: {
        sections: [
          {
            id: 'hero',
            label: 'Hero',
            purpose: 'headline',
            contentSummary: 'headline and CTA',
            approximateYRange: [0, 600],
          },
        ],
      },
    });

    const sections = await segmentPage({ capture: pageCapture() });

    expect(sections).toHaveLength(1);
    expect(keySourceOfLastClient()).toBe('admin-config');
    expect(lastModelId()).toBe(ADMIN_MODEL);
  });

  it('writes the imported sections', async () => {
    ai.generateText.mockResolvedValue({
      text: '<file path="app/page.tsx">export default function Page() { return null; }</file>',
      usage: { inputTokens: 120 },
    });

    const result = await generateImportFallback({
      projectId: 'proj_1',
      userId: 'user_1',
      stack: 'NEXTJS',
      designDirection: '',
      mode: 'replicate',
      capture: pageCapture(),
      assets: [],
    });

    expect(result.filesXml).toContain('<file path="app/page.tsx">');
    expect(keySourceOfLastClient()).toBe('admin-config');
    expect(lastModelId()).toBe(ADMIN_MODEL);
  });

  it('matches skills', async () => {
    ai.generateObject.mockResolvedValue({ object: { matches: [] } });

    await defaultSkillRanker({
      userMessage: 'add a pricing table',
      projectContext: '',
      skills: [{ id: 'pricing', name: 'Pricing', description: 'pricing sections' }],
      userId: null,
    });

    expect(keySourceOfLastClient()).toBe('admin-config');
    expect(lastModelId()).toBe(ADMIN_MODEL);
  });

  it('extracts memories', async () => {
    ai.generateText.mockResolvedValue({ text: '[]' });

    const result = await extractMemoriesAfterGeneration(
      'proj_1',
      { sourceMessage: 'always write the copy in Norwegian' },
      {
        isEnabled: async () => true,
        listActiveContents: async () => [],
        insertPending: async () => undefined,
      },
    );

    expect(result.inserted).toBe(0);
    // Extraction swallows its own failures, so the built client is the only
    // evidence that it reached the provider at all.
    expect(keySourceOfLastClient()).toBe('admin-config');
    expect(lastModelId()).toBe(ADMIN_MODEL);
  });

  it('reviews an audit', async () => {
    ai.generateText.mockResolvedValue({ text: '{"findings":[]}' });

    const findings = await runAiReview({
      stack: 'NEXTJS',
      files: [{ path: 'app/page.tsx', content: 'export default function Page() { return null; }' }],
      staticFindings: [],
      userId: null,
    });

    // A resolution failure would come back as a `tool:ai-review` finding.
    expect(findings).toEqual([]);
    expect(keySourceOfLastClient()).toBe('admin-config');
    expect(lastModelId()).toBe(ADMIN_MODEL);
  });
});

describe('model resolution: admin value, then environment, then the built-in', () => {
  it('prefers the saved model over AI_PRIMARY_MODEL', async () => {
    vi.stubEnv('AI_PRIMARY_MODEL', 'deepseek-v4-flash');
    storeSetting('ai.primaryModel', ADMIN_MODEL);

    expect((await getProviderForModel(LEGACY_MODEL_ID, null)).actualModel).toBe(ADMIN_MODEL);
  });

  it('falls back to AI_PRIMARY_MODEL when nothing is saved', async () => {
    vi.stubEnv('AI_PRIMARY_MODEL', ADMIN_MODEL);
    clearSetting('ai.primaryModel');

    expect((await getProviderForModel(LEGACY_MODEL_ID, null)).actualModel).toBe(ADMIN_MODEL);
  });

  it('keeps a DeepSeek model the caller named explicitly', async () => {
    expect((await getProviderForModel('deepseek-v4-flash', null)).actualModel).toBe(
      'deepseek-v4-flash',
    );
  });

  it('logs the substitution when an unknown id is replaced by the configured model (F-082)', async () => {
    await getProviderForModel(LEGACY_MODEL_ID, null);

    expect(logSpies.log.warn).toHaveBeenCalledWith(
      'ai.unknown_model_substituted',
      expect.objectContaining({ requestedModel: LEGACY_MODEL_ID, actualModel: ADMIN_MODEL }),
    );
  });

  it('does not log for a model the caller named explicitly', async () => {
    await getProviderForModel('deepseek-v4-flash', null);

    expect(logSpies.log.warn).not.toHaveBeenCalledWith(
      'ai.unknown_model_substituted',
      expect.anything(),
    );
  });
});

describe('the cached client tracks the current key', () => {
  it('reuses one client while the key is unchanged', async () => {
    const first = await getProviderForModel(LEGACY_MODEL_ID, null);
    const second = await getProviderForModel(LEGACY_MODEL_ID, null);

    expect(second.client).toBe(first.client);
    expect(fake.clients).toHaveLength(1);
  });

  it('never serves a client built from a key the admin has replaced', async () => {
    const before = await getProviderForModel(LEGACY_MODEL_ID, null);
    saveAdminKey();
    const after = await getProviderForModel(LEGACY_MODEL_ID, null);

    expect(after.client).not.toBe(before.client);
    expect(fake.clients).toHaveLength(2);
  });

  it('rebuilds when only the base URL moves', async () => {
    const before = await getProviderForModel(LEGACY_MODEL_ID, null);
    storeSetting('ai.deepseek.baseUrl', 'https://deepseek.proxy.example.com');
    const after = await getProviderForModel(LEGACY_MODEL_ID, null);

    expect(after.client).not.toBe(before.client);
  });
});

describe('one credential per request subject (F-073)', () => {
  it('resolves the personal tier when the acting user is threaded through', async () => {
    fake.personalRow = { id: 'key_1', secret: `${fake.PERSONAL_PREFIX}1` };

    const resolved = await getProviderForModel(LEGACY_MODEL_ID, 'user-1');

    expect(resolved.actualModel).toBe(ADMIN_MODEL);
    expect(keySourceOfLastClient()).toBe('personal');
  });

  it('skips the personal tier for a user-less context', async () => {
    fake.personalRow = { id: 'key_1', secret: `${fake.PERSONAL_PREFIX}1` };

    await getProviderForModel(LEGACY_MODEL_ID, null);

    expect(keySourceOfLastClient()).toBe('admin-config');
  });
});

describe('with no key anywhere, the helpers name the page to fix', () => {
  beforeEach(() => {
    clearSetting('ai.deepseek.apiKey');
  });

  it('refuses instead of building a keyless client', async () => {
    await expect(getProviderForModel(LEGACY_MODEL_ID, null)).rejects.toThrow(
      NO_PROVIDER_CONFIGURED_MESSAGE,
    );
    expect(fake.clients).toHaveLength(0);
  });

  it('reports the edit planner as unconfigured, not as a 500', async () => {
    const result = await analyzeEditIntent({
      prompt: 'change the hero title',
      manifest: { files: { 'src/App.tsx': {} } },
      userId: null,
    });

    expect(result).toEqual({ ok: false, status: 503, error: NO_PROVIDER_CONFIGURED_MESSAGE });
  });

  it('files an unconfigured import as provider_not_configured, not a provider outage', () => {
    const error = new ProviderNotConfiguredError(NO_PROVIDER_CONFIGURED_MESSAGE, 'deepseek');

    expect(importJobErrorCode(error)).toBe('provider_not_configured');
  });
});

describe('there is only one key path', () => {
  it('no module under lib/ reads the DeepSeek key from process.env', () => {
    // The split this test closes: a seventh caller reaching for
    // `process.env.DEEPSEEK_API_KEY` would work on an env-configured install
    // and fail on a database-only one, which is exactly how the first six got
    // in. Provider resolution belongs to the effective-env overlay.
    const libDir = path.join(fileURLToPath(new URL('../../', import.meta.url)), 'lib');
    const offenders = readdirSync(libDir, { recursive: true, encoding: 'utf8' })
      .filter((entry) => entry.endsWith('.ts'))
      .filter((entry) => {
        const source = readFileSync(path.join(libDir, entry), 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/.*$/gm, '');
        return /process\.env\s*(\.\s*DEEPSEEK_API_KEY|\[\s*['"`]?DEEPSEEK_API_KEY)/.test(source);
      });

    expect(offenders).toEqual([]);
  });
});
