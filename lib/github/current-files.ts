/**
 * Reads a project's current files from `Project.lastCode` — the only durable
 * record of what was generated. It used to consult a `sandboxState.fileCache`
 * server-global first; the sandbox subsystem is gone and nothing writes that
 * global, so the branch was dead. It is not restored: both the settle path and
 * the "keep what was built" path spread a generation over what this returns,
 * and a cache winning over the row would resurrect deleted files.
 */

function normalizePath(path: string) {
  return path.replace(/^\.?\//, '');
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
  return filesFromLastCode(project.lastCode);
}
