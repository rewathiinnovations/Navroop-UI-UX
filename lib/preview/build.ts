/**
 * Preview mode and deploy mode are independent. A static preview may still
 * publish as a Node app on Coolify.
 */
import { gzipSync } from 'node:zlib';
import { getStack } from '@/lib/stacks';
import { injectInspectorIntoHtml } from './inject';
import { PREVIEW_TOO_LARGE } from './labels';
import { contentTypeForPath, shouldGzipPreviewPath } from './mime';
import { findNextConfigPath, isNextExportFailure, withTemporaryNextExport } from './next-export';
import type { BuildStaticPreviewDeps, BuildStaticPreviewResult, PreviewMode } from './types';

export const PREVIEW_MAX_BYTES = 200 * 1024 * 1024;
export const PREVIEW_MAX_FILES = 5000;
export const PREVIEW_BUILD_TIMEOUT_MS = 5 * 60 * 1000;

const SKIP_DIR = /(?:^|\/)(node_modules|\.git|\.next|\.navroop)(?:\/|$)/;

function logTail(stdout: string, stderr: string) {
  const combined = [stdout, stderr].filter(Boolean).join('\n').trim();
  return combined.slice(-8000);
}

function asBuffer(content: string | Buffer) {
  return Buffer.isBuffer(content) ? content : Buffer.from(content);
}

function normalizeListed(dir: string, path: string) {
  const relative = path.replace(/^\.?\//, '');
  const prefix = dir.replace(/^\.\/?/, '').replace(/\/+$/, '');
  if (!prefix || prefix === '.') return relative;
  if (relative === prefix || relative.startsWith(`${prefix}/`)) {
    return relative.slice(prefix.length).replace(/^\//, '');
  }
  return relative;
}

async function runBuildCommand(deps: BuildStaticPreviewDeps, command: string | null) {
  if (!command) return { exitCode: 0, stdout: '', stderr: '' };
  return deps.sandbox.runCommand(command);
}

async function collectOutputFiles(deps: BuildStaticPreviewDeps, outputDir: string) {
  const listed = await deps.sandbox.listFiles(outputDir);
  const files: { relative: string; body: Buffer }[] = [];
  for (const raw of listed) {
    const relative = normalizeListed(outputDir, raw);
    if (!relative || SKIP_DIR.test(relative)) continue;
    const sandboxPath = outputDir === '.' ? relative : `${outputDir.replace(/\/+$/, '')}/${relative}`;
    const body = asBuffer(await deps.sandbox.readFile(sandboxPath));
    files.push({ relative, body });
  }
  return files;
}

async function failLive(
  deps: BuildStaticPreviewDeps,
  projectId: string,
  buildId: string,
  error: string,
  buildLog?: string | null,
): Promise<BuildStaticPreviewResult> {
  const mode: PreviewMode = 'LIVE_SANDBOX';
  await deps.store.markFailed(buildId, { error, buildLog, mode });
  await deps.store.setProjectPreview(projectId, {
    previewMode: mode,
    activePreviewBuildId: null,
    fromBuildId: buildId,
  });
  return { ok: false, mode, buildId, error };
}

export async function buildStaticPreview(
  projectId: string,
  checkpointId: string,
  deps: BuildStaticPreviewDeps,
): Promise<BuildStaticPreviewResult> {
  const stack = getStack(deps.stack);
  const created = await deps.store.createBuilding({
    projectId,
    checkpointId,
    mode: 'STATIC',
  });

  let commandResult = { exitCode: 0, stdout: '', stderr: '' };
  try {
    if (stack.id === 'NEXTJS') {
      const configPath = await findNextConfigPath(deps.sandbox.listFiles);
      if (configPath) {
        commandResult = await withTemporaryNextExport(deps.sandbox, configPath, () =>
          runBuildCommand(deps, stack.previewBuildCommand),
        );
      } else {
        commandResult = await runBuildCommand(deps, stack.previewBuildCommand);
      }
    } else {
      commandResult = await runBuildCommand(deps, stack.previewBuildCommand);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Preview build failed';
    return failLive(deps, projectId, created.id, message, message);
  }

  const log = logTail(commandResult.stdout, commandResult.stderr);
  if (commandResult.exitCode !== 0) {
    const exportFailed = stack.id === 'NEXTJS' && isNextExportFailure(log);
    const error = exportFailed
      ? 'Static export failed. Live sandbox preview is required.'
      : 'Preview could not be built';
    return failLive(deps, projectId, created.id, error, log);
  }

  const files = await collectOutputFiles(deps, stack.previewOutputDir);
  const totalBytes = files.reduce((sum, file) => sum + file.body.byteLength, 0);
  if (files.length > PREVIEW_MAX_FILES || totalBytes > PREVIEW_MAX_BYTES) {
    return failLive(deps, projectId, created.id, PREVIEW_TOO_LARGE, log);
  }

  const storagePrefix = `previews/${projectId}/${created.id}`;
  for (const file of files) {
    let body = file.body;
    if (/\.html?$/i.test(file.relative)) {
      body = Buffer.from(injectInspectorIntoHtml(body.toString('utf8')));
    }
    const gzip = shouldGzipPreviewPath(file.relative);
    await deps.storage.upload({
      key: `${storagePrefix}/${file.relative}`,
      body: gzip ? gzipSync(body) : body,
      contentType: contentTypeForPath(file.relative),
      gzip,
    });
  }

  await deps.store.markReady(created.id, {
    storagePrefix,
    entryPath: 'index.html',
    isSpa: stack.spaFallback,
    fileCount: files.length,
    totalBytes,
    buildLog: log || null,
    mode: 'STATIC',
  });
  await deps.store.setProjectPreview(projectId, {
    previewMode: 'STATIC',
    activePreviewBuildId: created.id,
    fromBuildId: created.id,
  });
  await deps.killSandbox(projectId);
  return { ok: true, mode: 'STATIC', buildId: created.id };
}
