import { prisma } from '@/lib/db';
import { getLiveProvider, killSandbox } from '@/lib/sandbox/manager';
import { upload } from '@/lib/storage';
import { adjustStorageBytes } from '@/lib/storage/usage';
import { log } from '@/lib/logger';
import { buildStaticPreview, PREVIEW_BUILD_TIMEOUT_MS } from './build';
import { previewBuildTable, setProjectPreviewFields } from './db';
import type { BuildStaticPreviewDeps, PreviewBuildStore, PreviewSandbox } from './types';

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function sandboxFromProvider(provider: {
  runCommand: (command: string) => Promise<{ exitCode: number; stdout: string; stderr: string; success?: boolean }>;
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, content: string) => Promise<void>;
  listFiles?: (directory?: string) => Promise<string[]>;
}): PreviewSandbox {
  return {
    async runCommand(command) {
      // The loser of the race must be cleared, or every build command leaves a
      // five-minute timer pending and keeps the event loop alive.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          provider.runCommand(command),
          new Promise<{ exitCode: number; stdout: string; stderr: string }>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Preview build timed out after 5 minutes')), PREVIEW_BUILD_TIMEOUT_MS);
            timer.unref?.();
          }),
        ]);
        return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    async listFiles(dir) {
      const target = dir === '.' ? '.' : dir;
      const listed = await provider.runCommand(
        `find ${shellQuote(target)} -type f ! -path '*/node_modules/*' ! -path '*/.git/*' ! -path '*/.next/*' 2>/dev/null || true`,
      );
      const fromFind = listed.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      if (fromFind.length > 0) return fromFind;
      if (typeof provider.listFiles === 'function') {
        return provider.listFiles(target);
      }
      return [];
    },
    async readFile(path) {
      const encoded = await provider.runCommand(
        `base64 -w 0 ${shellQuote(path)} 2>/dev/null || base64 ${shellQuote(path)}`,
      );
      if (encoded.exitCode === 0 && encoded.stdout.trim()) {
        return Buffer.from(encoded.stdout.trim(), 'base64');
      }
      return provider.readFile(path);
    },
    writeFile: (path, content) => provider.writeFile(path, content),
    removeFile: async (path) => {
      await provider.runCommand(`rm -f ${shellQuote(path)}`);
    },
  };
}

function prismaStore(): PreviewBuildStore {
  const table = previewBuildTable();
  return {
    async createBuilding(input) {
      return table.create({
        data: {
          projectId: input.projectId,
          checkpointId: input.checkpointId,
          status: 'BUILDING',
          mode: input.mode,
        },
      });
    },
    async markFailed(id, input) {
      await table.update({
        where: { id },
        data: {
          status: 'FAILED',
          mode: input.mode ?? 'LIVE_SANDBOX',
          error: input.error ?? null,
          buildLog: input.buildLog ?? null,
        },
      });
    },
    async markReady(id, input) {
      await table.update({
        where: { id },
        data: {
          status: 'READY',
          mode: input.mode,
          storagePrefix: input.storagePrefix,
          entryPath: input.entryPath,
          isSpa: input.isSpa,
          fileCount: input.fileCount,
          totalBytes: input.totalBytes,
          buildLog: input.buildLog ?? null,
          builtAt: new Date(),
          error: null,
        },
      });
    },
    setProjectPreview: setProjectPreviewFields,
  };
}

export async function createProductionPreviewDeps(projectId: string): Promise<BuildStaticPreviewDeps | null> {
  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { id: true, stack: true, sandboxId: true },
  });
  if (!project) return null;

  const provider = getLiveProvider(project.sandboxId);
  if (!provider) {
    log.info('preview.build_skipped_no_sandbox', { projectId });
    return null;
  }

  return {
    stack: project.stack,
    sandbox: sandboxFromProvider(provider),
    store: prismaStore(),
    storage: {
      async upload(input) {
        await upload(input.body, {
          key: input.key,
          contentType: input.contentType,
          contentEncoding: input.gzip ? 'gzip' : undefined,
        });
        await adjustStorageBytes(input.body.byteLength);
      },
    },
    killSandbox: async (projectId) => {
      await killSandbox(projectId);
    },
  };
}

/**
 * Build a static preview inside the current sandbox session, then kill it.
 * Never boots a sandbox just to build a preview.
 */
export async function buildPreviewForProject(projectId: string, checkpointId: string) {
  const deps = await createProductionPreviewDeps(projectId);
  if (!deps) {
    return { ok: false as const, skipped: true as const, reason: 'no_live_sandbox' };
  }
  return buildStaticPreview(projectId, checkpointId, deps);
}
