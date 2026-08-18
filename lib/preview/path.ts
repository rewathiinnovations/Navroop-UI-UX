export function resolvePreviewObjectPath(
  requestPath: string,
  options: { spaFallback: boolean; entryPath: string },
) {
  const trimmed = requestPath.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!trimmed || trimmed === '.') return options.entryPath;

  const last = trimmed.split('/').pop() || trimmed;
  const hasExtension = last.includes('.');
  if (!hasExtension && options.spaFallback) return options.entryPath;
  return trimmed;
}
