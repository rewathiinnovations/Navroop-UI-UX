import { CHARS_PER_TOKEN, estimateTokens } from '@/lib/generation/token-estimate';

/** Default ~30k-token cap for follow-up file context. Override with NAVROOP_FILE_CONTEXT_TOKEN_CAP. */
export const DEFAULT_FILE_CONTEXT_TOKEN_CAP = 30_000;

export function fileContextTokenCap(): number {
  const raw = Number(process.env.NAVROOP_FILE_CONTEXT_TOKEN_CAP);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_FILE_CONTEXT_TOKEN_CAP;
}

export type FileContextSource = {
  content: string;
  lastModified?: number;
};

export type SelectiveFileContext = {
  formatted: string;
  fullPaths: string[];
  pathOnly: string[];
  estimatedTokens: number;
};

function normalizeFiles(
  files: Record<string, FileContextSource | string>,
): Array<{ path: string; content: string; lastModified: number }> {
  return Object.entries(files)
    .map(([path, value]) => {
      if (typeof value === 'string') {
        return { path, content: value, lastModified: 0 };
      }
      return {
        path,
        content: value.content ?? '',
        lastModified: value.lastModified ?? 0,
      };
    })
    .filter((file) => file.path && !file.path.includes('node_modules'));
}

function referencedPaths(
  userMessage: string,
  paths: string[],
  extra: string[] = [],
): Set<string> {
  const matched = new Set<string>();
  const lower = userMessage.toLowerCase();
  const tokens = lower.split(/[^a-z0-9._\-/]+/).filter((token) => token.length >= 3);

  for (const path of paths) {
    const normalized = path.replace(/\\/g, '/');
    const base = normalized.split('/').pop() ?? normalized;
    const stem = base.replace(/\.[^.]+$/, '');
    const haystack = normalized.toLowerCase();
    if (
      extra.some((item) => haystack.endsWith(item.replace(/\\/g, '/').toLowerCase()) || haystack === item.toLowerCase())
    ) {
      matched.add(path);
      continue;
    }
    if (lower.includes(haystack) || lower.includes(base.toLowerCase()) || lower.includes(stem.toLowerCase())) {
      matched.add(path);
      continue;
    }
    if (tokens.some((token) => haystack.includes(token) && token.length >= 4)) {
      matched.add(path);
    }
  }
  return matched;
}

/**
 * Full contents for files the user named + recently modified.
 * Path-only listing for the rest. Caps estimated tokens.
 */
export function selectFileContext(input: {
  files: Record<string, FileContextSource | string>;
  userMessage: string;
  recentlyModifiedPaths?: string[];
  primaryPaths?: string[];
  tokenCap?: number;
}): SelectiveFileContext {
  const cap = input.tokenCap ?? fileContextTokenCap();
  const entries = normalizeFiles(input.files);
  const paths = entries.map((file) => file.path);

  const mustFull = referencedPaths(input.userMessage, paths, [
    ...(input.primaryPaths ?? []),
    ...(input.recentlyModifiedPaths ?? []),
  ]);

  const recentSorted = [...entries].sort((a, b) => b.lastModified - a.lastModified);
  for (const file of recentSorted.slice(0, 8)) {
    if (file.lastModified > 0) mustFull.add(file.path);
  }

  const full: typeof entries = [];
  const pathOnly: string[] = [];
  let used = 0;

  const prioritized = [
    ...entries.filter((file) => mustFull.has(file.path)),
    ...entries.filter((file) => !mustFull.has(file.path)),
  ];

  for (const file of prioritized) {
    const block = `<file path="${file.path}">\n${file.content}\n</file>`;
    const cost = estimateTokens(block);
    const preferFull = mustFull.has(file.path);
    if (preferFull && used + cost <= cap) {
      full.push(file);
      used += cost;
    } else if (preferFull && full.length === 0 && cost > cap) {
      const budget = Math.max(cap * CHARS_PER_TOKEN - 80, 500);
      const sliced = file.content.slice(0, budget);
      full.push({ ...file, content: `${sliced}\n/* truncated to token cap */` });
      used = cap;
    } else {
      pathOnly.push(file.path);
    }
  }

  const lines: string[] = [];
  if (pathOnly.length) {
    lines.push('### File list (path only — request a path to load contents)');
    for (const path of pathOnly) {
      lines.push(`- ${path}`);
    }
  }
  if (full.length) {
    lines.push('\n### File contents (referenced + recently modified only)');
    for (const file of full) {
      lines.push(`\n<file path="${file.path}">\n${file.content}\n</file>`);
    }
  }

  const formatted = lines.join('\n');
  return {
    formatted,
    fullPaths: full.map((file) => file.path),
    pathOnly,
    estimatedTokens: estimateTokens(formatted),
  };
}
