import { Readable } from 'node:stream';
import type { FileSnapshotEntry } from '@/lib/checkpoints/snapshot-store';
import { sanitizeGenerationPath } from '@/lib/generation/parse-files';
import { log } from '@/lib/logger';

/**
 * Stream a zip with archiver. Do not buffer the whole archive in memory.
 * Exports do not consume credits — zipping is a download, not generation.
 *
 * The module is imported dynamically so a missing install fails this one
 * download rather than the build. Its shape comes from `types/archiver.d.ts`,
 * not from a local cast: the cast this file used to carry was over a module
 * declared as bare `any`, so nothing here was checked at all (F-767).
 */
export async function streamExportZip(files: FileSnapshotEntry[], readme: string) {
  const mod = await import('archiver');
  const create = mod.default;
  if (!create) {
    throw new Error(
      'archiver is not installed — ask the server agent to stop :3000, then pnpm add archiver',
    );
  }

  const archive = create('zip', { zlib: { level: 9 } });
  archive.append(readme, { name: 'README.md' });
  for (const file of files) {
    // filterExportFiles already drops these, but streamExportZip is exported on its
    // own: the entry name is proven safe where it is written, not upstream, so no
    // future caller can ship a `../../..` entry that unzips over the user's files.
    const safe = sanitizeGenerationPath(file.path);
    if (!safe.ok) {
      log.warn('export.archive_skipped_unsafe_path', { path: file.path, code: safe.code });
      continue;
    }
    if (safe.path === 'README.md') continue;
    archive.append(file.content, { name: safe.path });
  }
  const body = Readable.toWeb(Readable.from(archive)) as ReadableStream<Uint8Array>;
  // finalize() is intentionally not awaited so the zip streams, but an unhandled
  // rejection here would take down the process. Surface it on the stream instead.
  Promise.resolve(archive.finalize()).catch((error) => {
    log.error('export.archive_finalize_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    archive.emit('error', error instanceof Error ? error : new Error(String(error)));
  });
  return body;
}
