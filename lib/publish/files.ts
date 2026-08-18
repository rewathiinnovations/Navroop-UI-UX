import { prisma } from '@/lib/db';
import { captureFileSnapshot, readSnapshot, SnapshotReadError } from '@/lib/checkpoints/snapshot';
import type { JobErrorCode } from '@/lib/jobs/types';
import { getLiveProvider } from '@/lib/sandbox/manager';
import { SandboxFactory } from '@/lib/sandbox/factory';
import { getStack, getStackListExtensions, type StackId } from '@/lib/stacks';
import { log } from '@/lib/logger';

export type PublishLiveFilesCode =
  | 'sandbox_list_failed'
  | 'sandbox_file_unreadable'
  | 'sandbox_status_unknown';

/**
 * A READY sandbox could not be listed, a listed file could not be read, or we
 * could not tell whether the sandbox was still there. Distinct from "no live
 * sandbox, use the checkpoint".
 */
export class PublishLiveFilesError extends Error {
  readonly code: PublishLiveFilesCode;

  constructor(code: PublishLiveFilesCode, message: string) {
    super(message);
    this.name = 'PublishLiveFilesError';
    this.code = code;
  }
}

export function publishJobErrorCode(error: unknown): JobErrorCode {
  if (error instanceof SnapshotReadError) return 'snapshot_unreadable';
  if (error instanceof PublishLiveFilesError) return error.code;
  return 'provider_error';
}

function publishListFailedMessage(detail: string): string {
  return (
    `We could not list the files in the live workspace (${detail}). ` +
    'Publish was not started from an older snapshot. Try again, or ask an admin to check the sandbox provider on /admin/sandbox-providers.'
  );
}

function publishFileUnreadableMessage(path: string, detail: string): string {
  return (
    `We could not read ${path} from the live workspace (${detail}). ` +
    'Publish was not started with an incomplete site. Try again, or ask an admin to check the sandbox provider on /admin/sandbox-providers.'
  );
}

function publishReconnectUncertainMessage(detail: string): string {
  return (
    `We could not tell whether the live workspace is still running (${detail}). ` +
    'Publish was not started from an older snapshot. Try again, or ask an admin to check the sandbox provider on /admin/sandbox-providers.'
  );
}

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.vercel']);

function toMap(entries: Array<{ path: string; content: string }>) {
  const files: Record<string, string> = {};
  for (const entry of entries) {
    const path = entry.path.replace(/^\.?\//, '');
    if (!path || path.startsWith('.git/')) continue;
    files[path] = entry.content;
  }
  return files;
}

function isPublishablePath(path: string, stack: StackId) {
  const normalized = path.replace(/\\/g, '/').replace(/^\.?\//, '');
  const parts = normalized.split('/');
  if (parts.some((part) => SKIP.has(part))) return false;
  const ext = normalized.includes('.') ? `.${normalized.split('.').pop()}` : '';
  const allowed = new Set([...getStackListExtensions(stack), '.json', '.md', '.svg', '.txt', '.mjs', '.cjs']);
  if (getStack(stack).configFiles.some((name) => normalized.endsWith(name))) return true;
  return allowed.has(ext.toLowerCase());
}

async function filesFromReadySandbox(project: {
  id: string;
  sandboxId: string;
  stack: string;
}): Promise<Record<string, string>> {
  let provider = getLiveProvider(project.sandboxId);
  if (!provider) {
    try {
      const created = SandboxFactory.create();
      const alive = await created.reconnect(project.sandboxId, 3_000);
      if (alive) provider = created;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      log.warn('publish.sandbox_reconnect_failed', {
        projectId: project.id,
        sandboxId: project.sandboxId,
        error: detail,
      });
      throw new PublishLiveFilesError('sandbox_status_unknown', publishReconnectUncertainMessage(detail));
    }
  }
  if (!provider) return {};

  let listed: string[];
  try {
    listed = await provider.listFiles();
  } catch (error) {
    if (error instanceof PublishLiveFilesError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    log.warn('publish.sandbox_list_failed', {
      projectId: project.id,
      sandboxId: project.sandboxId,
      error: detail,
    });
    throw new PublishLiveFilesError('sandbox_list_failed', publishListFailedMessage(detail));
  }

  const stack = getStack(project.stack).id;
  const files: Record<string, string> = {};
  for (const raw of listed) {
    const path = raw.replace(/^\.?\//, '');
    if (!isPublishablePath(path, stack)) continue;
    try {
      files[path] = await provider.readFile(path);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new PublishLiveFilesError(
        'sandbox_file_unreadable',
        publishFileUnreadableMessage(path, detail),
      );
    }
  }
  return files;
}

/**
 * Publish files from a READY sandbox, else the latest Checkpoint.
 * A failed listing or file read on a READY sandbox is a failure — not a cue
 * to ship the last snapshot. No live sandbox (or reconnect said it is gone)
 * still uses the checkpoint. Does not call ensureSandbox.
 */
export async function collectPublishFiles(projectId: string) {
  const project = await prisma.project.findFirst({
    where: { id: projectId },
    select: { id: true, sandboxId: true, sandboxStatus: true, stack: true, lastCode: true },
  });
  if (!project) {
    throw new Error('Project not found');
  }

  if (project.sandboxStatus === 'READY' && project.sandboxId) {
    const live = await filesFromReadySandbox({
      id: project.id,
      sandboxId: project.sandboxId,
      stack: project.stack,
    });
    if (Object.keys(live).length > 0) return live;
  }

  const latest = await prisma.checkpoint.findFirst({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    select: { snapshotKey: true, fileSnapshot: true },
  });
  // Propagates SnapshotReadError on purpose: a storage failure must not fall through
  // to captureFileSnapshot, which reads project.lastCode and would ship a stale site
  // under a green publish job. Do not add a catch that returns the fallback.
  const fromCheckpoint = latest ? await readSnapshot(latest) : [];
  if (fromCheckpoint.length > 0) return toMap(fromCheckpoint);

  const fallback = await captureFileSnapshot(projectId);
  if (fallback.length > 0) return toMap(fallback);

  throw new Error('This project has no files to publish');
}

export const PUBLISH_FILES_UNAVAILABLE =
  "We could not read this project's files from storage. Try again in a few minutes.";

/**
 * Whether the UI may offer Publish. `unavailable` is a storage failure — not "ready"
 * and not "no files". Callers must switch on `status`; do not coerce this to a boolean
 * (`'unavailable'` is truthy and would offer Publish).
 */
export type PublishableFilesState =
  | { status: 'ready' }
  | { status: 'empty' }
  | { status: 'unavailable'; reason: string };

export async function projectHasPublishableFiles(projectId: string): Promise<PublishableFilesState> {
  try {
    await collectPublishFiles(projectId);
    return { status: 'ready' };
  } catch (error) {
    if (error instanceof Error && error.message === 'This project has no files to publish') {
      return { status: 'empty' };
    }
    if (error instanceof Error && error.message === 'Project not found') {
      return { status: 'empty' };
    }
    if (error instanceof SnapshotReadError) {
      return { status: 'unavailable', reason: PUBLISH_FILES_UNAVAILABLE };
    }
    if (error instanceof PublishLiveFilesError) {
      return { status: 'unavailable', reason: error.message };
    }
    throw error;
  }
}
