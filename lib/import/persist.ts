import { prisma } from '@/lib/db';
import {
  placeholderReplacements,
  replaceNeedImageTokens,
  sweepNeedImageTokens,
} from '@/lib/assets/need-image';
import { createCheckpointAfterGeneration } from '@/lib/checkpoints/actions';
import { parseGeneratedFilesLenient } from '@/lib/generation/parse-files';
import { safeGeneratedFiles, writeMergedSite } from '@/lib/jobs/settle-generation';
import { log, logError } from '@/lib/logger';
import { capturePreviewAfterGeneration } from '@/lib/preview/after-generation';
import { IMPORT_NO_FILES_MESSAGE } from './copy.ts';
import type { ImportMode } from './mode.ts';
import type { DesignTokens, ImportSection } from './types.ts';

export async function upsertImportSource(input: {
  projectId: string;
  sourceUrl: string;
  mode: ImportMode;
  designTokens?: DesignTokens | Record<string, never>;
  sections?: ImportSection[];
  capturedAt?: Date;
}) {
  const data = {
    sourceUrl: input.sourceUrl,
    mode: input.mode,
    designTokens: (input.designTokens ?? {}) as object,
    sections: (input.sections ?? []) as object,
    capturedAt: input.capturedAt ?? new Date(),
  };
  return prisma.importSource.upsert({
    where: { projectId: input.projectId },
    create: { projectId: input.projectId, ...data },
    update: data,
  });
}

/**
 * Store the imported site as the project's files — server-side, before the job
 * is allowed to succeed.
 *
 * A URL import never goes through /api/generate-ai-code-stream: the workspace
 * skips the generation stream when the import already produced `filesXml`, so
 * `settleStreamedGeneration` — the writer that owns `lastCode` for a streamed
 * build — never runs for this flow. Until this existed the browser's terminal
 * PATCH was the only thing that ever wrote an imported site down, and when that
 * PATCH stopped carrying `lastCode` ("the server owns the site") an import
 * finished SUCCEEDED with `lastCode` NULL: phase COMPLETE, an empty checkpoint
 * snapshotted from that null, and a blank project that stayed blank on reload.
 * Writing here covers the first run, "Retry import", and an import whose tab
 * closed mid-way.
 *
 * Replace rather than merge: the workspace applies an import with
 * `isEdit: false`, i.e. "make this project be that site". An import is not an
 * edit returning only the files it touched.
 */
export async function persistImportedSite(input: {
  projectId: string;
  /** Owner of the import, for image-credit accounting during fulfilment. */
  userId?: string | null;
  filesXml: string;
}): Promise<{ fileCount: number }> {
  // `filesXml` is the model's own `<file path="…">` text, one chunk per section
  // plus the composition, joined. The lenient reader is the one that survives a
  // chunk whose closing tag the model forgot, and it dedupes a path the
  // composition rewrote. It deliberately does not validate paths, so every key
  // goes through the same drop-and-continue gate settle uses before it can
  // become a project file key.
  const parsed = parseGeneratedFilesLenient(input.filesXml || '');
  const { safe, rejected } = safeGeneratedFiles(
    Object.fromEntries(parsed.map((file) => [file.path, file.content])),
  );
  if (rejected.length > 0) {
    log.warn('import.rejected_files', {
      projectId: input.projectId,
      count: rejected.length,
      paths: rejected.slice(0, 10).map((file) => file.path),
      codes: rejected.slice(0, 10).map((file) => file.code),
    });
  }

  const fileCount = Object.keys(safe).length;
  // Nothing parseable is not a successful import with an empty site — that is
  // exactly the blank-project failure above, just reached one step earlier. The
  // pipeline already says this sentence when the model returns no XML at all;
  // say the same one when the XML parses to nothing, so `importJobErrorCode`
  // files it as `import_failed` and not as an AI provider outage.
  if (fileCount === 0) {
    throw new Error(IMPORT_NO_FILES_MESSAGE);
  }

  // The import prompt shares BASE_RULES with the streamed path, so the model
  // asks for pictures the same way: `NEED_IMAGE: description | aspect`. The
  // streamed writer (`settleStreamedGeneration`) fulfils those tokens and then
  // sweeps the stragglers before anything is stored; this path used to do
  // neither, so the literal token shipped inside `src` attributes — in the
  // preview, the ZIP export and the published site. Same two steps, same
  // order, same never-fatal stance: a site with a placeholder panel still
  // beats losing a finished import to an image provider that is down.
  const resolved = await resolveImportImages({
    projectId: input.projectId,
    userId: input.userId,
    files: safe,
  });
  const swept = withoutRawImageTokens(resolved);

  const existing = await prisma.project.findUnique({
    where: { id: input.projectId },
    select: { lastCode: true, contentVersion: true, phase: true },
  });
  if (!existing) {
    throw new Error(`Project ${input.projectId} vanished while saving the imported site`);
  }

  // Same CAS as settle (F-044): write + contentVersion increment in one guarded
  // statement. Replace, not merge — an import is "make this project be that site".
  await writeMergedSite(
    input.projectId,
    swept,
    { lastCode: existing.lastCode, contentVersion: existing.contentVersion },
    [],
    'replace',
  );

  try {
    const previousPhase =
      existing.phase === 'PLANNING' ||
      existing.phase === 'BUILDING' ||
      existing.phase === 'COMPLETE'
        ? existing.phase
        : 'PLANNING';
    const checkpoint = await createCheckpointAfterGeneration(input.projectId, {
      previousPhase,
      sourceMessage: 'URL import',
    });
    if (checkpoint?.id) {
      const captured = await capturePreviewAfterGeneration(
        async () => {
          const { buildPreviewForProject } = await import('@/lib/preview/production');
          return buildPreviewForProject(input.projectId, checkpoint.id);
        },
        {
          projectId: input.projectId,
          checkpointId: checkpoint.id,
          checkpointCreatedAt: checkpoint.createdAt,
          findExisting: async () => {
            const { previewBuildTable } = await import('@/lib/preview/db');
            return previewBuildTable().findFirst({
              where: {
                projectId: input.projectId,
                checkpointId: checkpoint.id,
                status: { in: ['READY', 'BUILDING'] },
              },
              orderBy: { createdAt: 'desc' },
            });
          },
        },
      );
      if (captured.error) {
        logError('import.preview_after_generation_failed', captured.error, {
          projectId: input.projectId,
        });
      }
    }
  } catch (error) {
    // The site is in lastCode. A snapshot miss must not unwind a finished import.
    logError('import.checkpoint_after_generation_failed', error, { projectId: input.projectId });
  }

  return { fileCount };
}

/**
 * Same job as `resolveImages` in `lib/jobs/settle-generation.ts`: turn the
 * model's `NEED_IMAGE:` requests into real pictures, and never let a provider
 * failure sink a finished import. Dynamic import for the same reason settle
 * uses one — `@/lib/assets/fulfill` reaches providers and storage at import
 * time.
 */
async function resolveImportImages(input: {
  projectId: string;
  userId?: string | null;
  files: Record<string, string>;
}): Promise<Record<string, string>> {
  try {
    const { fulfillNeedImages } = await import('@/lib/assets/fulfill');
    const resolved = await fulfillNeedImages({
      projectId: input.projectId,
      userId: input.userId,
      files: Object.entries(input.files).map(([path, content]) => ({ path, content })),
    });
    return Object.fromEntries(resolved.map((file) => [file.path, file.content]));
  } catch (error) {
    log.warn('import.image_fulfilment_failed', {
      projectId: input.projectId,
      message: error instanceof Error ? error.message : String(error),
    });
    return input.files;
  }
}

/**
 * The floor the streamed path enforces, applied here too: no file is stored
 * with a raw `NEED_IMAGE: …` in it, whatever shape fulfilment's parser missed.
 * Placeholder swap only — this never spends image credits.
 */
function withoutRawImageTokens(files: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, content] of Object.entries(files)) {
    const leftovers = placeholderReplacements(content);
    const replaced = leftovers.length > 0 ? replaceNeedImageTokens(content, leftovers) : content;
    out[path] = sweepNeedImageTokens(replaced);
  }
  return out;
}
