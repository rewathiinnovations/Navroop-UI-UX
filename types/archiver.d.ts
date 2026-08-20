/**
 * `archiver@7` ships no types of its own. This file used to be a bare
 * `declare module 'archiver';`, which made the entire module `any` — no
 * compile-time check at all on the one code path that streams bytes to a user's
 * browser (`lib/export/archive.ts`), which then hand-wrote its own minimal
 * `Archiver` shape and cast to it (F-767).
 *
 * This declares the surface that path actually uses, so the cast is gone and a
 * drift from the real API is a compile error. `@types/archiver` on npm is the
 * complete definition; adopting it needs a dependency install, which cannot be
 * done while the dev servers hold locked binaries — when it lands, delete this
 * file and the `import('archiver')` fallback message in `archive.ts`.
 */
declare module 'archiver' {
  import type { Readable } from 'node:stream';

  interface ArchiverEntryData {
    name: string;
  }

  interface Archiver extends Readable {
    append(source: string | Buffer | Readable, data: ArchiverEntryData): this;
    finalize(): Promise<void>;
  }

  interface ArchiverOptions {
    zlib?: { level?: number };
  }

  function archiver(format: 'zip' | 'tar', options?: ArchiverOptions): Archiver;

  export default archiver;
  export type { Archiver, ArchiverOptions };
}
