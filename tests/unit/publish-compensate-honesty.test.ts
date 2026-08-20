import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What a publish rollback is allowed to claim it removed.
 *
 * `compensateJobResources` wraps each provider delete in `try { … } catch { logError(…) }`
 * and then returned `rolledBack: true` unconditionally — the flag was derived from
 * "we decided to roll back", not from "we did". `compensate-publish` turned that into
 * `compensation: 'rolled_back'`, the recovery panel rendered "Incomplete work was cleaned
 * up", and the marker made the whole function single-shot, so the abandoned Coolify app and
 * DNS record stayed up and billing with the product reporting them gone (F-046).
 *
 * Goes red if a teardown that failed is ever counted as done, or if a partial rollback
 * becomes unretryable.
 */

const logger = vi.hoisted(() => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
  logError: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({ log: logger.log, logError: logger.logError }));
vi.mock('@/lib/db', () => ({ prisma: { coolifyServer: { findUnique: vi.fn() } } }));
vi.mock('@/lib/cloudflare/dns', () => ({ deleteRecord: vi.fn() }));
vi.mock('@/lib/coolify/client', () => ({ deleteApplication: vi.fn(), getCoolifyClient: vi.fn() }));
vi.mock('@/lib/coolify/servers', () => ({ serverAuth: vi.fn() }));
vi.mock('@/lib/github/deploy-client', () => ({ archiveDeployRepo: vi.fn() }));

// Dynamic: compensate.ts reaches Coolify, Cloudflare and GitHub at import time, so it may
// only be evaluated once the factories above are registered.
const { compensateJobResources } = await import('@/lib/jobs/compensate');

const RESOURCES = {
  coolifyAppUuid: 'app-1',
  dnsRecordId: 'dns-1',
  githubRepo: 'deploy-org/acme',
};

function adapters(
  overrides: Partial<Record<'coolify' | 'dns' | 'repo', () => Promise<void>>> = {},
) {
  return {
    deleteCoolifyApp: overrides.coolify ?? vi.fn(async () => undefined),
    deleteDnsRecord: overrides.dns ?? vi.fn(async () => undefined),
    archiveDeployRepo: overrides.repo ?? vi.fn(async () => undefined),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('compensateJobResources', () => {
  it('reports rolled_back only when every teardown actually succeeded', async () => {
    const result = await compensateJobResources({
      resources: RESOURCES,
      hadSuccessfulDeployment: false,
      adapters: adapters(),
    });

    expect(result.outcome).toBe('rolled_back');
    expect(result.compensated).toEqual(['coolify', 'dns', 'repo']);
    expect(result.failed).toEqual([]);
  });

  it('reports partial — not rolled_back — when a teardown throws', async () => {
    const result = await compensateJobResources({
      resources: RESOURCES,
      hadSuccessfulDeployment: false,
      adapters: adapters({
        coolify: vi.fn(async () => {
          throw new Error('Coolify 502 /applications');
        }),
      }),
    });

    expect(result.outcome).toBe('partial');
    // The app is still running, so it must not appear as compensated — the ids stay on the
    // job for the orphan cron, which only deletes what this system recorded creating.
    expect(result.compensated).toEqual(['dns', 'repo']);
    expect(result.failed).toEqual(['coolify']);
  });

  it('reports partial when every teardown fails', async () => {
    const boom = () => {
      throw new Error('provider down');
    };
    const result = await compensateJobResources({
      resources: RESOURCES,
      hadSuccessfulDeployment: false,
      adapters: adapters({
        coolify: vi.fn(async () => boom()),
        dns: vi.fn(async () => boom()),
        repo: vi.fn(async () => boom()),
      }),
    });

    expect(result.outcome).toBe('partial');
    expect(result.compensated).toEqual([]);
    expect(result.failed).toEqual(['coolify', 'dns', 'repo']);
  });

  it('counts an adapter that declined as a failure, not as a teardown', async () => {
    // `false` is "the app was left running" — configured away, or no client. That is the
    // same user-visible state as a 502: something is still up.
    const result = await compensateJobResources({
      resources: RESOURCES,
      hadSuccessfulDeployment: false,
      adapters: {
        deleteCoolifyApp: vi.fn(async () => false),
        deleteDnsRecord: vi.fn(async () => undefined),
        archiveDeployRepo: vi.fn(async () => undefined),
      },
    });

    expect(result.outcome).toBe('partial');
    expect(result.failed).toEqual(['coolify']);
  });

  it('treats an already-absent resource as torn down', async () => {
    const gone = Object.assign(new Error('Not Found'), { status: 404 });
    const result = await compensateJobResources({
      resources: RESOURCES,
      hadSuccessfulDeployment: false,
      adapters: adapters({
        dns: vi.fn(async () => {
          throw gone;
        }),
      }),
    });

    expect(result.outcome).toBe('rolled_back');
    expect(result.compensated).toEqual(['coolify', 'dns', 'repo']);
  });

  it('rolls nothing back for a re-publish and says so', async () => {
    const spies = adapters();
    const result = await compensateJobResources({
      resources: RESOURCES,
      hadSuccessfulDeployment: true,
      preexisting: RESOURCES,
      adapters: spies,
    });

    expect(result).toEqual({ outcome: 'kept_live', compensated: [], failed: [] });
    expect(spies.deleteCoolifyApp).not.toHaveBeenCalled();
  });

  it('is rolled_back when the job created nothing to remove', async () => {
    const result = await compensateJobResources({
      resources: {},
      hadSuccessfulDeployment: false,
      adapters: adapters(),
    });

    expect(result).toEqual({ outcome: 'rolled_back', compensated: [], failed: [] });
  });
});
