/**
 * Reuses Open Lovable's existing current-files sources:
 * Code tab / get-sandbox-files cache (`sandboxState.fileCache`) and `Project.lastCode`.
 * Does not walk the sandbox filesystem again.
 */

type CachedFile = { content?: string } | string;

function normalizePath(path: string) {
  return path.replace(/^\.?\//, '');
}

function filesFromCache(): Record<string, string> {
  const cache = (globalThis as { sandboxState?: { fileCache?: { files?: Record<string, CachedFile> } } })
    .sandboxState?.fileCache?.files;
  if (!cache) return {};
  const out: Record<string, string> = {};
  for (const [path, value] of Object.entries(cache)) {
    const content = typeof value === 'string' ? value : value?.content;
    if (typeof content === 'string') {
      out[normalizePath(path)] = content;
    }
  }
  return out;
}

function filesFromLastCode(lastCode: string | null | undefined): Record<string, string> {
  if (!lastCode?.trim()) return {};

  const tagged: Record<string, string> = {};
  const fileRegex = /<file path="([^"]+)">([\s\S]*?)(?:<\/file>|$)/g;
  let match: RegExpExecArray | null;
  while ((match = fileRegex.exec(lastCode)) !== null) {
    tagged[normalizePath(match[1])] = match[2].trim();
  }
  if (Object.keys(tagged).length > 0) return tagged;

  const trimmed = lastCode.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const out: Record<string, string> = {};
        for (const [path, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof value === 'string') out[normalizePath(path)] = value;
        }
        if (Object.keys(out).length > 0) return out;
      }
    } catch {
      // not a file map
    }
  }

  return { 'src/App.jsx': lastCode };
}

export function getCurrentProjectFiles(project: { lastCode?: string | null }) {
  const cached = filesFromCache();
  if (Object.keys(cached).length > 0) return cached;
  return filesFromLastCode(project.lastCode);
}
