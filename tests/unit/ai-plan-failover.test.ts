import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * F-083: `completeWithProviderFailover` used to declare `env?:` and fall back to
 * `process.env`, so a caller that omitted the option silently selected and paid
 * with the raw environment instead of the admin-settings overlay. The overlay
 * (`loadEffectiveProviderEnv`) exists precisely because an admin-UI-only
 * deployment has blank env slots — this is the bug class that once let a
 * deployment build but never plan.
 *
 * There is no `env` option any more. The helper loads the overlay from the
 * caller's `userId` and hands it to `run` as `ctx.env`, so "read raw
 * process.env" is not expressible at this boundary rather than merely unlikely.
 */

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

process.env.ENCRYPTION_KEY ||= ['plan', 'failover', 'fixture', 'material', 'over-32-bytes'].join(
  '-',
);

/** Reads as an admin credential and an admin model, both distinct from the env below. */
const ORG_KEY = ['overlay', 'org', 'credential'].join('-');
const OVERLAY_MODEL = ['overlay', 'model'].join('-');
const RAW_ENV_KEY = ['raw', 'env', 'credential'].join('-');
const RAW_ENV_MODEL = ['raw', 'env', 'model'].join('-');

const store = vi.hoisted(() => ({
  org: null as { id: string; secret: string } | null,
  settings: new Map<string, string>(),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    apiKey: { findFirst: async () => null },
    orgApiKey: { findFirst: async () => store.org },
    appSetting: {
      findUnique: async ({ where }: { where: { key: string } }) => {
        const value = store.settings.get(where.key);
        return value === undefined ? null : { value };
      },
      findMany: async () => [],
    },
  },
}));

vi.mock('@/lib/logger', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  logError: vi.fn(),
  formatLogLine: vi.fn(() => ''),
}));

// Dynamic on purpose: the vi.mock calls above must register before the module
// under test resolves the overlay it now loads for itself.
const { completeWithProviderFailover } = await import('@/lib/ai/plan-complete');
const { createCircuitBreaker } = await import('@/lib/ai/circuit');
const { classifyProviderFailure, jobErrorCodeForProviderFailure, providerFailureMessage } =
  await import('@/lib/ai/failover');
const { ProviderRunError } = await import('@/lib/ai/run');
const { recoveryCauseLine } = await import('@/lib/jobs/copy');
const { invalidateSettingsCache } = await import('@/lib/settings/resolve');

function storeAdminSetting(key: string, value: string) {
  store.settings.set(`setting:${key}`, JSON.stringify({ value, encrypted: false }));
  invalidateSettingsCache(key);
}

function httpError(status: number, message: string) {
  const error = new Error(message) as Error & { status: number };
  error.status = status;
  return error;
}

const deepseekQuota = httpError(
  429,
  'You exceeded your current quota. Please check your plan and billing details',
);

const samplePlan = {
  summary: 'A bakery site',
  pages: [{ name: 'Home', description: 'Landing' }],
  keyFeatures: ['Menu'],
};

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const name of ['DEEPSEEK_API_KEY', 'AI_PRIMARY_MODEL']) {
    savedEnv[name] = process.env[name];
  }
  // The raw store an omitted `env` used to reach. Nothing here may surface.
  process.env.DEEPSEEK_API_KEY = RAW_ENV_KEY;
  process.env.AI_PRIMARY_MODEL = RAW_ENV_MODEL;
  store.org = { id: 'org-deepseek', secret: ORG_KEY };
  store.settings.clear();
  invalidateSettingsCache();
  storeAdminSetting('ai.primaryModel', OVERLAY_MODEL);
});

afterEach(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  invalidateSettingsCache();
});

describe('the plan helper resolves its credentials through the admin overlay', () => {
  it('hands run the overlay env, not raw process.env', async () => {
    const seen: (string | undefined)[] = [];
    const result = await completeWithProviderFailover({
      userId: null,
      circuit: createCircuitBreaker(),
      run: async (_entry, ctx) => {
        seen.push(ctx.env.DEEPSEEK_API_KEY);
        return samplePlan;
      },
    });

    expect(seen).toEqual([ORG_KEY]);
    expect(seen).not.toContain(RAW_ENV_KEY);
    expect(result.result).toEqual(samplePlan);
  });

  it('selects the model the operator configured in Admin, not the environment', async () => {
    const result = await completeWithProviderFailover({
      userId: null,
      circuit: createCircuitBreaker(),
      run: async () => samplePlan,
    });

    expect(result.model).toBe(OVERLAY_MODEL);
    expect(result.model).not.toBe(RAW_ENV_MODEL);
  });

  it('still refuses when the overlay resolves no credential at all', async () => {
    store.org = null;
    delete process.env.DEEPSEEK_API_KEY;
    storeAdminSetting('ai.primaryModel', OVERLAY_MODEL);

    await expect(
      completeWithProviderFailover({
        userId: null,
        circuit: createCircuitBreaker(),
        run: async () => samplePlan,
      }),
    ).rejects.toThrow(/configuration|not configured|Admin/i);
  });
});

describe('plan path runs through the shared provider helper', () => {
  it('produces a plan from the single configured provider', async () => {
    const called: string[] = [];
    const result = await completeWithProviderFailover({
      userId: null,
      circuit: createCircuitBreaker(),
      run: async (entry) => {
        called.push(entry.provider);
        return samplePlan;
      },
    });

    expect(called).toEqual(['deepseek']);
    expect(result.provider).toBe('deepseek');
    expect(result.result).toEqual(samplePlan);
    expect(result.failedOver).toBe(false);
  });

  it('records quota exhaustion, not an unresponsive service, when the provider is out', async () => {
    try {
      await completeWithProviderFailover({
        userId: null,
        circuit: createCircuitBreaker(),
        run: async () => {
          throw deepseekQuota;
        },
      });
      expect.fail('expected ProviderRunError');
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderRunError);
      const cause = (error as InstanceType<typeof ProviderRunError>).causeError;
      expect(classifyProviderFailure(cause)).toBe('quota');
      expect(jobErrorCodeForProviderFailure(cause)).toBe('provider_quota_exhausted');
      const message = providerFailureMessage(cause);
      expect(message).toMatch(/quota/i);
      expect(message).toMatch(/plan and billing details/);
      expect(message.toLowerCase()).not.toMatch(/did not respond|is down/);
      expect(recoveryCauseLine('provider_quota_exhausted')).toMatch(/quota/i);
      expect(recoveryCauseLine('provider_quota_exhausted').toLowerCase()).not.toMatch(
        /did not respond|the last build/,
      );
    }
  });

  it('the plan module routes its AI call through the shared failover helper', () => {
    const source = readFileSync(path.join(ROOT, 'lib/projects/plan.ts'), 'utf8');
    expect(source).toMatch(/completeWithProviderFailover\(/);
    expect(source).toMatch(/jobErrorCodeForProviderFailure\(/);
    expect(source).not.toMatch(/errorCode:\s*['"]provider_error['"]/);
    // The helper owns the overlay now, so the plan module must not build one and
    // hand it in — that option is what F-083 made silently skippable.
    expect(source).not.toMatch(/loadEffectiveProviderEnv\(/);
  });

  it('leaves the helper no raw-environment fallback to express', () => {
    const source = readFileSync(path.join(ROOT, 'lib/ai/plan-complete.ts'), 'utf8');
    // Comments may still name the fallback they replaced; code may not carry it.
    const live = source
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
      .join('\n');
    expect(live).toMatch(/loadEffectiveProviderEnv\(/);
    expect(live).not.toMatch(/process\.env/);
    expect(live).not.toMatch(/\benv\?:/);
  });
});
