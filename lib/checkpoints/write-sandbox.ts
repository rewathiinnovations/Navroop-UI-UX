import '@/types/sandbox';
import { sandboxManager } from '@/lib/sandbox/sandbox-manager';
import type { FileSnapshotEntry } from './snapshot';

type WriteSnapshotFn = (projectId: string, files: FileSnapshotEntry[]) => Promise<void>;

let writeSnapshotOverride: WriteSnapshotFn | null = null;

/** Acceptance-script seam. Production writes through the apply/write provider. */
export function setWriteSnapshot(fn: WriteSnapshotFn | null) {
  writeSnapshotOverride = fn;
}

function activeProvider(sandboxId?: string | null) {
  if (sandboxId) {
    const named = sandboxManager.getProvider(sandboxId);
    if (named) return named;
  }
  return (
    sandboxManager.getActiveProvider() ||
    (globalThis as { activeSandboxProvider?: { writeFile?: (path: string, content: string) => Promise<void>; runCommand?: (cmd: string) => Promise<unknown> } })
      .activeSandboxProvider ||
    null
  );
}

function ensureFileCache(sandboxId?: string | null) {
  if (!globalThis.sandboxState) {
    globalThis.sandboxState = {
      fileCache: { files: {}, lastSync: Date.now(), sandboxId: sandboxId ?? '' },
      sandbox: null,
      sandboxData: null,
    };
  } else if (!globalThis.sandboxState.fileCache) {
    globalThis.sandboxState.fileCache = {
      files: {},
      lastSync: Date.now(),
      sandboxId: sandboxId ?? '',
    };
  }
  return globalThis.sandboxState.fileCache!;
}

/** Same writeFile + fileCache update apply-ai-code-stream uses. */
export async function writeSnapshotToSandbox(
  projectId: string,
  files: FileSnapshotEntry[],
  sandboxId?: string | null,
) {
  if (writeSnapshotOverride) {
    await writeSnapshotOverride(projectId, files);
    return;
  }

  const provider = activeProvider(sandboxId);
  if (!provider?.writeFile) {
    throw new Error('No active sandbox to write files');
  }

  const cache = ensureFileCache(sandboxId);
  for (const file of files) {
    const path = file.path.replace(/^\.?\//, '');
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    if (dir && typeof provider.runCommand === 'function') {
      await provider.runCommand(`mkdir -p ${dir}`);
    }
    await provider.writeFile(path, file.content);
    cache.files[path] = { content: file.content, lastModified: Date.now() };
  }
  cache.lastSync = Date.now();
}
