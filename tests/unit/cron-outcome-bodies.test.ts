import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The two cron bodies that aggregate per-item results into counters, held to the contract in
 * `lib/cron/record.ts`.
 *
 * `withCronRun` used to record success for any returned value without a literal `ok: false`, so
 * `check-integrations` answered HTTP 200 and wrote `CronRun{ok: true}` with GitHub, Cloudflare,
 * Coolify and Sentry all returning 401 — the only signal was an in-app banner someone had to be
 * looking at. `CronOutcome` makes an outcome-less body a compile error, but it cannot make a
 * body's `ok` *correct*: these tests hold the two computations that are easiest to get wrong,
 * from opposite directions.
 *
 * `check-domains` is the opposite trap. A customer domain whose verification came back FAILED is
 * a customer who has not pointed their DNS at us yet; that is the normal state for days, it is
 * shown on their own domain card, and failing the cron for it would leave /admin/health
 * permanently red for something no operator can fix — the same alert fatigue in a different
 * costume. Only a check that *threw* is ours.
 */

const db = vi.hoisted(() => ({
  integrationUpdate: vi.fn(),
  appSettingUpsert: vi.fn(),
  appSettingDeleteMany: vi.fn(),
}));
const store = vi.hoisted(() => ({ getIntegration: vi.fn() }));
const github = vi.hoisted(() => ({ getInstallationToken: vi.fn() }));
const sentry = vi.hoisted(() => ({ checkSentryHealth: vi.fn() }));
const domains = vi.hoisted(() => ({ list: vi.fn(), checkDomain: vi.fn() }));

vi.mock('@/lib/db', () => ({
  prisma: {
    integration: { update: db.integrationUpdate },
    appSetting: { upsert: db.appSettingUpsert, deleteMany: db.appSettingDeleteMany },
  },
}));
vi.mock('@/lib/integrations/store', () => ({
  getIntegration: store.getIntegration,
  invalidateIntegrationCache: () => undefined,
}));
vi.mock('@/lib/github/deploy-client', () => ({
  getInstallationToken: github.getInstallationToken,
}));
vi.mock('@/lib/integrations/sentry-health', () => ({
  checkSentryHealth: sentry.checkSentryHealth,
}));
vi.mock('@/lib/observability/track', () => ({
  trackStart: () => undefined,
  trackSuccess: () => undefined,
  trackFailure: () => undefined,
}));
vi.mock('@/lib/logger', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  logError: vi.fn(),
}));
vi.mock('@/lib/domains/store', () => ({ listCheckableCustomDomains: domains.list }));
vi.mock('@/lib/domains/verify', () => ({ checkDomain: domains.checkDomain }));

// Dynamic so the factories above are installed first; a static import would be hoisted past
// them and reach the real Cloudflare, GitHub and Sentry endpoints.
const { checkAllIntegrations } = await import('@/lib/integrations/health');
const { checkDueCustomDomains } = await import('@/lib/domains/cron');

const NOW = new Date('2026-08-19T12:00:00.000Z');
/** Old enough that `shouldCheckDomain` is due on every row regardless of backoff. */
const CREATED = new Date('2026-08-01T12:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
  db.integrationUpdate.mockResolvedValue({});
  db.appSettingUpsert.mockResolvedValue({});
  db.appSettingDeleteMany.mockResolvedValue({ count: 0 });
  github.getInstallationToken.mockRejectedValue(new Error('GitHub 401'));
  sentry.checkSentryHealth.mockRejectedValue(new Error('Sentry 401'));
  // CONNECTED but with no usable secret, so the Cloudflare and Coolify checks fail before any
  // network call.
  store.getIntegration.mockResolvedValue({ status: 'CONNECTED', secrets: {}, config: {} });
  domains.list.mockResolvedValue([]);
});

describe('check-integrations', () => {
  it('does not record a healthy run when every provider check failed', async () => {
    const result = await checkAllIntegrations();

    expect(result.failures).toHaveLength(4);
    expect(result.ok).toBe(false);
    // The digest line and the /admin/health row are this string, so it has to name providers.
    expect(result.detail).toContain('GITHUB_DEPLOY');
    expect(result.detail).toContain('CLOUDFLARE');
    expect(result.detail).toContain('SENTRY');
    // And the banner is raised for the in-app surface, as before.
    expect(db.appSettingUpsert).toHaveBeenCalled();
  });

  it('does not fail the run for an integration the operator never connected', async () => {
    // A deploy that does not use Sentry or Cloudflare must not read red forever.
    store.getIntegration.mockResolvedValue(null);

    const result = await checkAllIntegrations();

    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });
});

describe('check-domains', () => {
  it('does not record a healthy run when a check could not be made', async () => {
    domains.list.mockResolvedValue([
      { id: 'dom_a', createdAt: CREATED, lastCheckedAt: null },
      { id: 'dom_b', createdAt: CREATED, lastCheckedAt: null },
    ]);
    domains.checkDomain.mockImplementation(async (id: string) => {
      if (id === 'dom_a') throw new Error('EAI_AGAIN api.cloudflare.com');
      return { status: 'VERIFIED' };
    });

    const result = await checkDueCustomDomains(NOW);

    expect(result.ok).toBe(false);
    expect(result.checked).toBe(1);
    expect(result.detail).toContain('dom_a');
    expect(result.detail).toContain('EAI_AGAIN');
  });

  it('stays healthy when a customer has simply not pointed their DNS at us yet', async () => {
    domains.list.mockResolvedValue([
      { id: 'dom_waiting', createdAt: CREATED, lastCheckedAt: null },
    ]);
    domains.checkDomain.mockResolvedValue({ status: 'FAILED' });

    const result = await checkDueCustomDomains(NOW);

    expect(result).toMatchObject({ ok: true, detail: null, checked: 1, failed: 1 });
  });
});
