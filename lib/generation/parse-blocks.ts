/**
 * Parses a model reply into files, using llamacoder's fenced-block contract:
 *
 *     ```tsx{path=src/App.tsx}
 *     // file content
 *     ```
 *
 * Ported from llamacoder's lib/utils.ts. The tolerances here are not
 * hypothetical — each one corresponds to a way real models break the format
 * (glued fences, the attribute on the next line, a split closing brace,
 * thinking blocks) that otherwise silently drops files.
 */

export type ParsedBlock = {
  path: string;
  code: string;
  language: string;
};

/** Remove <thinking>/<think>/<analysis> planning artifacts. */
export function stripThinkingBlocks(markdown: string): string {
  let out = markdown.replace(
    /<(?:thinking|think|analysis)>[\s\S]*?<\/(?:thinking|think|analysis)>/gi,
    '',
  );
  const unterminated = out.search(/<(?:thinking|think|analysis)>/i);
  if (unterminated !== -1) out = out.slice(0, unterminated);
  return out;
}

/** Strip planning preamble before the first fence. */
export function sanitizeAssistantOutput(markdown: string): string {
  let out = stripThinkingBlocks(markdown);
  const firstFence = out.indexOf('```');
  const preamble = firstFence === -1 ? out : out.slice(0, firstFence);
  if (
    firstFence > 0 &&
    /(?:^|\n)\s*(?:thinking process|implementation plan|reasoning|analysis)\s*:/i.test(preamble)
  ) {
    out = out.slice(firstFence);
  }
  return out.trimStart();
}

/**
 * Models sometimes glue an opening fence onto the previous prose line, or put
 * the first line of code on the header line. Both make the line-anchored fence
 * scan miss the block entirely, so the file is lost and the code renders as
 * prose. Only `{path=...}` openers are touched.
 */
export function normalizeFenceOpeners(markdown: string): string {
  const pathFence = String.raw`\x60\x60\x60[^\n\x60]*\{path=[^}\n]*\}`;
  return markdown
    .replace(new RegExp(String.raw`([^\n])(${pathFence})`, 'g'), '$1\n$2')
    .replace(new RegExp(String.raw`(${pathFence})[ \t]+(?=\S)`, 'g'), '$1\n');
}

function parseFenceHeader(tag: string): { language: string; path: string | null } {
  const raw = tag || '';
  const langMatch = raw.match(/^([A-Za-z0-9]+)/);
  const language = langMatch ? langMatch[1] : 'text';
  const pathMatch = raw.match(/(?:\{\s*)?path\s*=\s*([^}\s]+)(?:\s*\})?/);
  const filenameMatch = raw.match(/(?:\{\s*)?filename\s*=\s*([^}\s]+)(?:\s*\})?/);
  const path = pathMatch ? pathMatch[1] : filenameMatch ? filenameMatch[1] : null;
  return { language, path };
}

/** Some models put `{path=...}` on the line after the opener instead of on it. */
function parseAttributeLine(line: string): string | null {
  const trimmed = (line || '').trim();
  if (!trimmed) return null;
  const pathMatch = trimmed.match(/^\{?\s*path\s*=\s*([^}\s]+)\s*\}?$/);
  if (pathMatch) return pathMatch[1];
  const filenameMatch = trimmed.match(/^\{?\s*filename\s*=\s*([^}\s]+)\s*\}?$/);
  if (filenameMatch) return filenameMatch[1];
  return null;
}

/**
 * A path-bearing header whose closing brace landed on the first code line:
 *     ```tsx{path=src/data.ts
 *     }
 * The path still parses, but that orphan brace is not code.
 */
function stripSplitFenceAttributeBrace(fenceTag: string, code: string) {
  const hasSplitPathBrace =
    /\{\s*(path|filename)\s*=[^}\n]*$/i.test(fenceTag) && code.split('\n', 1)[0]?.trim() === '}';
  if (!hasSplitPathBrace) return code;
  const newlineIndex = code.indexOf('\n');
  return newlineIndex === -1 ? '' : code.slice(newlineIndex + 1);
}

function extensionForLanguage(language: string): string {
  switch (language.toLowerCase()) {
    case 'tsx':
      return 'tsx';
    case 'ts':
    case 'typescript':
      return 'ts';
    case 'jsx':
      return 'jsx';
    case 'js':
    case 'javascript':
      return 'js';
    case 'css':
      return 'css';
    case 'html':
      return 'html';
    case 'json':
      return 'json';
    default:
      return 'txt';
  }
}

function resolveBlockPath(fenceTag: string, code: string): ParsedBlock {
  const header = parseFenceHeader(fenceTag);
  if (header.path) {
    return {
      language: header.language,
      path: header.path,
      code: stripSplitFenceAttributeBrace(fenceTag, code),
    };
  }
  const lines = code.split('\n');
  const attrPath = parseAttributeLine(lines[0] ?? '');
  if (attrPath) {
    return { language: header.language, path: attrPath, code: lines.slice(1).join('\n') };
  }
  return { language: header.language, path: `file.${extensionForLanguage(header.language)}`, code };
}

/** Distinct blocks must never collapse into one entry when merged by path. */
function dedupePath(path: string, usedPaths: Set<string>): string {
  if (!usedPaths.has(path)) {
    usedPaths.add(path);
    return path;
  }
  const dot = path.lastIndexOf('.');
  const stem = dot === -1 ? path : path.slice(0, dot);
  const ext = dot === -1 ? '' : path.slice(dot);
  let n = 2;
  let candidate = `${stem}-${n}${ext}`;
  while (usedPaths.has(candidate)) {
    n += 1;
    candidate = `${stem}-${n}${ext}`;
  }
  usedPaths.add(candidate);
  return candidate;
}

export function extractCodeBlocks(input: string): ParsedBlock[] {
  const text = normalizeFenceOpeners(sanitizeAssistantOutput(input));
  // The final fence is optional so a stream cut mid-file still yields the file.
  const codeBlockRegex = /```([^\n]*)\n([\s\S]*?)(?:\n```|$)/g;
  const blocks: ParsedBlock[] = [];
  const usedPaths = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = codeBlockRegex.exec(text)) !== null) {
    const resolved = resolveBlockPath(match[1] || '', match[2]);
    if (!resolved.code.trim()) continue;
    blocks.push({ ...resolved, path: dedupePath(resolved.path, usedPaths) });
  }
  return blocks;
}

/** Model reply → file map, ready for the preview bundler or a git push. */
export function filesFromReply(input: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const block of extractCodeBlocks(input)) {
    out[block.path.replace(/^\.?\//, '')] = block.code;
  }
  return out;
}

/** Prose with the file blocks removed — what the chat shows the user. */
export function explanationFromReply(input: string): string {
  return sanitizeAssistantOutput(input)
    .replace(/```[^\n]*\n[\s\S]*?(?:\n```|$)/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
