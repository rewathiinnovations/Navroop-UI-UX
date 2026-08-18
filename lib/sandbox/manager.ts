/**
 * Project sandbox lifecycle.
 *
 * Sandboxes are disposable. The latest Checkpoint (readSnapshot: object
 * storage or legacy fileSnapshot Json, with lastCode as a fallback) is the
 * source of truth. The lastCode fallback is only for a checkpoint that is
 * genuinely empty — if the snapshot read fails, the boot fails at the
 * `checkpoint` step instead. Booting a stale tree rolls the user's recent work
 * back, and the next checkpoint then re-commits the stale tree as current.
 *
 * Concurrency (Coolify can run multiple app replicas):
 * 1. In-process Promise map — two tabs on the same Node process share one boot.
 * 2. Postgres advisory lock keyed on project id (`pg_advisory_lock(hashtext(id))`)
 *    plus a CAS to BOOTING, so two Coolify replicas cannot double-create.
 *    The lock is only held for the short claim transaction; create/restore
 *    runs outside so a pooled connection is not held for 90s.
 *
 * All VM creation goes through selectProvider → SandboxFactory.fromRow → driver.createSandbox.
 * Drivers: e2b, modal, daytona. Callers must use ensureSandbox() — never Sandbox.create outside lib/sandbox/.
 */

import { randomUUID } from 'crypto';
import { prisma } from '@/lib/db';
import { captureFileSnapshot, readSnapshot, type FileSnapshotEntry } from '@/lib/checkpoints/snapshot';
import { SandboxFactory } from '@/lib/sandbox/factory';
import { sandboxManager } from '@/lib/sandbox/sandbox-manager';
import type { SandboxInfo, SandboxProvider } from '@/lib/sandbox/types';
import { getStack } from '@/lib/stacks';
import type { SandboxStatus } from '@/generated/prisma';
import { getEffectivePlan, isUnlimited } from '@/lib/plans/limits';
import { limitDenialMessage } from '@/lib/plans/messages';
import { log } from '@/lib/logger';
import { trackFailure, trackStart, trackSuccess } from '@/lib/observability/track';
import { WORKSPACE_ROW_ID } from '@/lib/storage/usage';
import { checkSandboxMinutes, accrueProjectSandboxMinutes } from '@/lib/sandbox/meter';
import { idleMinutesFromEnv } from '@/lib/sandbox/minutes';
import { DRIVER_CAPABILITIES, NoProviderAvailableError } from '@/lib/sandbox/provider';
import { selectProvider, toCandidate } from '@/lib/sandbox/router';
import { createWithFailover, isSandboxBootFailover } from '@/lib/sandbox/failover';
import { getProviderConfig, listProviderConfigs } from '@/lib/sandbox/store';
import { accrueProviderUsage, rollAllProviderPeriods } from '@/lib/sandbox/accounting';
import { migrateEnvSandboxProvider } from '@/lib/sandbox/migrate-env';
import { stackScaffoldFiles } from '@/lib/sandbox/stack-setup';
import { markSandboxAttemptBootFailed, recordSandboxAttempts } from '@/lib/sandbox/job-attempts';
import type { ProviderCandidate } from '@/lib/sandbox/router';
import {
  previewNeverBecameReadyMessage,
  sandboxDriverLabel,
  sandboxReconnectUncertainMessage,
  usablePreviewUrl,
} from '@/lib/sandbox/boot-errors';
import {
  bindUnusedSandboxOutcome,
  clearSandboxLeak,
  isTeardownLeak,
  recordTeardownIfLeaked,
  sandboxProviderId,
  teardownAlreadyGone,
  teardownCouldNotStop,
  teardownProvider,
  unusedSandboxTeardownSuffix,
  type TeardownResult,
} from '@/lib/sandbox/teardown';

export type SandboxBootStep =
  | 'probe'
  | 'create'
  | 'checkpoint'
  | 'restore'
  | 'install'
  | 'dev'
  | 'ready';

export type EnsureSandboxResult = {
  sandboxId: string;
  previewUrl: string;
  wasColdStarted: boolean;
  requestId: string;
  status: SandboxStatus;
};

export type SandboxStatusPayload = {
  status: SandboxStatus;
  sandboxId: string | null;
  previewUrl: string | null;
  sandboxStartedAt: string | null;
  sandboxLastUsedAt: string | null;
  bootStep: SandboxBootStep | null;
  failedStep: SandboxBootStep | null;
  error: string | null;
  requestId: string | null;
  hasCheckpoint: boolean;
};

export class SandboxBootError extends Error {
  readonly step: SandboxBootStep;
  readonly code: 'NO_CHECKPOINT' | 'BOOT_FAILED' | 'SANDBOX_LIMIT' | 'SANDBOX_MINUTES';
  readonly requestId: string;
  /** Poll timeout detail — bind the teardown clause only after kill runs. */
  readonly previewLastError?: string;

  constructor(
    step: SandboxBootStep,
    message: string,
    options?: {
      code?: 'NO_CHECKPOINT' | 'BOOT_FAILED' | 'SANDBOX_LIMIT' | 'SANDBOX_MINUTES';
      requestId?: string;
      previewLastError?: string;
    },
  ) {
    super(message);
    this.name = 'SandboxBootError';
    this.step = step;
    this.code = options?.code ?? 'BOOT_FAILED';
    this.requestId = options?.requestId ?? randomUUID();
    this.previewLastError = options?.previewLastError;
  }
}

export function sandboxCreatedWithoutPreviewUrlMessage(driver: string, outcome?: TeardownResult): string {
  const label = sandboxDriverLabel(driver);
  return `${label} created a sandbox without a preview URL. ` + unusedSandboxTeardownSuffix(label, outcome);
}

/** User-facing boot English once teardown has a typed result. */
export function applySandboxBootTeardownOutcome(
  error: SandboxBootError,
  driver: string,
  outcome: TeardownResult,
): string {
  if (error.previewLastError) {
    return previewNeverBecameReadyMessage(driver, error.previewLastError, outcome);
  }
  if (error.step === 'dev' && /without a preview URL/.test(error.message)) {
    return sandboxCreatedWithoutPreviewUrlMessage(driver, outcome);
  }
  return bindUnusedSandboxOutcome(error.message, sandboxDriverLabel(driver), outcome);
}

/**
 * createWithFailover drops the driver when create() throws, so the boot catch
 * cannot terminate it. Drivers also terminate themselves; this is the second line.
 */
export async function createSandboxOrTerminate(
  driver: SandboxProvider,
  stack: string,
): Promise<SandboxInfo> {
  try {
    return await driver.createSandbox(stack);
  } catch (error) {
    const outcome = await teardownProvider(driver);
    await recordTeardownIfLeaked(outcome, {
      driver: sandboxProviderId(driver),
      source: 'create',
    });
    throw error;
  }
}

const PROBE_MS = 3_000;
/** How long `pollPreviewReady` waits for a successful preview response (2xx or 304). */
const READY_POLL_MS = 90_000;
const READY_POLL_INTERVAL_MS = 2_000;

/**
 * How long a second caller waits for a winner to become READY before giving up.
 * Not the same question as claim freshness — a boot that outlives this wait is
 * still alive, not an invitation to start a rival VM.
 */
export const BOOT_WAIT_MS = 90_000;

/**
 * How long a BOOTING row is treated as a live claim.
 *
 * Longer than `BOOT_WAIT_MS` so the waiter timeout and the steal window cannot
 * expire together. 10 minutes covers create + npm install + Vite start + the
 * 90s ready poll with margin; it matches the provider circuit cooldown
 * (`CIRCUIT_COOLDOWN_MS`) and stays under the 20-minute job hard timeout.
 * Not 60s (job heartbeat stale) — boot has no heartbeat, and npm install alone
 * exceeds that.
 */
export const BOOT_CLAIM_FRESH_MS = 10 * 60_000;

/** In-process coalescing so two tabs on one replica share one boot. */
const inflight = new Map<string, Promise<EnsureSandboxResult>>();
const bootSteps = new Map<string, SandboxBootStep>();
const lastErrors = new Map<string, { step: SandboxBootStep; message: string; requestId: string }>();
const lastRequestIds = new Map<string, string>();

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setStep(projectId: string, step: SandboxBootStep) {
  bootSteps.set(projectId, step);
}

function bindLegacyGlobals(provider: SandboxProvider, stack: string) {
  const info = provider.getSandboxInfo();
  sandboxManager.registerSandbox(info?.sandboxId || 'unknown', provider);
  (globalThis as { activeSandboxProvider?: SandboxProvider }).activeSandboxProvider = provider;
  (globalThis as { sandboxData?: { sandboxId: string; url: string; stack: string } }).sandboxData = {
    sandboxId: info?.sandboxId || '',
    url: info?.url || '',
    stack,
  };
  const state = (globalThis as {
    sandboxState?: {
      fileCache: { files: Record<string, { content: string; lastModified: number }>; lastSync: number; sandboxId: string };
      sandbox: SandboxProvider | null;
      sandboxData: { sandboxId: string; url: string } | null;
    };
  }).sandboxState;
  if (!state) {
    (globalThis as { sandboxState?: unknown }).sandboxState = {
      fileCache: { files: {}, lastSync: Date.now(), sandboxId: info?.sandboxId || '' },
      sandbox: provider,
      sandboxData: info ? { sandboxId: info.sandboxId, url: info.url } : null,
    };
  } else {
    state.sandbox = provider;
    state.sandboxData = info ? { sandboxId: info.sandboxId, url: info.url } : null;
    if (state.fileCache) state.fileCache.sandboxId = info?.sandboxId || state.fileCache.sandboxId;
  }
}

async function writeFiles(provider: SandboxProvider, files: FileSnapshotEntry[]) {
  for (const file of files) {
    const path = file.path.replace(/^\.?\//, '');
    await provider.writeFile(path, file.content);
  }
}

/**
 * The stack's known-good scaffold, with the snapshot's files winning on any
 * path both provide. REACT has no shared scaffold (its setup is owned by the
 * providers' `setupViteApp`), so a REACT restore passes through unchanged.
 */
export function withScaffoldUnderlay(
  stack: string,
  files: FileSnapshotEntry[],
): FileSnapshotEntry[] {
  let scaffold: Array<{ path: string; content: string }>;
  try {
    scaffold = stackScaffoldFiles(stack);
  } catch {
    return files;
  }
  const normalize = (path: string) => path.replace(/^\.?\//, '');
  const restored = new Set(files.map((file) => normalize(file.path)));
  const underlay = scaffold
    .filter((file) => !restored.has(normalize(file.path)))
    .map((file) => ({ path: file.path, content: file.content }));
  return [...underlay, ...files];
}

/**
 * Files to restore into a fresh sandbox.
 *
 * Throws when the latest checkpoint's snapshot cannot be read. It must not fall through
 * to `captureFileSnapshot` in that case: that reads `project.lastCode`, which lags the
 * sandbox, so a storage blip would boot a stale tree, generation would continue from it,
 * and the next checkpoint would be written from it — the user's recent work rolled back
 * and then re-committed as current, with nothing logged.
 *
 * Exported for tests/unit/sandbox-restore-snapshot.test.ts.
 */
export async function loadRestoreFiles(projectId: string): Promise<FileSnapshotEntry[]> {
  const latest = await prisma.checkpoint.findFirst({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    select: { snapshotKey: true, fileSnapshot: true },
  });
  const fromCheckpoint = latest ? await readSnapshot(latest) : [];
  if (fromCheckpoint.length > 0) return fromCheckpoint;
  return captureFileSnapshot(projectId);
}

export async function pollPreviewReady(
  previewUrl: string,
  requestId: string,
  options?: {
    driver?: string;
    timeoutMs?: number;
    intervalMs?: number;
    timeoutMessage?: (lastError: string) => string;
  },
) {
  const deadline = Date.now() + (options?.timeoutMs ?? READY_POLL_MS);
  const intervalMs = options?.intervalMs ?? READY_POLL_INTERVAL_MS;
  let lastError = 'Preview did not become ready';
  while (Date.now() < deadline) {
    try {
      // Trusted host — do not route through safeFetch.
      const response = await fetch(previewUrl, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(4_000) });
      if (response.ok || response.status === 304) return;
      lastError = `Preview HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'Preview fetch failed';
    }
    await sleep(intervalMs);
  }
  const message = options?.timeoutMessage
    ? options.timeoutMessage(lastError)
    : previewNeverBecameReadyMessage(options?.driver ?? '', lastError);
  throw new SandboxBootError('ready', message, {
    requestId,
    previewLastError: options?.timeoutMessage ? undefined : lastError,
  });
}

async function providerFromConfigId(configId: string | null | undefined) {
  if (configId) {
    // The stored row is honoured even when deactivated: probing or killing an
    // existing VM needs that row's credential regardless of routing status.
    const row = await getProviderConfig(configId);
    if (row) return SandboxFactory.fromRow(row);
  }
  // Fallback for rows-unknown callers: active rows only. listProviderConfigs
  // returns every row priority-first, and picking a deactivated one here kept
  // booting a provider the admin had explicitly turned off.
  const rows = await listProviderConfigs();
  const active = rows.find((row) => row.isActive);
  if (active) return SandboxFactory.fromRow(active);
  if (rows[0]) return SandboxFactory.fromRow(rows[0]);
  return SandboxFactory.create();
}

async function probeExisting(
  sandboxId: string,
  stack: string,
  configId?: string | null,
): Promise<{ provider: SandboxProvider; previewUrl: string } | null> {
  const provider = await providerFromConfigId(configId);
  const alive = await provider.reconnect(sandboxId, PROBE_MS);
  if (!alive) return null;
  const info = provider.getSandboxInfo();
  const previewUrl = usablePreviewUrl(info?.url || provider.getSandboxUrl());
  if (!previewUrl) {
    // Drivers must not return true without a real URL. Treating that as gone
    // would write DEAD and boot a second billable VM.
    throw new Error(
      sandboxReconnectUncertainMessage(
        info?.provider ?? 'sandbox',
        'reconnect succeeded without a preview URL',
      ),
    );
  }
  bindLegacyGlobals(provider, stack);
  return { provider, previewUrl };
}

/**
 * Short transaction: advisory lock + CAS to BOOTING.
 * Returns true if this replica owns the boot. Long create/restore runs outside
 * the transaction so we do not hold a pooled connection for 90s.
 */
async function claimBoot(projectId: string): Promise<boolean> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_lock(hashtext(${projectId}))`;
      try {
        const row = await tx.project.findFirst({
          where: { id: projectId, deletedAt: null },
          select: { sandboxStatus: true, sandboxStartedAt: true },
        });
        if (!row) return false;
        const bootingFresh =
          row.sandboxStatus === 'BOOTING' &&
          row.sandboxStartedAt &&
          Date.now() - row.sandboxStartedAt.getTime() < BOOT_CLAIM_FRESH_MS;
        if (bootingFresh) return false;
        // Stale BOOTING: the previous claim is dead (no boot heartbeat). Accrue
        // that window before we overwrite sandboxStartedAt so the minutes are
        // not lost. A leftover sandboxId is left for bootProject to probe and
        // reuse if the VM is still alive; otherwise a new VM is created.
        if (row.sandboxStatus === 'BOOTING' && row.sandboxStartedAt) {
          const startedAt = row.sandboxStartedAt;
          await accrueProjectSandboxMinutes(projectId, WORKSPACE_ROW_ID, new Date()).catch((error) => {
            log.warn('sandbox.stale_boot_meter_failed', {
              projectId,
              error: error instanceof Error ? error.message : String(error),
            });
          });
          const configRows = await prisma.$queryRaw<Array<{ sandboxProviderConfigId: string | null }>>`
            SELECT "sandboxProviderConfigId" FROM "Project" WHERE id = ${projectId} LIMIT 1
          `;
          const configId = configRows[0]?.sandboxProviderConfigId ?? null;
          if (configId) {
            await accrueProviderUsage({ configId, startedAt }).catch((error) => {
              log.warn('sandbox.stale_boot_provider_meter_failed', {
                projectId,
                error: error instanceof Error ? error.message : String(error),
              });
            });
          }
        }
        await tx.project.update({
          where: { id: projectId },
          data: { sandboxStatus: 'BOOTING', sandboxStartedAt: new Date() },
        });
        return true;
      } finally {
        await tx.$executeRaw`SELECT pg_advisory_unlock(hashtext(${projectId}))`;
      }
    },
    { timeout: 15_000, maxWait: 10_000 },
  );
}

async function waitForInflightOrReady(
  projectId: string,
  requestId: string,
  own?: Promise<EnsureSandboxResult>,
): Promise<EnsureSandboxResult | null> {
  const deadline = Date.now() + BOOT_WAIT_MS;
  while (Date.now() < deadline) {
    const local = inflight.get(projectId);
    // Never adopt our own promise. `ensureSandbox` registers `run` in the map during the
    // same synchronous block that starts it, so by the time this runs the caller is
    // already in there — returning it made the boot await itself and never settle.
    if (local && local !== own) return local;
    const row = await prisma.project.findFirst({
      where: { id: projectId, deletedAt: null },
      select: { sandboxStatus: true, sandboxId: true, previewUrl: true, stack: true },
    });
    if (!row) return null;
    if (row.sandboxStatus === 'READY' && row.sandboxId && row.previewUrl) {
      const configRows = await prisma.$queryRaw<Array<{ sandboxProviderConfigId: string | null }>>`
        SELECT "sandboxProviderConfigId" FROM "Project" WHERE id = ${projectId} LIMIT 1
      `;
      const probed = await probeExisting(row.sandboxId, row.stack, configRows[0]?.sandboxProviderConfigId);
      if (probed) {
        await touchSandbox(projectId);
        return {
          sandboxId: row.sandboxId,
          previewUrl: probed.previewUrl || row.previewUrl,
          wasColdStarted: false,
          requestId,
          status: 'READY',
        };
      }
    }
    // FAILED is retryable. Throwing here replayed the last error forever and
    // never reached claimBoot — a transient install/timeout then blocked "try again".
    // Permanent denials (minutes, no provider) fail fast inside bootProject without
    // creating a VM. claimBoot still serializes a retry against an in-flight boot.
    if (row.sandboxStatus !== 'BOOTING') return null;
    await sleep(1_500);
  }
  return null;
}

async function evictLruSandboxIfNeeded(projectId: string, requestId: string) {
  const plan = await getEffectivePlan();
  const limit = plan.maxConcurrentSandboxes;
  if (isUnlimited(limit)) return;

  const others = await prisma.project.count({
    where: {
      deletedAt: null,
      id: { not: projectId },
      sandboxStatus: { in: ['READY', 'BOOTING'] },
    },
  });
  if (others < limit) return;

  const ready = await prisma.project.findMany({
    where: { deletedAt: null, sandboxStatus: 'READY' },
    orderBy: { sandboxLastUsedAt: 'asc' },
    select: { id: true },
  });
  const lru = ready[0];
  if (!lru || (limit === 1 && lru.id === projectId)) {
    throw new SandboxBootError('create', limitDenialMessage('sandboxes'), {
      code: 'SANDBOX_LIMIT',
      requestId,
    });
  }
  await killSandbox(lru.id);
}

async function bootProject(
  projectId: string,
  options: { allowEmpty?: boolean; requestId: string },
): Promise<EnsureSandboxResult> {
  const requestId = options.requestId;
  lastRequestIds.set(projectId, requestId);

  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: {
      id: true,
      stack: true,
      sandboxId: true,
      previewUrl: true,
      sandboxStatus: true,
      previewMode: true,
      activeJobId: true,
    },
  });
  if (!project) {
    throw new SandboxBootError('probe', 'Project not found', { requestId });
  }

  const storedConfig = await prisma.$queryRaw<Array<{ sandboxProviderConfigId: string | null }>>`
    SELECT "sandboxProviderConfigId" FROM "Project" WHERE id = ${projectId} LIMIT 1
  `;
  const stickyConfigId = storedConfig[0]?.sandboxProviderConfigId ?? null;

  const stack = getStack(project.stack).id;

  if (project.sandboxId) {
    setStep(projectId, 'probe');
    let probed: { provider: SandboxProvider; previewUrl: string } | null;
    try {
      probed = await probeExisting(project.sandboxId, stack, stickyConfigId);
    } catch (error) {
      // claimBoot already wrote BOOTING. An uncertain probe must not stay
      // BOOTING (10 min live claim) and must not fall through to create.
      const message = error instanceof Error ? error.message : String(error);
      await prisma.project.update({
        where: { id: projectId },
        data: { sandboxStatus: 'READY' },
      });
      throw new SandboxBootError('probe', message, { requestId });
    }
    if (probed) {
      await prisma.project.update({
        where: { id: projectId },
        data: { sandboxStatus: 'READY', sandboxLastUsedAt: new Date(), previewUrl: probed.previewUrl },
      });
      lastErrors.delete(projectId);
      bootSteps.delete(projectId);
      return {
        sandboxId: project.sandboxId,
        previewUrl: probed.previewUrl,
        wasColdStarted: false,
        requestId,
        status: 'READY',
      };
    }
    await prisma.project.update({
      where: { id: projectId },
      data: { sandboxStatus: 'DEAD' },
    });
  }

  let files: FileSnapshotEntry[];
  try {
    files = await loadRestoreFiles(projectId);
  } catch (error) {
    // Outside the try/catch below, so this branch owns marking the project FAILED.
    // Letting it propagate raw would leave the row BOOTING and every later request
    // would wait 90s on a boot that already died.
    const detail = error instanceof Error ? error.message : String(error);
    log.error('sandbox.restore_snapshot_unreadable', { projectId, requestId, error: detail });
    const message =
      'Could not read the saved version from storage, so nothing was restored. Try again in a moment.';
    lastErrors.set(projectId, { step: 'checkpoint', message, requestId });
    await prisma.project.update({
      where: { id: projectId },
      data: { sandboxStatus: 'FAILED' },
    });
    throw new SandboxBootError('checkpoint', message, { requestId });
  }
  if (files.length === 0 && !options.allowEmpty) {
    const error = new SandboxBootError(
      'checkpoint',
      'No saved version to restore. Generate the project first.',
      { code: 'NO_CHECKPOINT', requestId },
    );
    lastErrors.set(projectId, { step: 'checkpoint', message: error.message, requestId });
    await prisma.project.update({
      where: { id: projectId },
      data: { sandboxStatus: 'FAILED' },
    });
    throw error;
  }

  const minutes = await checkSandboxMinutes(WORKSPACE_ROW_ID);
  if (!minutes.ok) {
    const error = new SandboxBootError('create', minutes.message, {
      code: 'SANDBOX_MINUTES',
      requestId,
    });
    lastErrors.set(projectId, { step: 'create', message: error.message, requestId });
    await prisma.project.update({
      where: { id: projectId },
      data: { sandboxStatus: 'FAILED' },
    });
    throw error;
  }

  try {
    await evictLruSandboxIfNeeded(projectId, requestId);
  } catch (error) {
    if (error instanceof SandboxBootError && error.code === 'SANDBOX_LIMIT') {
      lastErrors.set(projectId, { step: error.step, message: error.message, requestId });
      await prisma.project.update({
        where: { id: projectId },
        data: { sandboxStatus: 'FAILED' },
      });
    }
    throw error;
  }

  const bootStartedAt = Date.now();
  trackStart('sandbox.cold_start', { action: 'sandbox', workspaceId: 'default' });

  await prisma.project.update({
    where: { id: projectId },
    data: { sandboxStatus: 'BOOTING', sandboxStartedAt: new Date() },
  });

  let provider: SandboxProvider | null = null;
  let selectedConfig: ProviderCandidate | null = null;
  const attempts: Array<{
    configId: string;
    driver: string;
    ok: boolean;
    error?: string;
    at: string;
    selectionReason?: string;
  }> = [];
  const persistBootAttempts = async (ok: boolean, error?: string) => {
    try {
      const rows = ok ? attempts : markSandboxAttemptBootFailed(attempts, error ?? 'Sandbox boot failed');
      await recordSandboxAttempts(project.activeJobId, rows, ok ? selectedConfig?.id ?? null : null);
    } catch (recordError) {
      log.error('sandbox.attempt_record_failed', {
        projectId,
        error: recordError instanceof Error ? recordError.message : String(recordError),
      });
    }
  };
  try {
    setStep(projectId, 'create');
    await migrateEnvSandboxProvider();
    await rollAllProviderPeriods();
    const requireLivePreview = project.previewMode === 'LIVE_SANDBOX';
    let selected: ProviderCandidate;
    try {
      selected = await selectProvider({ projectId, requireLivePreview });
    } catch (error) {
      if (error instanceof NoProviderAvailableError) {
        throw new SandboxBootError('create', error.message, { requestId });
      }
      throw error;
    }
    const ordered = [
      selected,
      ...(await listProviderConfigs())
        .map(toCandidate)
        .filter((row) => row.id !== selected.id),
    ];
    // The whole boot runs inside the failover, not just `createSandbox`.
    //
    // Creating the VM was the only step covered before, and it is the step that almost
    // never fails: a provider hands back a handle and then never serves the dev server.
    // That threw out here, past the loop, so one flaky provider failed every build on the
    // instance while the next candidate — a different vendor, with credit — was never
    // asked. Restore, install, the preview URL and the readiness poll all belong inside,
    // and a provider that fails any of them is torn down before the next one is tried.
    const created = await createWithFailover({
      candidates: ordered,
      isFailoverError: (error) => isSandboxBootFailover(error),
      create: async (row) => {
        const stored = await getProviderConfig(row.id);
        if (!stored) throw new Error('Provider config missing');
        const driver = SandboxFactory.fromRow(stored);
        const info = await createSandboxOrTerminate(driver, stack);
        // Past this point the VM exists and is billable, so every exit that is not a
        // usable preview has to stop it before handing the next candidate a turn.
        try {
          if (files.length > 0) {
            setStep(projectId, 'restore');
            // A snapshot from a partial first build carries only the generated
            // app files — no package.json, no config. Restoring just those and
            // running npm install left npm planning against container root
            // (the deterministic "Tracker idealTree already exists" boot
            // failure). Lay the stack scaffold under the restore: scaffold
            // files the snapshot doesn't override, then the snapshot on top.
            await writeFiles(driver, withScaffoldUnderlay(stack, files));
            setStep(projectId, 'install');
            await driver.installAndStartDev(stack);
          } else {
            setStep(projectId, 'install');
            await driver.setupViteApp(stack);
          }

          setStep(projectId, 'dev');
          const publicUrl = DRIVER_CAPABILITIES[row.driver]?.publicPreviewUrl;
          const previewUrl = driver.getSandboxUrl() || info.url || '';
          if (!previewUrl && publicUrl) {
            throw new SandboxBootError('dev', sandboxCreatedWithoutPreviewUrlMessage(row.driver), {
              requestId,
            });
          }

          setStep(projectId, 'ready');
          if (publicUrl && previewUrl) {
            await pollPreviewReady(previewUrl, requestId, { driver: row.driver });
          }
          return { driver, info, row, previewUrl, publicUrl };
        } catch (error) {
          const outcome = await teardownProvider(driver);
          await recordTeardownIfLeaked(outcome, {
            projectId,
            providerConfigId: row.id,
            driver: row.driver,
            source: 'boot',
          });
          // Re-word with what teardown actually managed, so the reader is told whether the
          // abandoned VM is still costing them anything.
          if (error instanceof SandboxBootError) {
            throw new SandboxBootError(
              error.step,
              applySandboxBootTeardownOutcome(error, row.driver, outcome),
              { code: error.code, requestId: error.requestId, previewLastError: error.previewLastError },
            );
          }
          // Anything reaching here failed *after* this provider's VM existed, so it is that
          // provider's failure whatever its type — and the providers do not all use
          // SandboxBootError. `assertInstallSucceeded` throws a plain Error, which is how a
          // Modal `npm install` failure ("Tracker idealTree already exists") ended the whole
          // boot in ten seconds with an eligible E2B row untouched. Naming the step here is
          // what lets `isSandboxBootFailover` give the next candidate its turn.
          throw new SandboxBootError(
            bootSteps.get(projectId) ?? 'install',
            error instanceof Error ? error.message : String(error),
            { requestId },
          );
        }
      },
      onAttempt: async (attempt) => {
        attempts.push(attempt);
        if (!attempt.ok) {
          const stored = await getProviderConfig(attempt.configId);
          if (stored) {
            await import('@/lib/sandbox/store').then(({ updateProviderConfig }) =>
              updateProviderConfig(attempt.configId, {
                consecutiveFails: stored.consecutiveFails + 1,
                lastError: attempt.error ?? 'create failed',
                lastCheckedAt: new Date(),
              }),
            );
          }
          await recordSandboxAttempts(project.activeJobId, attempts, null);
          return;
        }
        // A handle is not a READY boot, but this callback now runs after the readiness
        // poll, so ok:true here does mean the preview answered.
      },
    });
    provider = created.driver;
    selectedConfig = created.row;
    const createdInfo = created.info;
    const previewUrl = created.previewUrl;

    // Deferred out of the loop deliberately: written for the provider that actually won,
    // so failing over from a static-only vendor to a public-preview one cannot leave the
    // project pinned to STATIC.
    if (!created.publicUrl) {
      await prisma.$executeRaw`
        UPDATE "Project" SET "previewMode" = 'STATIC'::"PreviewMode" WHERE id = ${projectId}
      `;
    }

    bindLegacyGlobals(provider, stack);
    const now = new Date();
    await prisma.project.update({
      where: { id: projectId },
      data: {
        sandboxId: createdInfo.sandboxId,
        previewUrl: previewUrl || null,
        sandboxStatus: 'READY',
        sandboxStartedAt: now,
        sandboxLastUsedAt: now,
      },
    });
    await prisma.$executeRaw`
      UPDATE "Project"
      SET "sandboxProviderConfigId" = ${selectedConfig.id}
      WHERE id = ${projectId}
    `;
    lastErrors.delete(projectId);
    bootSteps.delete(projectId);
    await persistBootAttempts(true);
    trackSuccess('sandbox.cold_start.success', {
      action: 'sandbox',
      durationMs: Date.now() - bootStartedAt,
    });
    // Self-heal for generations whose sandbox died before the post-build
    // capture: the site sits in lastCode with no checkpoint and no static
    // preview. Now that a sandbox is genuinely READY, take the checkpoint
    // (which also drives the preview capture) — detached and logged, never
    // blocking the boot response.
    void (async () => {
      try {
        const checkpointCount = await prisma.checkpoint.count({ where: { projectId } });
        if (checkpointCount > 0) return;
        const row = await prisma.project.findUnique({
          where: { id: projectId },
          select: { lastCode: true },
        });
        if (!row?.lastCode) return;
        const { createCheckpointAfterGeneration } = await import('@/lib/checkpoints/actions');
        await createCheckpointAfterGeneration(projectId, {
          previousPhase: 'COMPLETE',
          previewUrl: previewUrl || null,
        });
      } catch (error) {
        log.warn('sandbox.ready_capture_failed', {
          projectId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    return {
      sandboxId: createdInfo.sandboxId,
      previewUrl: previewUrl || '',
      wasColdStarted: true,
      requestId,
      status: 'READY',
    };
  } catch (error) {
    const step = bootSteps.get(projectId) ?? 'create';
    const message = error instanceof SandboxBootError ? error.message : error instanceof Error ? error.message : 'Sandbox boot failed';
    const wrapped =
      error instanceof SandboxBootError
        ? error
        : new SandboxBootError(step, message, { requestId });
    lastErrors.set(projectId, { step: wrapped.step, message: wrapped.message, requestId });
    trackFailure('sandbox.cold_start.failure', wrapped, {
      action: 'sandbox',
      step: wrapped.step,
      durationMs: Date.now() - bootStartedAt,
    });
    let bootMessage = wrapped.message;
    if (provider) {
      const leakId = provider.getSandboxInfo()?.sandboxId ?? null;
      const outcome = await teardownProvider(provider);
      await recordTeardownIfLeaked(outcome, {
        projectId,
        providerConfigId: selectedConfig?.id ?? null,
        driver: sandboxProviderId(provider),
        source: 'boot',
      });
      bootMessage = applySandboxBootTeardownOutcome(
        wrapped,
        selectedConfig?.driver ?? sandboxProviderId(provider) ?? '',
        outcome,
      );
      if (isTeardownLeak(outcome)) {
        await prisma.project.update({
          where: { id: projectId },
          data: {
            sandboxStatus: 'FAILED',
            sandboxId: leakId ?? outcome.sandboxId,
          },
        });
        const leaked = new SandboxBootError(wrapped.step, bootMessage, {
          code: wrapped.code,
          requestId: wrapped.requestId,
        });
        lastErrors.set(projectId, { step: leaked.step, message: leaked.message, requestId });
        await persistBootAttempts(false, bootMessage);
        throw leaked;
      }
    }
    await prisma.project.update({
      where: { id: projectId },
      data: { sandboxStatus: 'FAILED' },
    });
    if (bootMessage !== wrapped.message) {
      const settled = new SandboxBootError(wrapped.step, bootMessage, {
        code: wrapped.code,
        requestId: wrapped.requestId,
      });
      lastErrors.set(projectId, { step: settled.step, message: settled.message, requestId });
      await persistBootAttempts(false, bootMessage);
      throw settled;
    }
    await persistBootAttempts(false, bootMessage);
    throw wrapped;
  }
}

/**
 * Get or restore a live sandbox for a project.
 * `allowEmpty` is only for first generation (no checkpoint / lastCode yet).
 */
export async function ensureSandbox(
  projectId: string,
  options?: { allowEmpty?: boolean },
): Promise<EnsureSandboxResult> {
  const existing = inflight.get(projectId);
  if (existing) return existing;

  const requestId = randomUUID();
  const runRef: { current: Promise<EnsureSandboxResult> | undefined } = {
    current: undefined,
  };
  const run = (async () => {
    await migrateEnvSandboxProvider();
    const waited = await waitForInflightOrReady(projectId, requestId, runRef.current);
    if (waited) return waited;

    const claimed = await claimBoot(projectId);
    if (!claimed) {
      const afterWait = await waitForInflightOrReady(projectId, requestId, runRef.current);
      if (afterWait) return afterWait;
      // Lost the CAS and the winner never became READY. Booting here creates a
      // second billable VM and orphans the first when this replica overwrites sandboxId.
      throw new SandboxBootError('ready', 'The workspace is still starting. Try again.', {
        requestId,
      });
    }

    return bootProject(projectId, { allowEmpty: options?.allowEmpty, requestId });
  })().finally(() => {
    if (inflight.get(projectId) === run) inflight.delete(projectId);
  });
  runRef.current = run;

  inflight.set(projectId, run);
  return run;
}

export async function touchSandbox(projectId: string) {
  await prisma.project.updateMany({
    where: { id: projectId, deletedAt: null },
    data: { sandboxLastUsedAt: new Date() },
  });
}

export async function killSandbox(projectId: string): Promise<{ stopped: boolean; leaked: boolean }> {
  await accrueProjectSandboxMinutes(projectId, WORKSPACE_ROW_ID, new Date(), { bumpStart: true }).catch((error) => {
    log.warn('sandbox.meter_failed', { error: error instanceof Error ? error.message : String(error) });
  });
  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { sandboxId: true, sandboxStartedAt: true },
  });
  const configRows = await prisma.$queryRaw<
    Array<{ sandboxProviderConfigId: string | null; sandboxStartedAt: Date | null }>
  >`
    SELECT "sandboxProviderConfigId", "sandboxStartedAt" FROM "Project" WHERE id = ${projectId} LIMIT 1
  `;
  const configId = configRows[0]?.sandboxProviderConfigId ?? null;
  const startedAt = configRows[0]?.sandboxStartedAt ?? project?.sandboxStartedAt ?? null;
  if (configId && startedAt) {
    await accrueProviderUsage({ configId, startedAt }).catch((error) => {
      log.warn('sandbox.provider_meter_failed', { error: error instanceof Error ? error.message : String(error) });
    });
  }
  let outcome = project?.sandboxId ? teardownAlreadyGone(project.sandboxId) : teardownAlreadyGone(null);
  if (project?.sandboxId) {
    const named = sandboxManager.getProvider(project.sandboxId);
    if (named) {
      outcome = await sandboxManager.terminateSandbox(project.sandboxId);
    } else {
      try {
        const provider = await providerFromConfigId(configId);
        const attached = await provider.reconnect(project.sandboxId);
        if (attached) outcome = await teardownProvider(provider);
        else outcome = teardownAlreadyGone(project.sandboxId);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        log.warn('sandbox.kill_reconnect_failed', { error: detail });
        outcome = teardownCouldNotStop(detail, project.sandboxId);
      }
    }
  }
  const active = sandboxManager.getActiveProvider();
  const activeId = active?.getSandboxInfo()?.sandboxId;
  if (activeId && activeId === project?.sandboxId && !isTeardownLeak(outcome)) {
    const activeOutcome = await sandboxManager.terminateSandbox(activeId);
    if (isTeardownLeak(activeOutcome)) outcome = activeOutcome;
  }
  if (isTeardownLeak(outcome)) {
    await recordTeardownIfLeaked(outcome, {
      projectId,
      providerConfigId: configId,
      driver: sandboxProviderId({
        terminate: async () => outcome,
        getSandboxInfo: () => (project?.sandboxId ? { sandboxId: project.sandboxId } : null),
      }),
      source: 'kill',
    });
    return { stopped: false, leaked: true };
  }
  if (project?.sandboxId) {
    await clearSandboxLeak({ sandboxId: project.sandboxId, projectId }).catch((error) => {
      log.warn('sandbox.teardown_leak_clear_failed', {
        projectId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
  await prisma.$executeRaw`
    UPDATE "Project"
    SET
      "sandboxStatus" = 'NONE'::"SandboxStatus",
      "sandboxId" = NULL,
      "previewUrl" = NULL,
      "sandboxStartedAt" = NULL,
      "sandboxLastUsedAt" = NULL,
      "sandboxMeteredUntil" = NULL,
      "updatedAt" = NOW()
    WHERE id = ${projectId} AND "deletedAt" IS NULL
  `;
  bootSteps.delete(projectId);
  lastErrors.delete(projectId);
  return { stopped: true, leaked: false };
}

export async function getSandboxStatus(projectId: string): Promise<SandboxStatusPayload | null> {
  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: {
      sandboxStatus: true,
      sandboxId: true,
      previewUrl: true,
      sandboxStartedAt: true,
      sandboxLastUsedAt: true,
    },
  });
  if (!project) return null;

  const checkpointCount = await prisma.checkpoint.count({ where: { projectId } });
  const failed = lastErrors.get(projectId);
  return {
    status: project.sandboxStatus,
    sandboxId: project.sandboxId,
    previewUrl: project.previewUrl,
    sandboxStartedAt: project.sandboxStartedAt?.toISOString() ?? null,
    sandboxLastUsedAt: project.sandboxLastUsedAt?.toISOString() ?? null,
    bootStep: project.sandboxStatus === 'BOOTING' ? bootSteps.get(projectId) ?? 'create' : null,
    failedStep: project.sandboxStatus === 'FAILED' ? failed?.step ?? null : null,
    error: project.sandboxStatus === 'FAILED' ? failed?.message ?? 'Sandbox boot failed' : null,
    requestId: lastRequestIds.get(projectId) ?? failed?.requestId ?? null,
    hasCheckpoint: checkpointCount > 0,
  };
}

export function getLiveProvider(sandboxId?: string | null): SandboxProvider | null {
  if (sandboxId) {
    const named = sandboxManager.getProvider(sandboxId);
    if (named) return named;
  }
  return (
    sandboxManager.getActiveProvider() ||
    (globalThis as { activeSandboxProvider?: SandboxProvider }).activeSandboxProvider ||
    null
  );
}

export function idleMinutes() {
  return idleMinutesFromEnv();
}

/** Legacy no-project path. Still the only create entry besides ensureSandbox. */
export async function bootEphemeralSandbox(stack: string) {
  const definition = getStack(stack);
  await migrateEnvSandboxProvider();
  await rollAllProviderPeriods();
  const selected = await selectProvider({ requireLivePreview: true });
  const stored = await getProviderConfig(selected.id);
  const provider = stored ? SandboxFactory.fromRow(stored) : SandboxFactory.create(selected.driver);
  const created = await provider.createSandbox(definition.id);
  try {
    await provider.setupViteApp(definition.id);
  } catch (error) {
    // The VM already exists at this point — drop it rather than leaking a paid sandbox.
    const outcome = await teardownProvider(provider);
    await recordTeardownIfLeaked(outcome, {
      driver: sandboxProviderId(provider),
      source: 'ephemeral',
    });
    if (isTeardownLeak(outcome)) {
      log.error('sandbox.ephemeral_terminate_failed', {
        sandboxId: created.sandboxId,
        error: outcome.reason,
      });
    }
    throw error;
  }
  bindLegacyGlobals(provider, definition.id);
  return {
    sandboxId: created.sandboxId,
    previewUrl: provider.getSandboxUrl() || created.url,
    stack: definition.id,
    provider: created.provider,
  };
}
