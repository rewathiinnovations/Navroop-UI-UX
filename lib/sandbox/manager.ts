/**
 * Project sandbox lifecycle.
 *
 * Sandboxes are disposable. The latest Checkpoint (readSnapshot: object
 * storage or legacy fileSnapshot Json, with lastCode as a fallback) is the
 * source of truth.
 *
 * Concurrency (Coolify can run multiple app replicas):
 * 1. In-process Promise map — two tabs on the same Node process share one boot.
 * 2. Postgres advisory lock keyed on project id (`pg_advisory_lock(hashtext(id))`)
 *    plus a CAS to BOOTING, so two Coolify replicas cannot double-create.
 *    The lock is only held for the short claim transaction; create/restore
 *    runs outside so a pooled connection is not held for 90s.
 *
 * All E2B / Vercel VM creation goes through SandboxFactory → provider.createSandbox.
 * Callers must use ensureSandbox() — never Sandbox.create outside lib/sandbox/.
 */

import { randomUUID } from 'crypto';
import { prisma } from '@/lib/db';
import { captureFileSnapshot, readSnapshot, type FileSnapshotEntry } from '@/lib/checkpoints/snapshot';
import { SandboxFactory } from '@/lib/sandbox/factory';
import { sandboxManager } from '@/lib/sandbox/sandbox-manager';
import type { SandboxProvider } from '@/lib/sandbox/types';
import { getStack } from '@/lib/stacks';
import type { SandboxStatus } from '@/generated/prisma';

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
  readonly code: 'NO_CHECKPOINT' | 'BOOT_FAILED';
  readonly requestId: string;

  constructor(
    step: SandboxBootStep,
    message: string,
    options?: { code?: 'NO_CHECKPOINT' | 'BOOT_FAILED'; requestId?: string },
  ) {
    super(message);
    this.name = 'SandboxBootError';
    this.step = step;
    this.code = options?.code ?? 'BOOT_FAILED';
    this.requestId = options?.requestId ?? randomUUID();
  }
}

const PROBE_MS = 3_000;
const READY_POLL_MS = 90_000;
const READY_POLL_INTERVAL_MS = 2_000;

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

async function loadRestoreFiles(projectId: string): Promise<FileSnapshotEntry[]> {
  const latest = await prisma.checkpoint.findFirst({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    select: { snapshotKey: true, fileSnapshot: true },
  });
  const fromCheckpoint = latest ? await readSnapshot(latest) : [];
  if (fromCheckpoint.length > 0) return fromCheckpoint;
  return captureFileSnapshot(projectId);
}

async function pollPreviewReady(previewUrl: string, requestId: string) {
  const deadline = Date.now() + READY_POLL_MS;
  let lastError = 'Preview did not become ready';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(previewUrl, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(4_000) });
      if (response.ok || response.status === 304) return;
      lastError = `Preview HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'Preview fetch failed';
    }
    await sleep(READY_POLL_INTERVAL_MS);
  }
  throw new SandboxBootError('ready', lastError, { requestId });
}

async function probeExisting(sandboxId: string, stack: string): Promise<{ provider: SandboxProvider; previewUrl: string } | null> {
  const provider = SandboxFactory.create();
  const alive = await provider.reconnect(sandboxId, PROBE_MS);
  if (!alive) return null;
  const info = provider.getSandboxInfo();
  const previewUrl = info?.url || provider.getSandboxUrl();
  if (!previewUrl) return null;
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
          Date.now() - row.sandboxStartedAt.getTime() < READY_POLL_MS;
        if (bootingFresh) return false;
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
): Promise<EnsureSandboxResult | null> {
  const deadline = Date.now() + READY_POLL_MS;
  while (Date.now() < deadline) {
    const local = inflight.get(projectId);
    if (local) return local;
    const row = await prisma.project.findFirst({
      where: { id: projectId, deletedAt: null },
      select: { sandboxStatus: true, sandboxId: true, previewUrl: true, stack: true },
    });
    if (!row) return null;
    if (row.sandboxStatus === 'READY' && row.sandboxId && row.previewUrl) {
      const probed = await probeExisting(row.sandboxId, row.stack);
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
    if (row.sandboxStatus === 'FAILED') {
      const failed = lastErrors.get(projectId);
      throw new SandboxBootError(failed?.step ?? 'ready', failed?.message ?? 'Sandbox boot failed', {
        requestId: failed?.requestId ?? requestId,
      });
    }
    if (row.sandboxStatus !== 'BOOTING') return null;
    await sleep(1_500);
  }
  return null;
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
    },
  });
  if (!project) {
    throw new SandboxBootError('probe', 'Project not found', { requestId });
  }

  const stack = getStack(project.stack).id;

  if (project.sandboxId) {
    setStep(projectId, 'probe');
    const probed = await probeExisting(project.sandboxId, stack);
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

  const files = await loadRestoreFiles(projectId);
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

  await prisma.project.update({
    where: { id: projectId },
    data: { sandboxStatus: 'BOOTING', sandboxStartedAt: new Date() },
  });

  let provider: SandboxProvider | null = null;
  try {
    setStep(projectId, 'create');
    provider = SandboxFactory.create();
    const created = await provider.createSandbox(stack);

    if (files.length > 0) {
      setStep(projectId, 'restore');
      await writeFiles(provider, files);
      setStep(projectId, 'install');
      await provider.installAndStartDev(stack);
    } else {
      setStep(projectId, 'install');
      await provider.setupViteApp(stack);
    }

    setStep(projectId, 'dev');
    const previewUrl = provider.getSandboxUrl() || created.url;
    if (!previewUrl) {
      throw new SandboxBootError('dev', 'Sandbox created without a preview URL', { requestId });
    }

    setStep(projectId, 'ready');
    await pollPreviewReady(previewUrl, requestId);

    bindLegacyGlobals(provider, stack);
    const now = new Date();
    await prisma.project.update({
      where: { id: projectId },
      data: {
        sandboxId: created.sandboxId,
        previewUrl,
        sandboxStatus: 'READY',
        sandboxStartedAt: now,
        sandboxLastUsedAt: now,
      },
    });
    lastErrors.delete(projectId);
    bootSteps.delete(projectId);
    return {
      sandboxId: created.sandboxId,
      previewUrl,
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
    try {
      await provider?.terminate();
    } catch {
      /* ignore */
    }
    await prisma.project.update({
      where: { id: projectId },
      data: { sandboxStatus: 'FAILED' },
    });
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
  const run = (async () => {
    const waited = await waitForInflightOrReady(projectId, requestId);
    if (waited) return waited;

    const claimed = await claimBoot(projectId);
    if (!claimed) {
      const afterWait = await waitForInflightOrReady(projectId, requestId);
      if (afterWait) return afterWait;
    }

    return bootProject(projectId, { allowEmpty: options?.allowEmpty, requestId });
  })().finally(() => {
    if (inflight.get(projectId) === run) inflight.delete(projectId);
  });

  inflight.set(projectId, run);
  return run;
}

export async function touchSandbox(projectId: string) {
  await prisma.project.updateMany({
    where: { id: projectId, deletedAt: null },
    data: { sandboxLastUsedAt: new Date() },
  });
}

export async function killSandbox(projectId: string) {
  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { sandboxId: true },
  });
  if (project?.sandboxId) {
    const named = sandboxManager.getProvider(project.sandboxId);
    if (named) {
      await sandboxManager.terminateSandbox(project.sandboxId);
    } else {
      try {
        const provider = SandboxFactory.create();
        const attached = await provider.reconnect(project.sandboxId);
        if (attached) await provider.terminate();
      } catch (error) {
        console.warn('[sandbox] kill reconnect failed', error);
      }
    }
  }
  const active = sandboxManager.getActiveProvider();
  const activeId = active?.getSandboxInfo()?.sandboxId;
  if (activeId && activeId === project?.sandboxId) {
    await sandboxManager.terminateSandbox(activeId);
  }
  await prisma.project.updateMany({
    where: { id: projectId, deletedAt: null },
    data: {
      sandboxStatus: 'NONE',
      sandboxId: null,
      previewUrl: null,
      sandboxStartedAt: null,
      sandboxLastUsedAt: null,
    },
  });
  bootSteps.delete(projectId);
  lastErrors.delete(projectId);
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
  const raw = Number.parseInt(process.env.SANDBOX_IDLE_MINUTES || '30', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 30;
}

/** Legacy no-project path. Still the only create entry besides ensureSandbox. */
export async function bootEphemeralSandbox(stack: string) {
  const definition = getStack(stack);
  const provider = SandboxFactory.create();
  const created = await provider.createSandbox(definition.id);
  await provider.setupViteApp(definition.id);
  bindLegacyGlobals(provider, definition.id);
  return {
    sandboxId: created.sandboxId,
    previewUrl: provider.getSandboxUrl() || created.url,
    stack: definition.id,
    provider: created.provider,
  };
}
