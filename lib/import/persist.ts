import { prisma } from '@/lib/db';
import { parseGeneratedFilesLenient } from '@/lib/generation/parse-files';
import { safeGeneratedFiles } from '@/lib/jobs/settle-generation';
import { log } from '@/lib/logger';
import { toLastCode } from '@/lib/projects/last-code';
import { bumpContentVersion } from '@/lib/projects/lock';
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
    log.warn('import.rejected_paths', {
      projectId: input.projectId,
      count: rejected.length,
      paths: rejected.slice(0, 10),
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

  await prisma.project.update({
    where: { id: input.projectId },
    // Unconditional COMPLETE, unlike settle's `phase !== 'COMPLETE'` guard: the
    // end state is identical and this path has no prior phase read to reuse.
    data: { lastCode: toLastCode(safe), phase: 'COMPLETE' },
  });
  await bumpContentVersion(input.projectId);
  return { fileCount };
}
