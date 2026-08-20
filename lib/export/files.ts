import type { FileSnapshotEntry } from '@/lib/checkpoints/snapshot-store';
import { sanitizeGenerationPath } from '@/lib/generation/parse-files';

export const EXPORT_MAX_FILE_BYTES = 10 * 1024 * 1024;

function normalizePath(path: string) {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

function pathSegments(path: string) {
  return normalizePath(path).split('/').filter(Boolean);
}

function isEnvFile(path: string) {
  const name = pathSegments(path).at(-1) || '';
  return name === '.env' || name.startsWith('.env.');
}

/**
 * Paths come from model output, so a fence path of `../../../.ssh/authorized_keys`
 * would become a ZIP entry with that literal name and write outside the folder the
 * user extracts into — zip-slip. Rejecting here covers the archive and every other
 * consumer of the filter, not just today's caller.
 */
export function shouldExcludeExportPath(path: string) {
  if (!sanitizeGenerationPath(path).ok) return true;
  const segments = pathSegments(path);
  if (segments.includes('node_modules') || segments.includes('.git')) return true;
  return isEnvFile(path);
}

export type OversizedExportFile = { path: string; bytes: number };

/**
 * Splits, rather than silently dropping.
 *
 * The three structural exclusions (`node_modules`, `.git`, `.env`, plus zip-slip paths) are
 * named in the README the user receives, so they need no per-file record — but the 10 MB size
 * rule was not, and a file simply vanished from the download (F-796). Oversized paths come
 * back so the README and the response header can say what is missing.
 */
export function filterExportFiles(files: FileSnapshotEntry[]): {
  files: FileSnapshotEntry[];
  oversized: OversizedExportFile[];
} {
  const kept: FileSnapshotEntry[] = [];
  const oversized: OversizedExportFile[] = [];
  for (const file of files) {
    if (shouldExcludeExportPath(file.path)) continue;
    const bytes = Buffer.byteLength(file.content, 'utf8');
    if (bytes > EXPORT_MAX_FILE_BYTES) oversized.push({ path: file.path, bytes });
    else kept.push(file);
  }
  return { files: kept, oversized };
}
