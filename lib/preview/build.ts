/**
 * Builds the served static preview for a checkpoint.
 *
 * The build runs here, in this process, with esbuild — the same bundler and
 * the same virtual filesystem the browser preview uses, so a published build
 * matches what the user approved. It used to shell out to a sandbox VM.
 */
import { gzipSync } from 'node:zlib';
import { shouldExcludeExportPath } from '@/lib/export/files';
import { sanitizeGenerationPath } from '@/lib/generation/parse-files';
import { log } from '@/lib/logger';
import { buildStaticSite } from './server-bundle';
import { contentTypeForPath, shouldGzipPreviewPath } from './mime';
import { PREVIEW_TOO_LARGE } from './labels';
import type { BuildStaticPreviewDeps, BuildStaticPreviewResult } from './types';

export const PREVIEW_MAX_BYTES = 200 * 1024 * 1024;
export const PREVIEW_MAX_FILES = 5000;

/**
 * A failed build is not a build, so it never becomes — and never unseats — the
 * project's active build. `fail()` used to null `activePreviewBuildId` (guarded
 * by `fromBuildId`), which at best was a no-op and at worst cleared the last
 * good build out from under a serving `/preview-static`, while the status read
 * still advertised a URL derived from the newest READY build (F-147). The rule
 * is now: only `markReady` touches the pointer.
 *
 * `storagePrefix` is recorded on the row even on failure so the pruner can find
 * whatever a half-finished upload left behind (F-146) — the row is the only
 * thing that names those objects.
 */
async function fail(
  deps: BuildStaticPreviewDeps,
  buildId: string,
  error: string,
  input: { buildLog?: string | null; storagePrefix?: string | null } = {},
): Promise<BuildStaticPreviewResult> {
  await deps.store.markFailed(buildId, {
    error,
    buildLog: input.buildLog ?? null,
    storagePrefix: input.storagePrefix ?? null,
    mode: 'STATIC',
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

  const built = await buildStaticSite(deps.stack, deps.files, deps.designDirection);
  if (!built.ok) {
    return fail(deps, created.id, 'Preview could not be built', { buildLog: built.error });
  }

  // Each path here is model output (Project.lastCode, via the static-HTML branch of
  // buildStaticSite, which ships the project files as-is) and becomes a storage key
  // below. A `..` segment used to write outside the uploads root on the local
  // driver; the export filter keeps `.env` and other secrets out of a prefix that
  // anyone holding the preview token can fetch.
  const files: { relative: string; body: Buffer }[] = [];
  const rejected: string[] = [];
  for (const [rawPath, content] of Object.entries(built.files)) {
    const safe = sanitizeGenerationPath(rawPath);
    if (!safe.ok || shouldExcludeExportPath(safe.path)) {
      rejected.push(rawPath);
      continue;
    }
    files.push({
      relative: safe.path,
      body: Buffer.from(content, 'utf8'),
    });
  }
  if (rejected.length > 0) {
    log.warn('preview.build_rejected_files', {
      projectId,
      buildId: created.id,
      count: rejected.length,
      paths: rejected.slice(0, 10),
    });
  }

  const totalBytes = files.reduce((sum, file) => sum + file.body.byteLength, 0);
  if (files.length > PREVIEW_MAX_FILES || totalBytes > PREVIEW_MAX_BYTES) {
    return fail(deps, created.id, PREVIEW_TOO_LARGE);
  }

  const storagePrefix = `previews/${projectId}/${created.id}`;
  try {
    for (const file of files) {
      const gzip = shouldGzipPreviewPath(file.relative);
      await deps.storage.upload({
        key: `${storagePrefix}/${file.relative}`,
        body: gzip ? gzipSync(file.body) : file.body,
        contentType: contentTypeForPath(file.relative),
        gzip,
      });
    }
  } catch (error) {
    // A throw part-way through the upload used to propagate out of here, leaving
    // the row BUILDING forever and its objects orphaned (F-146). Fail the row,
    // naming the prefix so the pruner can reclaim whatever landed.
    log.error('preview.build_upload_failed', {
      projectId,
      buildId: created.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return fail(deps, created.id, 'Preview could not be stored', { storagePrefix });
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
