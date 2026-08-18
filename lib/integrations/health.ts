import { prisma } from '@/lib/db';
import { DEFAULT_WORKSPACE_ID } from '@/lib/publish/constants';
import { getInstallationToken } from '@/lib/github/deploy-client';
import type { IntegrationKind } from './types';
import { getIntegration, invalidateIntegrationCache } from './store';
import { log } from '@/lib/logger';
import { trackFailure, trackStart, trackSuccess } from '@/lib/observability/track';

const ALERT_KEY = 'integrations.health.alert';

async function githubCheck(workspaceId: string) {
  const token = await getInstallationToken(workspaceId);
  // Trusted host — do not route through safeFetch.
  const response = await fetch('https://api.github.com/installation/repositories?per_page=1', {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`GitHub ${response.status}`);
  }
}

async function cloudflareCheck(workspaceId: string) {
  const row = await getIntegration(workspaceId, 'CLOUDFLARE');
  const token = row?.secrets.token;
  if (!token) throw new Error('Cloudflare token missing');
  // Trusted host — do not route through safeFetch.
  const response = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await response.json().catch(() => null)) as { success?: boolean; errors?: Array<{ message?: string }> } | null;
  if (!response.ok || body?.success === false) {
    throw new Error(body?.errors?.[0]?.message || `Cloudflare ${response.status}`);
  }
}

async function coolifyCheck(workspaceId: string) {
  const row = await getIntegration(workspaceId, 'COOLIFY');
  const token = row?.secrets.token;
  const base = row?.config.baseUrl?.replace(/\/+$/, '');
  if (!token || !base) throw new Error('Coolify token missing');
  // Trusted host — do not route through safeFetch.
  const response = await fetch(`${base}/api/v1/servers`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Coolify ${response.status}`);
}

async function sentryCheck(workspaceId: string) {
  const { checkSentryHealth } = await import('./sentry-health');
  await checkSentryHealth(workspaceId);
}

const CHECKS: Record<IntegrationKind, (workspaceId: string) => Promise<void>> = {
  GITHUB_DEPLOY: githubCheck,
  CLOUDFLARE: cloudflareCheck,
  COOLIFY: coolifyCheck,
  SENTRY: sentryCheck,
};

export async function checkIntegration(kind: IntegrationKind, workspaceId = DEFAULT_WORKSPACE_ID) {
  const startedAt = Date.now();
  trackStart('integrations.health', { action: 'integrations', workspaceId });
  const row = await getIntegration(workspaceId, kind);
  if (!row || row.status === 'DISCONNECTED') {
    log.info('integrations.health.skip', { kind, reason: 'disconnected' });
    return { ok: false as const, error: 'Not connected', kind };
  }
  try {
    await CHECKS[kind](workspaceId);
    const limited = kind === 'SENTRY' && !row.secrets.authToken?.trim();
    await prisma.integration.update({
      where: { workspaceId_kind: { workspaceId, kind: kind as 'GITHUB_DEPLOY' | 'CLOUDFLARE' | 'COOLIFY' } },
      data: {
        lastCheckedAt: new Date(),
        lastError: limited ? 'Connected — limited. Add an auth token to enable quota monitoring.' : null,
        status: row.status === 'ERROR' ? 'CONNECTED' : row.status,
      },
    });
    invalidateIntegrationCache(workspaceId, kind);
    trackSuccess('integrations.health.ok', { action: 'integrations', workspaceId, durationMs: Date.now() - startedAt });
    return { ok: true as const, kind };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Check failed';
    trackFailure('integrations.health.fail', error, { action: 'integrations', workspaceId, durationMs: Date.now() - startedAt });
    await prisma.integration.update({
      where: { workspaceId_kind: { workspaceId, kind: kind as 'GITHUB_DEPLOY' | 'CLOUDFLARE' | 'COOLIFY' } },
      data: { lastCheckedAt: new Date(), lastError: message, status: 'ERROR' },
    });
    invalidateIntegrationCache(workspaceId, kind);
    return { ok: false as const, error: message, kind };
  }
}

export async function checkAllIntegrations(workspaceId = DEFAULT_WORKSPACE_ID) {
  const kinds: IntegrationKind[] = ['GITHUB_DEPLOY', 'CLOUDFLARE', 'COOLIFY', 'SENTRY'];
  const results = [];
  for (const kind of kinds) {
    results.push(await checkIntegration(kind, workspaceId));
  }
  const failures = results.filter((row) => !row.ok && row.error !== 'Not connected');
  if (failures.length > 0) {
    await prisma.appSetting.upsert({
      where: { key: ALERT_KEY },
      create: {
        key: ALERT_KEY,
        value: JSON.stringify({
          at: new Date().toISOString(),
          failures: failures.map((row) => ({ kind: row.kind, error: row.error })),
        }),
      },
      update: {
        value: JSON.stringify({
          at: new Date().toISOString(),
          failures: failures.map((row) => ({ kind: row.kind, error: row.error })),
        }),
      },
    });
    return { results, failures, alertCleared: false as const };
  }

  // deleteMany, not delete: there is usually no alert row to clear, and that must not read
  // as an error. A genuine failure leaves a stale "integrations are failing" banner on an
  // otherwise healthy system, so it is logged rather than swallowed.
  try {
    await prisma.appSetting.deleteMany({ where: { key: ALERT_KEY } });
    return { results, failures, alertCleared: true as const };
  } catch (error) {
    log.error('integrations.health.alert_clear_failed', {
      message: 'The integrations health alert row could not be cleared, so the banner will stay up.',
      error: error instanceof Error ? error.message : String(error),
    });
    return { results, failures, alertCleared: false as const };
  }
}

export async function getIntegrationHealthAlert() {
  const row = await prisma.appSetting.findUnique({ where: { key: ALERT_KEY } });
  if (!row) return null;
  try {
    return JSON.parse(row.value) as {
      at: string;
      failures: Array<{ kind: IntegrationKind; error: string }>;
    };
  } catch {
    return null;
  }
}
