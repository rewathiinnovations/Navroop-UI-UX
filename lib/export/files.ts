import type { FileSnapshotEntry } from '@/lib/checkpoints/snapshot-store';

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

export function shouldExcludeExportPath(path: string) {
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
