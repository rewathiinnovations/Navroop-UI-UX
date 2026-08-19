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

export function filterExportFiles(files: FileSnapshotEntry[]): FileSnapshotEntry[] {
  return files.filter((file) => {
    if (shouldExcludeExportPath(file.path)) return false;
    return Buffer.byteLength(file.content, 'utf8') <= EXPORT_MAX_FILE_BYTES;
  });
}
