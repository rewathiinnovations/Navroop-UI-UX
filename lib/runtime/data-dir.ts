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
 * Allowed: observability.json (rebuilt from Integration), cache (tokens / health /
 * thumbnail derivatives), tmp (deleted after use).
 * Never the only copy of checkpoints, generated images, DB backups, integration
 * secrets, user uploads, sessions, or encryption keys.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { userInfo as osUserInfo } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const DEFAULT_DATA_DIR = '/data';
export const VOLUME_ID_FILENAME = '.volume-id';
export const VOLUME_ID_SETTING_KEY = 'runtime.volumeId';
export const VOLUME_LOW_SPACE_ALERT_KEY = 'runtime.volumeLowSpaceAlerted';
export const LARGE_OP_MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;
export const FREE_SPACE_WARN_RATIO = 0.2;
export const FREE_SPACE_ALERT_RATIO = 0.1;
export const TMP_MAX_AGE_MS = 60 * 60 * 1000;

export type VolumeIdFile = {
  id: string;
  createdAt: string;
};

export type DataDirStatus = {
  /**
   * False until the boot probe has run in this process. "Not checked yet" is not a
   * failure and must never be reported as a missing volume — `writable` stays false
   * only because nothing has been attempted.
   */
  checked: boolean;
  path: string;
  writable: boolean;
  error: string | null;
  volumeId: string | null;
  volumeCreatedAt: string | null;
  volumeChanged: boolean;
  previousVolumeId: string | null;
  freeBytes: number | null;
  totalBytes: number | null;
  freeRatio: number | null;
  warnLowSpace: boolean;
  alertLowSpace: boolean;
};

export type DataDirDisk = {
  freeBytes: number;
  totalBytes: number;
};

export type EnsureDataDirDeps = {
  root?: string;
  now?: Date;
  probeWrite?: (path: string) => void;
  disk?: DataDirDisk | null;
  userInfo?: { uid?: number; username?: string };
  logError?: (message: string) => void;
  previousVolumeId?: string | null;
};

export type PersistVolumeIdentityDeps = {
  getPrevious?: () => Promise<string | null>;
  setPrevious?: (id: string) => Promise<void>;
  status?: DataDirStatus;
  warn?: (message: string) => void;
};

type CacheRecord = Record<string, unknown>;

let lastStatus: DataDirStatus | null = null;

export function getDataDir() {
  const fromEnv = process.env.DATA_DIR?.trim();
  if (fromEnv) return fromEnv;
  if (process.env.NODE_ENV === 'production') return DEFAULT_DATA_DIR;
  return join(process.cwd(), '.data');
}

export function configDir(root = getDataDir()) {
  return join(root, 'config');
}

export function cacheDir(root = getDataDir()) {
  return join(root, 'cache');
}

export function tmpDir(root = getDataDir()) {
  return join(root, 'tmp');
}

export function volumeIdPath(root = getDataDir()) {
  return join(root, VOLUME_ID_FILENAME);
}

export function cachePath(...parts: string[]) {
  return join(cacheDir(), ...parts);
}

export function getDataDirStatus(): DataDirStatus {
  return lastStatus ?? unprobedStatus(getDataDir());
}

/** No probe has run, so there is nothing to report — and no error to claim. */
function unprobedStatus(path: string): DataDirStatus {
  return emptyStatus(path, null, { checked: false });
}

export function resetDataDirForTests() {
  lastStatus = null;
}

function emptyStatus(path: string, error: string | null, extra: Partial<DataDirStatus> = {}): DataDirStatus {
  return {
    checked: true,
    path,
    writable: false,
    error,
    volumeId: null,
    volumeCreatedAt: null,
    volumeChanged: false,
    previousVolumeId: extra.previousVolumeId ?? null,
    freeBytes: extra.freeBytes ?? null,
    totalBytes: extra.totalBytes ?? null,
    freeRatio: extra.freeRatio ?? null,
    warnLowSpace: extra.warnLowSpace ?? false,
    alertLowSpace: extra.alertLowSpace ?? false,
    ...extra,
  };
}

function currentUser(override?: { uid?: number; username?: string }) {
  if (override) return override;
  try {
    const info = osUserInfo();
    return { uid: info.uid, username: info.username };
  } catch {
    return { uid: undefined, username: undefined };
  }
}

function describeUnwritable(
  path: string,
  error: unknown,
  user: { uid?: number; username?: string },
) {
  const code =
    error && typeof error === 'object' && 'code' in error ? String((error as { code?: string }).code) : '';
  const who =
    user.uid != null && user.uid >= 0
      ? `non-root user (uid ${user.uid}${user.username ? ` / ${user.username}` : ''})`
      : user.username
        ? `non-root user (${user.username})`
        : 'non-root user';
  if (code === 'EACCES' || code === 'EPERM') {
    return `The data directory is not writable: ${path}. Likely cause: wrong ownership for the ${who}. The volume may be owned by root.`;
  }
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return `The data directory is not writable: ${path}. Likely cause: the volume is not mounted. Path: ${path}`;
  }
  return `The data directory is not writable: ${path}. Likely cause: the volume is not mounted, or wrong ownership for the ${who}.`;
}

function defaultProbeWrite(dir: string) {
  const probe = join(dir, `.write-probe-${process.pid}`);
  writeFileSync(probe, 'ok', { encoding: 'utf8' });
  unlinkSync(probe);
}

function readDisk(path: string, override?: DataDirDisk | null): DataDirDisk | null {
  if (override === null) return null;
  if (override) return override;
  try {
    const stats = statfsSync(path);
    const bsize = Number(stats.bsize);
    return {
      freeBytes: Number(stats.bavail) * bsize,
      totalBytes: Number(stats.blocks) * bsize,
    };
  } catch {
    return null;
  }
}

function withDisk(status: DataDirStatus, disk: DataDirDisk | null): DataDirStatus {
  if (!disk || disk.totalBytes <= 0) return status;
  const freeRatio = disk.freeBytes / disk.totalBytes;
  return {
    ...status,
    freeBytes: disk.freeBytes,
    totalBytes: disk.totalBytes,
    freeRatio,
    warnLowSpace: freeRatio < FREE_SPACE_WARN_RATIO,
    alertLowSpace: freeRatio < FREE_SPACE_ALERT_RATIO,
  };
}

function readVolumeIdFile(root: string): VolumeIdFile | null {
  try {
    const raw = JSON.parse(readFileSync(volumeIdPath(root), 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object') return null;
    const id = typeof (raw as { id?: unknown }).id === 'string' ? (raw as { id: string }).id.trim() : '';
    const createdAt =
      typeof (raw as { createdAt?: unknown }).createdAt === 'string'
        ? (raw as { createdAt: string }).createdAt
        : '';
    if (!id || !createdAt) return null;
    return { id, createdAt };
  } catch {
    return null;
  }
}

function writeVolumeIdFile(root: string, record: VolumeIdFile) {
  writeFileSync(volumeIdPath(root), `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8' });
}

/**
 * Create config/cache/tmp, probe writability, and record volume identity.
 * Never throws — the app continues degraded when the volume is missing.
 */
export function ensureDataDir(deps: EnsureDataDirDeps = {}): DataDirStatus {
  const root = deps.root ?? getDataDir();
  const logError = deps.logError ?? ((message: string) => console.error(`[data-dir] ${message}`));
  const user = currentUser(deps.userInfo);

  try {
    mkdirSync(configDir(root), { recursive: true });
    mkdirSync(cacheDir(root), { recursive: true });
    mkdirSync(tmpDir(root), { recursive: true });
    const probe = deps.probeWrite ?? defaultProbeWrite;
    probe(root);
  } catch (error) {
    const message = describeUnwritable(root, error, user);
    logError(message);
    lastStatus = withDisk(emptyStatus(root, message, { previousVolumeId: deps.previousVolumeId ?? null }), readDisk(root, deps.disk));
    return lastStatus;
  }

  let record = readVolumeIdFile(root);
  if (!record) {
    record = { id: randomUUID(), createdAt: (deps.now ?? new Date()).toISOString() };
    try {
      writeVolumeIdFile(root, record);
    } catch (error) {
      const message = describeUnwritable(root, error, user);
      logError(message);
      lastStatus = withDisk(emptyStatus(root, message), readDisk(root, deps.disk));
      return lastStatus;
    }
  }

  lastStatus = withDisk(
    {
      checked: true,
      path: root,
      writable: true,
      error: null,
      volumeId: record.id,
      volumeCreatedAt: record.createdAt,
      volumeChanged: false,
      previousVolumeId: deps.previousVolumeId ?? lastStatus?.previousVolumeId ?? null,
      freeBytes: null,
      totalBytes: null,
      freeRatio: null,
      warnLowSpace: false,
      alertLowSpace: false,
    },
    readDisk(root, deps.disk),
  );
  return lastStatus;
}

async function defaultGetPreviousVolumeId() {
  const { prisma } = await import('../db');
  const row = await prisma.appSetting.findUnique({
    where: { key: VOLUME_ID_SETTING_KEY },
    select: { value: true },
  });
  return row?.value?.trim() || null;
}

async function defaultSetPreviousVolumeId(id: string) {
  const { prisma } = await import('../db');
  await prisma.appSetting.upsert({
    where: { key: VOLUME_ID_SETTING_KEY },
    create: { key: VOLUME_ID_SETTING_KEY, value: id },
    update: { value: id },
  });
}

export async function persistVolumeIdentity(deps: PersistVolumeIdentityDeps = {}) {
  const status = deps.status ?? getDataDirStatus();
  const warn = deps.warn ?? ((message: string) => console.warn(`[data-dir] ${message}`));
  const currentId = status.volumeId;
  if (!currentId) {
    return { changed: false as const, previousId: null as string | null, currentId: null as string | null };
  }

  const previousId = (await (deps.getPrevious ?? defaultGetPreviousVolumeId)()) ?? null;
  const changed = Boolean(previousId && previousId !== currentId);
  if (changed) {
    const message = `Persistent volume id changed (previous ${previousId}, current ${currentId}). This is a fresh volume or a lost mount. Reconstructible state will be rebuilt from Postgres or object storage.`;
    warn(message);
  }
  await (deps.setPrevious ?? defaultSetPreviousVolumeId)(currentId);
  lastStatus = {
    ...status,
    volumeChanged: changed,
    previousVolumeId: previousId,
  };
  return { changed, previousId, currentId };
}

export function assertFreeSpaceForLargeOp(status: DataDirStatus = getDataDirStatus()) {
  if (status.freeBytes == null) return;
  if (status.freeBytes < LARGE_OP_MIN_FREE_BYTES) {
    throw new Error(
      `Not enough free space on ${status.path} to run this operation. At least 2 GB must be free.`,
    );
  }
}

export function sweepTmp(deps: { root?: string; now?: Date; maxAgeMs?: number } = {}) {
  const root = deps.root ?? getDataDir();
  const dir = tmpDir(root);
  const now = (deps.now ?? new Date()).getTime();
  const maxAge = deps.maxAgeMs ?? TMP_MAX_AGE_MS;
  let removed = 0;
  if (!existsSync(dir)) return { removed };
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    try {
      const info = statSync(full);
      if (now - info.mtimeMs < maxAge) continue;
      rmSync(full, { recursive: true, force: true });
      removed += 1;
    } catch (error) {
      // A stale entry we cannot remove will keep filling the volume — say so.
      console.warn('[data-dir] tmp sweep could not remove an entry', {
        entry: name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { removed };
}

export async function withTmpDir<T>(fn: (dir: string) => Promise<T>, root = getDataDir()): Promise<T> {
  const parent = tmpDir(root);
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(join(parent, 'op-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function readCacheJson<T = CacheRecord>(name: string): T | null {
  try {
    const path = cachePath(name);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

export type CacheWriteResult = { ok: true } | { ok: false; error: string };

/**
 * Never throws — every caller treats the volume cache as optional — but never silent
 * either: a lost cache costs real work (a dropped GitHub installation token means every
 * publish re-mints one), and the old version of this could not be diagnosed at all.
 *
 * The destination is replaced by a single rename and is never unlinked first. Unlinking
 * before the rename meant a failed rename left no file at all, so a failed write destroyed
 * the previous good value.
 */
export function writeCacheJson(name: string, value: unknown): CacheWriteResult {
  const path = cachePath(name);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(cacheDir(), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(value)}\n`, { encoding: 'utf8' });
    renameSync(tmp, path);
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[data-dir] could not write a cache file; the previous value is kept', {
      file: name,
      error: message,
    });
    try {
      unlinkSync(tmp);
    } catch (cleanupError) {
      // A leftover .tmp is harmless but accumulates on the volume, so say so once.
      console.warn('[data-dir] could not remove the temp cache file', {
        file: `${name}.${process.pid}.tmp`,
        error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      });
    }
    return { ok: false, error: message };
  }
}

export async function maybeAlertLowSpace(deps: {
  status?: DataDirStatus;
  send?: (mail: { subject: string; html: string; text: string; emailClass?: 'security' }) => Promise<void>;
  getAlerted?: () => Promise<boolean>;
  setAlerted?: (alerted: boolean) => Promise<void>;
} = {}) {
  const status = deps.status ?? getDataDirStatus();
  if (!status.alertLowSpace || status.freeRatio == null || status.freeBytes == null) {
    try {
      if (deps.setAlerted) await deps.setAlerted(false);
      else {
        const { prisma } = await import('../db');
        // deleteMany, not delete: clearing a flag that was never set is the normal case and
        // must not look like an error. That is what the old blanket catch was hiding.
        await prisma.appSetting.deleteMany({ where: { key: VOLUME_LOW_SPACE_ALERT_KEY } });
      }
    } catch (error) {
      // This flag is the only thing suppressing repeat low-space emails. If it stays set,
      // no further low-disk email is ever sent — the failure mode is permanent silence, so
      // it is reported upward as well as logged.
      const message = error instanceof Error ? error.message : String(error);
      console.error('[data-dir] could not clear the low-space alert flag', { error: message });
      return { sent: false as const, alertFlagStale: true as const, error: message };
    }
    return { sent: false as const };
  }

  const already = deps.getAlerted
    ? await deps.getAlerted()
    : Boolean(
        (
          await (await import('../db')).prisma.appSetting.findUnique({
            where: { key: VOLUME_LOW_SPACE_ALERT_KEY },
          })
        )?.value,
      );
  if (already) return { sent: false as const };

  const { volumeLowSpaceEmail } = await import('../email/templates/volume-low-space');
  const mail = volumeLowSpaceEmail({
    path: status.path,
    freeRatio: status.freeRatio,
    freeBytes: status.freeBytes,
  });
  if (deps.send) {
    await deps.send(mail);
  } else {
    const { sendObservabilityAdminEmail } = await import('../observability/alerts');
    await sendObservabilityAdminEmail(mail);
  }
  if (deps.setAlerted) await deps.setAlerted(true);
  else {
    const { prisma } = await import('../db');
    await prisma.appSetting.upsert({
      where: { key: VOLUME_LOW_SPACE_ALERT_KEY },
      create: { key: VOLUME_LOW_SPACE_ALERT_KEY, value: '1' },
      update: { value: '1' },
    });
  }
  return { sent: true as const };
}

/**
 * The hourly sweep also carries the two things that tell an operator the volume is in
 * trouble: the volume-changed warning and the low-space email. Reporting `ok: true` when
 * either of those failed means you find out when the disk is full, so a failure here is
 * both logged and returned as `ok: false` — `handleCron` turns that into a 500 and a failed
 * `CronRun` row. The sweep itself still happens; nothing is left half-done.
 */
export async function runTmpSweep(
  deps: {
    identity?: () => Promise<Awaited<ReturnType<typeof persistVolumeIdentity>>>;
    alert?: () => Promise<Awaited<ReturnType<typeof maybeAlertLowSpace>>>;
  } = {},
) {
  const swept = sweepTmp();
  const errors: string[] = [];

  const identity = await (deps.identity ?? persistVolumeIdentity)().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[data-dir] could not persist volume identity', { error: message });
    errors.push(`volume identity: ${message}`);
    return {
      changed: false as const,
      previousId: null,
      currentId: getDataDirStatus().volumeId,
    };
  });

  const alert = await (deps.alert ?? maybeAlertLowSpace)().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[data-dir] low-space alert failed', { error: message });
    errors.push(`low-space alert: ${message}`);
    return { sent: false as const };
  });
  if ('alertFlagStale' in alert && alert.alertFlagStale) {
    errors.push('low-space alert flag could not be cleared, so a later low-disk email would be suppressed');
  }

  return {
    ok: errors.length === 0,
    ...swept,
    identity,
    alert,
    errors,
    dataDir: getDataDirStatus(),
  };
}
