/**
 * Builds the served static preview for a checkpoint.
 *
 * The build runs here, in this process, with esbuild — the same bundler and
 * the same virtual filesystem the browser preview uses, so a published build
 * matches what the user approved. It used to shell out to a sandbox VM.
 */
import { gzipSync } from 'node:zlib';
import { buildStaticSite } from './server-bundle';
import { injectInspectorIntoHtml } from './inject';
import { contentTypeForPath, shouldGzipPreviewPath } from './mime';
import { PREVIEW_TOO_LARGE } from './labels';
import type { BuildStaticPreviewDeps, BuildStaticPreviewResult } from './types';

export const PREVIEW_MAX_BYTES = 200 * 1024 * 1024;
export const PREVIEW_MAX_FILES = 5000;

async function fail(
  deps: BuildStaticPreviewDeps,
  projectId: string,
  buildId: string,
  error: string,
  buildLog?: string | null,
): Promise<BuildStaticPreviewResult> {
  await deps.store.markFailed(buildId, { error, buildLog, mode: 'STATIC' });
  await deps.store.setProjectPreview(projectId, {
    previewMode: 'STATIC',
    activePreviewBuildId: null,
    fromBuildId: buildId,
  });
  return { ok: false, buildId, error };
}

export async function buildStaticPreview(
  projectId: string,
  checkpointId: string,
  deps: BuildStaticPreviewDeps,
): Promise<BuildStaticPreviewResult> {
  const created = await deps.store.createBuilding({
    projectId,
    checkpointId,
    mode: 'STATIC',
  });

  const built = await buildStaticSite(deps.stack, deps.files);
  if (!built.ok) {
    return fail(deps, projectId, created.id, 'Preview could not be built', built.error);
  }

  const files = Object.entries(built.files).map(([relative, content]) => ({
    relative,
    body: Buffer.from(
      /\.html?$/i.test(relative) ? injectInspectorIntoHtml(content) : content,
      'utf8',
    ),
  }));

  const totalBytes = files.reduce((sum, file) => sum + file.body.byteLength, 0);
  if (files.length > PREVIEW_MAX_FILES || totalBytes > PREVIEW_MAX_BYTES) {
    return fail(deps, projectId, created.id, PREVIEW_TOO_LARGE, null);
  }

  const storagePrefix = `previews/${projectId}/${created.id}`;
  for (const file of files) {
    const gzip = shouldGzipPreviewPath(file.relative);
    await deps.storage.upload({
      key: `${storagePrefix}/${file.relative}`,
      body: gzip ? gzipSync(file.body) : file.body,
      contentType: contentTypeForPath(file.relative),
      gzip,
    });
  }

  await deps.store.markReady(created.id, {
    storagePrefix,
    entryPath: 'index.html',
    // Everything renders from one document, so any path must serve index.html.
    isSpa: true,
    fileCount: files.length,
    totalBytes,
    buildLog: null,
    mode: 'STATIC',
  });
  await deps.store.setProjectPreview(projectId, {
    previewMode: 'STATIC',
    activePreviewBuildId: created.id,
    fromBuildId: created.id,
  });
  return { ok: true, mode: 'STATIC', buildId: created.id };
}
