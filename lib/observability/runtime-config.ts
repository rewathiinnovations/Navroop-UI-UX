/**
 * GOVERNING RULE
 * A container filesystem is replaced on every deploy. A mounted volume survives
 * but is NOT backed up by DB backup and NOT replicated.
 *
 * Anything written to the volume must be reconstructible from Postgres or object storage.
 *
 * The volume is a cache and bootstrap shortcut, never the only copy. If the volume
 * were deleted entirely, the app must recover fully on the next boot with no data loss.
 * Violating this is a bug.
 *
 * This file is rebuilt from the Sentry Integration row. Never write file → DB.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { getDataDir } from '../runtime/data-dir';
import { log } from '../logger';

export type ObservabilityRuntimeConfig = {
  enabled: boolean;
  dsn: string;
  projectId: string;
  environment: string;
  tracesSampleRate: number;
  sessionReplay: boolean;
  performance: boolean;
  ignoreList: string[];
  fingerprintLimit: number;
  fingerprintWindowSec: number;
  orgSlug?: string;
  projectSlug?: string;
  region?: string;
};

const UNWRITABLE_MESSAGE =
  'Observability config path is not writable. Mount a volume at DATA_DIR (default /data) so /data/config/observability.json can be written.';

let bootRead: RuntimeConfigRead | null = null;

export function runtimeConfigPath() {
  const fromEnv = process.env.OBSERVABILITY_CONFIG_PATH?.trim();
  if (fromEnv) return fromEnv;
  return join(getDataDir(), 'config', 'observability.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asBoolean(value: unknown, fallback: boolean) {
  return typeof value === 'boolean' ? value : fallback;
}

function asStringList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function normalize(raw: unknown): ObservabilityRuntimeConfig | null {
  if (!isRecord(raw)) return null;
  const dsn = asString(raw.dsn).trim();
  const projectId = asString(raw.projectId).trim() || asString(raw.project_id).trim();
  return {
    enabled: asBoolean(raw.enabled, Boolean(dsn)),
    dsn,
    projectId,
    environment: asString(raw.environment).trim() || 'development',
    tracesSampleRate: Math.min(1, Math.max(0, asNumber(raw.tracesSampleRate, 0.1))),
    sessionReplay: asBoolean(raw.sessionReplay, false),
    performance: asBoolean(raw.performance, true),
    ignoreList: asStringList(raw.ignoreList),
    fingerprintLimit: Math.max(1, Math.floor(asNumber(raw.fingerprintLimit, 10))),
    fingerprintWindowSec: Math.max(1, Math.floor(asNumber(raw.fingerprintWindowSec, 300))),
    orgSlug: asString(raw.orgSlug).trim() || undefined,
    projectSlug: asString(raw.projectSlug).trim() || undefined,
    region: asString(raw.region).trim() || undefined,
  };
}

/**
 * Three answers, not two: the file is there, the file is absent, or the file could not be
 * read. A blanket `catch { return null }` reported an EACCES, a truncated write and
 * malformed JSON as "Sentry was never connected" — `buildSentryInitOptions` then returned
 * null, `Sentry.init` was never called, and nothing said so (F-738).
 */
export type RuntimeConfigRead =
  | { state: 'ok'; config: ObservabilityRuntimeConfig }
  | { state: 'absent' }
  | { state: 'unreadable'; message: string; code?: string };

let lastReportedReadError = '';

export function readRuntimeConfigState(): RuntimeConfigRead {
  const path = runtimeConfigPath();
  let text: string;
  try {
    if (!existsSync(path)) return { state: 'absent' };
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return reportUnreadable(path, error);
  }
  try {
    const config = normalize(JSON.parse(text));
    if (!config) return reportUnreadable(path, new Error('config file is not a JSON object'));
    lastReportedReadError = '';
    return { state: 'ok', config };
  } catch (error) {
    return reportUnreadable(path, error);
  }
}

function reportUnreadable(path: string, error: unknown): RuntimeConfigRead {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : undefined;
  // `readRuntimeConfig` is called on every `sentryDsn()`, so the line is emitted once per
  // distinct failure rather than per call. `log.error`, never `logError`: capturing this to
  // Sentry would need the very config that could not be read.
  if (message !== lastReportedReadError) {
    lastReportedReadError = message;
    log.error('observability.runtime_config_unreadable', { path, code, error: message });
  }
  return { state: 'unreadable', message, code };
}

/** Synchronous. Returns null if the file is absent or unreadable. Never throws. */
export function readRuntimeConfig(): ObservabilityRuntimeConfig | null {
  const read = readRuntimeConfigState();
  return read.state === 'ok' ? read.config : null;
}

export function writeRuntimeConfig(config: ObservabilityRuntimeConfig) {
  const path = runtimeConfigPath();
  const payload: ObservabilityRuntimeConfig = {
    enabled: Boolean(config.enabled && config.dsn),
    dsn: config.dsn,
    projectId: config.projectId,
    environment: config.environment,
    tracesSampleRate: config.tracesSampleRate,
    sessionReplay: config.sessionReplay,
    performance: config.performance,
    ignoreList: config.ignoreList ?? [],
    fingerprintLimit: config.fingerprintLimit,
    fingerprintWindowSec: config.fingerprintWindowSec,
    orgSlug: config.orgSlug,
    projectSlug: config.projectSlug,
    region: config.region,
  };
  const dir = dirname(path);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    // The errno is the whole diagnosis — EACCES is a permission fix, ENOSPC is a full
    // volume, EROFS is a read-only mount — and the generic message discarded it (F-738).
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(`${UNWRITABLE_MESSAGE} Path: ${path}. Cause: ${cause}`, { cause: error });
  }
}

export function disableRuntimeConfig() {
  writeRuntimeConfig({
    enabled: false,
    dsn: '',
    projectId: '',
    environment: process.env.NODE_ENV || 'development',
    tracesSampleRate: 0.1,
    sessionReplay: false,
    performance: false,
    ignoreList: [],
    fingerprintLimit: 10,
    fingerprintWindowSec: 300,
  });
}

/**
 * The boot read is captured once because it decides, for the life of the process, whether
 * `Sentry.init` ran. It keeps the whole three-state answer: "the file could not be read"
 * is the state a caller has to be able to report, and collapsing it to `null` is what let
 * an EACCES read as "Sentry was never connected" (F-738).
 */
export function captureBootRuntimeConfigState(): RuntimeConfigRead {
  if (!bootRead) bootRead = readRuntimeConfigState();
  return bootRead;
}

export function captureBootRuntimeConfig() {
  const read = captureBootRuntimeConfigState();
  return read.state === 'ok' ? read.config : null;
}

export function getBootRuntimeConfigState() {
  return bootRead;
}

export function getBootRuntimeConfig() {
  return bootRead?.state === 'ok' ? bootRead.config : null;
}

export function resetRuntimeConfigForTests() {
  bootRead = null;
  lastReportedReadError = '';
}

export function runtimeConfigDiffers(
  file: ObservabilityRuntimeConfig | null,
  next: ObservabilityRuntimeConfig | null,
) {
  if (!file && !next) return false;
  if (!file || !next) return true;
  return (
    file.enabled !== next.enabled ||
    file.dsn !== next.dsn ||
    file.projectId !== next.projectId ||
    file.environment !== next.environment ||
    file.tracesSampleRate !== next.tracesSampleRate ||
    file.sessionReplay !== next.sessionReplay ||
    file.performance !== next.performance ||
    file.fingerprintLimit !== next.fingerprintLimit ||
    file.fingerprintWindowSec !== next.fingerprintWindowSec ||
    file.orgSlug !== next.orgSlug ||
    file.projectSlug !== next.projectSlug ||
    // `writeRuntimeConfig` persists the region, so leaving it out of the comparison meant
    // an org moved to another Sentry region kept the stale value forever and every API
    // call kept going to the wrong host (F-738).
    file.region !== next.region ||
    JSON.stringify(file.ignoreList) !== JSON.stringify(next.ignoreList)
  );
}
