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
  /**
   * The block's identity within this reply. A second block claiming an already
   * used path is suffixed `-2` here so truncation repair can target each block
   * individually — see `dedupePath`.
   */
  path: string;
  /**
   * What the fence actually named, before any dedupe suffix. Two blocks naming
   * one path describe one file on disk, so the file map keys on this and lets
   * the later block win — the model restating a file is a revision, and storing
   * the suffixed twin as a second project file left the stale first copy winning
   * every import resolution while `App-2.tsx` shipped unused.
   */
  canonicalPath: string;
  code: string;
  language: string;
  /**
   * The fence itself carried the path. A block without one is a prose snippet
   * that only got a `file.<ext>` name from the fallback below, so nothing that
   * has to name a real project file (truncation recovery) may act on it.
   */
  declaredPath: boolean;
  /**
   * The closing fence never arrived — the reply was cut off mid-file. This is
   * the truncation signal: the prompt contract is fenced blocks, so an unclosed
   * fence is what a cut-off reply actually looks like.
   */
  truncated: boolean;
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

type ResolvedBlock = Omit<ParsedBlock, 'truncated' | 'canonicalPath'>;

/**
 * `./src/App.tsx`, `/src/App.tsx` and `src/App.tsx` name one file, and every
 * reader has to agree on that spelling *before* `dedupePath` numbers it.
 *
 * `filesFromReply` used to strip the prefix on the way out instead, which left
 * two holes. Two blocks spelling one path differently collapsed into a single
 * map entry, so one file was silently lost. Worse, truncation recovery re-asked
 * for `./src/App.tsx` and handed that back to `replaceBlockInReply`, which
 * stripped the prefix from the block but not from the target — the repair it had
 * just paid a second model call for matched nothing, and the run reported a
 * repairable build as incomplete under a `provider_error` code.
 */
const LEADING_DOT_SLASH_RE = /^(?:\.?\/)+/;

function resolveBlockPath(fenceTag: string, code: string): ResolvedBlock {
  const header = parseFenceHeader(fenceTag);
  const headerPath = (header.path ?? '').trim().replace(LEADING_DOT_SLASH_RE, '');
  if (headerPath) {
    return {
      language: header.language,
      path: headerPath,
      code: stripSplitFenceAttributeBrace(fenceTag, code),
      declaredPath: true,
    };
  }
  const lines = code.split('\n');
  const attrPath = (parseAttributeLine(lines[0] ?? '') ?? '')
    .trim()
    .replace(LEADING_DOT_SLASH_RE, '');
  if (attrPath) {
    return {
      language: header.language,
      path: attrPath,
      code: lines.slice(1).join('\n'),
      declaredPath: true,
    };
  }
  return {
    language: header.language,
    path: `file.${extensionForLanguage(header.language)}`,
    code,
    declaredPath: false,
  };
}

/**
 * The one block scan, shared so every reader agrees on where a block ends.
 * Kept without `g` and cloned per use, so no reader inherits another's
 * `lastIndex`.
 *
 * A block ends on a bare closing fence, at the start of the next `{path=…}`
 * opener, or at the end of the input. The middle branch is what a model that
 * forgot to close a file looks like: without it, the next opener's own fence
 * was read as this block's close, the leftover `tsx{path=…}` no longer matched
 * an opener, and every file after the unclosed one was lost.
 */
const BLOCK_RE = /```([^\n]*)\n([\s\S]*?)(?:\n```(?![^\n`]*\{path=)|(?=\n```[^\n`]*\{path=)|$)/;

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

type ScannedBlock = ParsedBlock & {
  /** Where this block sits in the normalized text, so a repair can overwrite it. */
  start: number;
  end: number;
};

/** The text every scan runs on: thinking blocks and preamble gone, openers unglued. */
function normalizedReply(input: string): string {
  return normalizeFenceOpeners(sanitizeAssistantOutput(input));
}

/**
 * One walk over the blocks, so every reader agrees which block a path names.
 *
 * Truncation recovery is the case that proves this has to be shared rather than
 * merely similar: detection names the second block claiming `src/App.tsx` as
 * `src/App-2.tsx`, and the repair has to land on that same second block. That
 * only holds if both walks see the same normalized text, skip the same empty
 * blocks, and advance the same dedupe counter. `replaceBlockInReply` used to
 * re-scan the *unsanitized* input with its own loop and no dedupe, so a fence
 * inside a `<thinking>` block shifted the sequence and a deduplicated path
 * matched nothing.
 */
function scanBlocks(text: string): ScannedBlock[] {
  // The final fence is optional so a stream cut mid-file still yields the file.
  const codeBlockRegex = new RegExp(BLOCK_RE, 'g');
  const blocks: ScannedBlock[] = [];
  const usedPaths = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = codeBlockRegex.exec(text)) !== null) {
    const resolved = resolveBlockPath(match[1] || '', match[2]);
    if (!resolved.code.trim()) continue;
    blocks.push({
      ...resolved,
      canonicalPath: resolved.path,
      path: dedupePath(resolved.path, usedPaths),
      // No closing fence on the match means the reply stopped inside this file.
      truncated: !match[0].endsWith('\n```'),
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return blocks;
}

export function extractCodeBlocks(input: string): ParsedBlock[] {
  return scanBlocks(normalizedReply(input));
}

/**
 * Swaps one `{path=…}` block's body for repaired content, returning null when
 * the reply has no block for that path.
 *
 * Truncation recovery used to write the completed file back as
 * `<file path="…">`, a shape `filesFromReply` does not parse, so the file it
 * had just paid a second model call to complete was dropped on the floor. A
 * repaired file has to re-enter the reply in the fenced contract the prompt
 * asked for.
 */
export function replaceBlockInReply(
  input: string,
  targetPath: string,
  code: string,
): string | null {
  const text = normalizedReply(input);
  // Same scan, same dedupe counter, so `targetPath` is compared against exactly
  // the key `extractCodeBlocks` handed the caller — including the `-2` suffix a
  // second block claiming one path gets.
  const target = scanBlocks(text).find((block) => block.declaredPath && block.path === targetPath);
  if (!target) return null;
  const fence = '```';
  const replacement = `${fence}${target.language}{path=${targetPath}}\n${code}\n${fence}`;
  return text.slice(0, target.start) + replacement + text.slice(target.end);
}

/** Model reply → file map, ready for the preview bundler or a git push. */
export function filesFromReply(input: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const block of extractCodeBlocks(input)) {
    // A fence with no declared path is prose, not a file. The prompt contract
    // requires `{path=…}` on every fence (stack-prompts/shared.ts: "Never open
    // a bare ```tsx fence"), the stream tracker only opens on `{path=…}`
    // fences, and truncation recovery skips undeclared blocks for the same
    // reason. Keeping them here turned a chatty answer with one illustrative
    // snippet into a persisted `file.js` project file — in the Code tab, the
    // ZIP export and the deploy push — while the run reported success (F-023).
    if (!block.declaredPath) continue;
    // No `./` stripping here: `resolveBlockPath` normalized the declared path
    // before `dedupePath` numbered it, so this key is already the one
    // `detectTruncatedFiles` and `replaceBlockInReply` name. Keyed by
    // `canonicalPath`, so two blocks naming one file collapse into it — later
    // block wins — instead of storing a `-2` twin the site never imports.
    out[block.canonicalPath] = block.code;
  }
  return out;
}

/** `<file path="…">` openers — the shape a URL import produces, not a generation. */
const FILE_PATH_ATTR_RE = /<file path="([^"]+)">/g;

/**
 * The paths a reply named, whichever of the two shapes it used.
 *
 * A generation reply is fenced `{path=…}` output; a URL import hands back
 * `<file path="…">` XML (`lib/import/persist.ts` reads it with
 * `parseGeneratedFilesLenient`). The apply path ran only `filesFromReply` over
 * both, so retrying a failed import closed with "Successfully applied 0 files"
 * for an import that had in fact written the whole site (F-054).
 *
 * Fenced blocks win when present: a generation that happens to *quote* a
 * `<file path=…>` tag inside a code block must not have that counted as a file.
 */
export function appliedPathsFromReply(input: string): string[] {
  const fenced = Object.keys(filesFromReply(input));
  if (fenced.length > 0) return fenced;
  const tagged: string[] = [];
  for (const match of input.matchAll(FILE_PATH_ATTR_RE)) {
    const path = match[1].trim().replace(LEADING_DOT_SLASH_RE, '');
    if (path && !tagged.includes(path)) tagged.push(path);
  }
  return tagged;
}

/** Prose with the file blocks removed — what the chat shows the user. */
export function explanationFromReply(input: string): string {
  // BLOCK_RE, not a lookalike. The old inline pattern read an unclosed block's
  // *next* opener as its own closing fence — precisely the reply BLOCK_RE exists
  // to handle — and left the following file's code sitting in the transcript as
  // prose. `chatTextFromConversation` is the production caller.
  return normalizedReply(input)
    .replace(new RegExp(BLOCK_RE, 'g'), '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** A `<file path=…>` block, closed or cut off by the end of the frame. */
const FILE_BLOCK_RE = /<file\b[^>]*>[\s\S]*?(?:<\/file>|$)/g;
/** `<package>` / `<packages>` are instructions to the applier, never speech. */
const PACKAGE_BLOCK_RE = /<(package|packages)\b[^>]*>[\s\S]*?(?:<\/\1>|$)/g;

/**
 * A `conversation` frame → the prose that belongs in the transcript.
 *
 * The client used to append the frame only when its text contained none of `<file`,
 * `import React`, `export default`, `className=`. The intent — keep pasted source out of
 * chat — is right, but a substring match over the whole frame discards the answer to
 * "why did you use a default export here?", with no chat line and no log. On the
 * chat-answer path the `conversation` frame *is* the reply, so the run finished having
 * said nothing at all (F-050).
 *
 * Structure decides instead of vocabulary: strip the code, keep the prose. An empty
 * result means the frame was only code, which is the one case the old filter got right.
 */
export function chatTextFromConversation(input: string): string {
  return explanationFromReply(input.replace(PACKAGE_BLOCK_RE, '').replace(FILE_BLOCK_RE, ''));
}
