import { Readable } from 'node:stream';
import type { FileSnapshotEntry } from '@/lib/checkpoints/snapshot-store';
import { log } from '@/lib/logger';

type Archiver = {
  append: (source: string | Buffer, data: { name: string }) => unknown;
  finalize: () => Promise<void> | void;
} & NodeJS.ReadableStream;

/**
 * Stream a zip with archiver. Do not buffer the whole archive in memory.
 * Exports do not consume credits — zipping is a download, not generation.
 */
export async function streamExportZip(files: FileSnapshotEntry[], readme: string) {
  const mod = await import('archiver');
  const create = (mod as { default?: (format: string, opts?: object) => Archiver }).default;
  if (!create) {
    throw new Error('archiver is not installed — ask the server agent to stop :3000, then pnpm add archiver');
  }

  const archive = create('zip', { zlib: { level: 9 } });
  archive.append(readme, { name: 'README.md' });
  for (const file of files) {
    const name = file.path.replace(/\\/g, '/').replace(/^\.\//, '');
    if (name === 'README.md') continue;
    archive.append(file.content, { name });
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
