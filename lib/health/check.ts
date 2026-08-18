import { readRuntimeConfig } from '../observability/runtime-config';
import { getDataDirStatus, type DataDirStatus } from '../runtime/data-dir';
import { sentryDsn, sentryEnvironment } from '../sentry/options';

export type HealthCheckName = 'db' | 'storage';
export type HealthCheckStatus = 'ok' | 'fail';

export type HealthObservabilityFile = {
  present: boolean;
  projectId: string | null;
  matchesIntegration: boolean | null;
};

/**
 * Three distinct answers, not two. `not_checked` means the boot probe has not run in
 * this process — it is not evidence of a missing volume, and reading it as one sends an
 * operator after the wrong incident.
 */
export type DataDirState = 'ok' | 'not_checked' | 'unwritable';

export type HealthDataDir = DataDirStatus & {
  state: DataDirState;
  message: string;
};

export function describeDataDir(status: DataDirStatus): HealthDataDir {
  if (!status.checked) {
    return {
      ...status,
      state: 'not_checked',
      message: `The data directory has not been checked yet, so we do not know whether ${status.path} is writable. The boot probe has not run in this process. This is not a failure.`,
    };
  }
  if (!status.writable) {
    return {
      ...status,
      state: 'unwritable',
      message: status.error ?? `The data directory is not writable: ${status.path}.`,
    };
  }
  return {
    ...status,
    state: 'ok',
    message: `The data directory is mounted and writable: ${status.path}.`,
  };
}

export type HealthResult = {
  ok: boolean;
  checks: Record<HealthCheckName, HealthCheckStatus>;
  version: string;
  uptime: number;
  sentry: {
    dsnConfigured: boolean;
    releaseSha: string;
    environment: string;
  };
  dataDir: HealthDataDir;
  observabilityFile: HealthObservabilityFile;
};

export type HealthDeps = {
  db: { $queryRaw: (query: TemplateStringsArray, ...args: unknown[]) => Promise<unknown> };
  storageHead: () => Promise<boolean>;
  now?: number;
  startedAt?: number;
  version?: string;
  sentryDsnConfigured?: boolean;
  releaseSha?: string;
  sentryEnvironment?: string;
  dataDir?: DataDirStatus;
  observabilityFile?: HealthObservabilityFile;
};

const startedAt = Date.now();

export async function runHealthChecks(deps: HealthDeps): Promise<HealthResult> {
  const checks: Record<HealthCheckName, HealthCheckStatus> = { db: 'fail', storage: 'fail' };

  try {
    await deps.db.$queryRaw`SELECT 1`;
    checks.db = 'ok';
  } catch {
    checks.db = 'fail';
  }

  try {
    await deps.storageHead();
    checks.storage = 'ok';
  } catch {
    checks.storage = 'fail';
  }

  const runtime = readRuntimeConfig();
  return {
    ok: checks.db === 'ok' && checks.storage === 'ok',
    checks,
    version: deps.version ?? process.env.npm_package_version ?? '0.1.0',
    uptime: Math.max(0, Math.floor(((deps.now ?? Date.now()) - (deps.startedAt ?? startedAt)) / 1000)),
    sentry: {
      dsnConfigured: deps.sentryDsnConfigured ?? Boolean(sentryDsn()),
      releaseSha: deps.releaseSha ?? (process.env.GIT_SHA || process.env.SOURCE_COMMIT || 'unknown'),
      environment: deps.sentryEnvironment ?? sentryEnvironment(),
    },
    dataDir: describeDataDir(deps.dataDir ?? getDataDirStatus()),
    observabilityFile: deps.observabilityFile ?? {
      present: Boolean(runtime),
      projectId: runtime?.projectId ?? null,
      matchesIntegration: null,
    },
  };
}
