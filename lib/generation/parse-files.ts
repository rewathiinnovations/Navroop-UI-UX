import { posix } from 'node:path';

export type ParseFilesErrorCode =
  | 'empty'
  | 'unterminated'
  | 'duplicate_path'
  | 'absolute_path'
  | 'path_traversal'
  | 'invalid_path'
  | 'too_large'
  | 'binary'
  | 'invalid_json'
  | 'unknown_section';

export class ParseFilesError extends Error {
  code: ParseFilesErrorCode;
  path?: string;

  constructor(code: ParseFilesErrorCode, message: string, path?: string) {
    super(message);
    this.name = 'ParseFilesError';
    this.code = code;
    this.path = path;
  }
}

export type ParsedGenerationFile = {
  path: string;
  content: string;
};

/** Per-file cap, shared by the strict parser and the persist write guard. */
export const MAX_FILE_BYTES = 2_000_000;
/** Whole-reply cap, shared by the strict parser and the persist path. */
export const MAX_TOTAL_BYTES = 8_000_000;
const FILE_RE = /<file path="([^"]*)">([\s\S]*?)<\/file>/g;
const OPEN_RE = /<file path="([^"]*)">/;

/** NUL bytes or a control-character-heavy sample: not a text file we can store. */
export function isBinaryGenerationContent(content: string) {
  if (content.includes('\u0000')) return true;
  let control = 0;
  const sample = content.slice(0, 2048);
  for (const ch of sample) {
    const code = ch.charCodeAt(0);
    if (code < 9 || (code > 13 && code < 32)) control += 1;
  }
  return sample.length > 0 && control / sample.length > 0.3;
}

/**
 * Every path this guards becomes a posix-semantic name — a storage key, a zip
 * entry, a `<file path=…>` block — so it is normalized with `posix`, never with
 * the platform's `path`. That is not a style preference: bare `node:path` made
 * the verdict depend on the host, and on Windows it let a `..` through its own
 * traversal check, because win32 `normalize` keeps the drive-relative prefix and
 * neither test below can see the `..` behind it.
 *
 *     sanitizeGenerationPath('C:x/a/../..\\..')
 *       win32 → { ok: true, path: 'C:..' }        ← escapes, silently
 *       posix → { ok: false, code: 'path_traversal' }
 *
 * Same shape for `C:x/../y` (`C:y` vs `y`) and `C:` (`C:.` vs `C:`). Windows dev
 * boxes ran the first column while the Linux container ran the second. Never go
 * back to the unqualified import.
 */
export function sanitizeGenerationPath(
  raw: string,
): { ok: true; path: string } | { ok: false; code: ParseFilesErrorCode } {
  const trimmed = raw.trim().replace(/\\/g, '/');
  if (!trimmed) return { ok: false, code: 'empty' };
  // A `"` ends the attribute in `<file path="…">`, the shape `toLastCode` writes
  // and `getCurrentProjectFiles` reads, so a quote-bearing path silently splits
  // the stored blob at the wrong offset and the file after it is swallowed. No
  // legitimate project path contains one, so this is a rejection, not an escape.
  if (trimmed.includes('"')) return { ok: false, code: 'invalid_path' };
  if (trimmed.split('/').some((segment) => segment === '')) {
    return { ok: false, code: 'empty' };
  }
  if (posix.isAbsolute(trimmed) || /^[a-zA-Z]:\//.test(trimmed) || trimmed.startsWith('/')) {
    return { ok: false, code: 'absolute_path' };
  }
  const normalized = posix.normalize(trimmed);
  // `posix.sep` is '/', so the second split the platform version needed was this
  // same check twice. One is enough, and `posix.normalize` can only ever leave a
  // `..` at the front, which `startsWith` already catches.
  if (normalized.startsWith('..') || normalized.split('/').includes('..')) {
    return { ok: false, code: 'path_traversal' };
  }
  return { ok: true, path: normalized.replace(/^\.\//, '') };
}

/**
 * Parse model output into a file map. Never writes to disk.
 * Never throws unexpected errors — failures are ParseFilesError.
 */
export function parseGenerationFiles(raw: string): ParsedGenerationFile[] {
  try {
    return parseGenerationFilesUnsafe(raw ?? '');
  } catch (error) {
    if (error instanceof ParseFilesError) throw error;
    throw new ParseFilesError('empty', 'Could not parse generated files');
  }
}

function parseGenerationFilesUnsafe(raw: string): ParsedGenerationFile[] {
  const text = String(raw);
  const files: ParsedGenerationFile[] = [];
  const seen = new Set<string>();
  let total = 0;
  let match: RegExpExecArray | null;
  const re = new RegExp(FILE_RE.source, 'g');

  while ((match = re.exec(text)) !== null) {
    const safe = sanitizeGenerationPath(match[1]);
    if (!safe.ok) {
      throw new ParseFilesError(safe.code, `Unsafe file path: ${match[1]}`, match[1]);
    }
    if (seen.has(safe.path)) {
      throw new ParseFilesError('duplicate_path', `Duplicate file path: ${safe.path}`, safe.path);
    }
    const content = match[2] ?? '';
    if (isBinaryGenerationContent(content)) {
      throw new ParseFilesError('binary', `Binary content is not allowed: ${safe.path}`, safe.path);
    }
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_FILE_BYTES) {
      throw new ParseFilesError('too_large', `File is too large: ${safe.path}`, safe.path);
    }
    total += bytes;
    if (total > MAX_TOTAL_BYTES) {
      throw new ParseFilesError('too_large', 'Generated output is too large');
    }
    seen.add(safe.path);
    files.push({ path: safe.path, content });
  }

  const leftover = text.replace(re, '');
  if (OPEN_RE.test(leftover) && !/<\/file>/.test(leftover.slice(leftover.search(OPEN_RE)))) {
    throw new ParseFilesError('unterminated', 'A file block was not closed');
  }

  return files;
}

export type LenientParsedFile = {
  path: string;
  content: string;
  /** The stream ended (or the next file began) before a closing tag. */
  closed: boolean;
};

/**
 * Lenient extraction of `<file path="...">` blocks from a generation stream.
 *
 * The strict `<file>...</file>` regex silently dropped every file when the
 * model omitted closing tags or the stream was truncated mid-file: a live
 * REACT build streamed three complete-looking files (fileOpen: 3,
 * fileClose: 0) and the route settled "no files generated", threw the whole
 * stream away, and failed over to a vendor that produced nothing. Here a new
 * `<file path=` opener implicitly closes the previous block, and the stream
 * end closes the last one. Content wholly wrapped in one markdown fence is
 * unwrapped — models fence file bodies even when told not to.
 *
 * Paths are NOT validated here; callers keep running each path through
 * sanitizeGenerationPath before writing anywhere.
 */
export function parseGeneratedFilesLenient(generatedCode: string): LenientParsedFile[] {
  const files: LenientParsedFile[] = [];
  const byPath = new Map<string, number>();
  const openRegex = /<file path="([^"]*)">/g;
  let match: RegExpExecArray | null;
  while ((match = openRegex.exec(generatedCode)) !== null) {
    const path = match[1];
    const bodyStart = match.index + match[0].length;
    const nextOpen = generatedCode.indexOf('<file path="', bodyStart);
    const close = generatedCode.indexOf('</file>', bodyStart);
    const closed = close !== -1 && (nextOpen === -1 || close < nextOpen);
    const bodyEnd = closed ? close : nextOpen === -1 ? generatedCode.length : nextOpen;
    const content = unwrapSingleFence(generatedCode.slice(bodyStart, bodyEnd).trim());
    if (!content) continue;
    const entry = { path, content, closed };
    const existing = byPath.get(path);
    if (existing === undefined) {
      byPath.set(path, files.length);
      files.push(entry);
    } else {
      files[existing] = entry;
    }
  }
  return files;
}

function unwrapSingleFence(content: string): string {
  const fenced = content.match(/^```[\w-]*\r?\n([\s\S]*?)\r?\n?```$/);
  return fenced ? fenced[1].trimEnd() : content;
}
