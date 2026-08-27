/**
 * Tests must never write the object storage the running application serves.
 *
 * `lib/storage/index.ts` resolves its local root from `getSetting('storage.localDir')`
 * and falls back to `<cwd>/public/uploads` — the directory the dev server writes
 * preview builds and checkpoint snapshots into and `/uploads/...` serves from. That
 * fallback is the same shape as the `DATA_DIR` one that once let a fixture overwrite
 * the dev server's live `observability.json`, and `tests/setup/data-dir-guard.ts`
 * closed only that half. Until now the uploads half was held by nothing but per-file
 * discipline: three suites set `STORAGE_LOCAL_DIR` by hand, and a fourth that forgot
 * would have written the real thing.
 *
 * The second reason this exists is attribution, and it is why
 * `tests/setup/repo-write-guard.global.ts` imports this module too. That guard walks
 * the tree before and after the suite; a diff cannot say *who* wrote a file, and a
 * dev server runs from this checkout by design. Once every process that could be the
 * suite is pointed outside the repository, a write under `public/uploads` is
 * provably somebody else's and the guard can decline to attribute it — see
 * `resolveFencedPrefixes`. Importing it from the global setup runs the redirect
 * before the worker pool is forked, so the workers inherit this value rather than
 * each minting their own.
 *
 * Redirected whenever the configured root is unset *or* lands anywhere inside the
 * repository — not only when it equals `public/uploads`. Any in-repo root pollutes
 * the tree the guard watches, and `tests/unit/storage-fence.test.ts` fails from
 * inside a worker if the redirect ever stops arriving there.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isInsideRepo } from './repo-write-guard';

/**
 * Point `STORAGE_LOCAL_DIR` at a throwaway directory unless it already names one
 * outside the repository. Returns the directory it created, or null when it left an
 * existing choice alone, so the caller knows what there is to remove.
 */
export function fenceObjectStorage(root: string): string | null {
  const configured = process.env.STORAGE_LOCAL_DIR?.trim();
  if (configured && !isInsideRepo(root, configured)) return null;

  const fence = mkdtempSync(join(tmpdir(), 'navroop-test-uploads-'));
  process.env.STORAGE_LOCAL_DIR = fence;
  return fence;
}

// Applied on import, in whichever process imported it, and cleaned up by that same
// process on exit — the shape `data-dir-guard.ts` already uses. Nothing outside needs
// the path, so it stays module-local rather than becoming an export nobody reads.
const fence = fenceObjectStorage(process.cwd());

if (fence) {
  process.on('exit', () => {
    rmSync(fence, { recursive: true, force: true });
  });
}
