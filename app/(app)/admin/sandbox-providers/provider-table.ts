import { TEST_PROVIDER_LABEL, type DriverCapabilities } from '@/lib/sandbox/provider';

/**
 * Serialisable admin payload owned by this client-safe module.
 * Do not import `load-admin` (or any Prisma module) for this type.
 * `monthsRemaining` is `number | null` — never `Infinity` — so RSC hydration stays JSON-safe.
 */
export type SandboxProvidersAdminProvider = {
  id: string;
  creditType: string;
  monthsRemaining: number | null;
};

export type SandboxProvidersAdminCapability = DriverCapabilities & {
  driver: string;
};

export type SandboxProvidersAdminPayload = {
  providers: SandboxProvidersAdminProvider[];
  strategy: string;
  nextPickReason: string | null;
  strategies: Array<{ id: string; help: string; selected: boolean }>;
  capabilities: SandboxProvidersAdminCapability[];
  labels: {
    addProvider: string;
    test: string;
    freeFirst: string;
    lastActive: string;
    defaultOrder: string;
  };
};

export type PublicProviderRow = {
  id: string;
  name: string;
  driver: string;
  isActive: boolean;
  creditType: string;
  creditLabel: string;
  creditTotalUsd: number | null;
  creditRemainingUsd: number | null;
  healthStatus: string;
  health: string;
  lastError: string | null;
  secretLabel: string;
  monthsRemaining: number | null;
  monthsLabel: string;
  usagePercent: number;
  testLabel: string;
};

export function healthLabel(status: string | null | undefined): string {
  const value = (status || '').trim() || 'unknown';
  if (value === 'unknown') return 'unknown — not checked yet';
  if (value === 'healthy') return 'healthy — create, echo, and shutdown succeeded';
  if (value === 'degraded') return 'degraded — last create/echo/shutdown failed';
  if (value === 'down') return 'down — circuit open after 3 failures';
  return value;
}

export function creditTypeLabel(creditType: unknown): string {
  if (typeof creditType !== 'string' || !creditType) return '';
  return creditType.replaceAll('_', ' ');
}

export function maskedSecretLabel(secretsMasked: unknown): string {
  if (!secretsMasked || typeof secretsMasked !== 'object') return '••••';
  const record = secretsMasked as Record<string, unknown>;
  const apiKey = typeof record.apiKey === 'string' ? record.apiKey : '';
  const tokenId = typeof record.tokenId === 'string' ? record.tokenId : '';
  return apiKey || tokenId || '••••';
}

export function usageBarPercent(total: unknown, remaining: unknown): number {
  const creditTotal = typeof total === 'number' && Number.isFinite(total) ? total : 0;
  if (creditTotal <= 0) return 0;
  const left = typeof remaining === 'number' && Number.isFinite(remaining) ? remaining : 0;
  return Math.min(100, Math.max(0, ((creditTotal - left) / creditTotal) * 100));
}

function monthsLabel(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  return `${value.toFixed(1)} months at 30-day burn`;
}

function asProvider(row: unknown): PublicProviderRow | null {
  if (!row || typeof row !== 'object') return null;
  const record = row as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id : '';
  const name = typeof record.name === 'string' ? record.name : '';
  if (!id || !name) return null;
  const creditType = typeof record.creditType === 'string' ? record.creditType : '';
  const monthsRemaining =
    typeof record.monthsRemaining === 'number' && Number.isFinite(record.monthsRemaining)
      ? record.monthsRemaining
      : null;
  return {
    id,
    name,
    driver: typeof record.driver === 'string' ? record.driver : '',
    isActive: record.isActive === true,
    creditType,
    creditLabel: creditTypeLabel(creditType),
    creditTotalUsd: typeof record.creditTotalUsd === 'number' ? record.creditTotalUsd : null,
    creditRemainingUsd: typeof record.creditRemainingUsd === 'number' ? record.creditRemainingUsd : null,
    healthStatus: typeof record.healthStatus === 'string' ? record.healthStatus : 'unknown',
    health: healthLabel(typeof record.healthStatus === 'string' ? record.healthStatus : 'unknown'),
    lastError: typeof record.lastError === 'string' && record.lastError ? record.lastError : null,
    secretLabel: maskedSecretLabel(record.secretsMasked),
    monthsRemaining,
    monthsLabel: monthsLabel(record.monthsRemaining),
    usagePercent: usageBarPercent(record.creditTotalUsd, record.creditRemainingUsd),
    testLabel: TEST_PROVIDER_LABEL,
  };
}

export function providersFromPayload(payload: unknown): PublicProviderRow[] {
  if (!payload || typeof payload !== 'object') return [];
  const providers = (payload as { providers?: unknown }).providers;
  if (!Array.isArray(providers)) return [];
  return providers.map(asProvider).filter((row): row is PublicProviderRow => row !== null);
}

export function readApiError(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== 'object' || !('error' in payload)) return fallback;
  const error = (payload as { error: unknown }).error;
  if (typeof error === 'string' && error) return error;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  return fallback;
}
