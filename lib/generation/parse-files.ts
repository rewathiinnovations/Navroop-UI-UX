import { isAbsolute, normalize, sep } from 'node:path';

export type ParseFilesErrorCode =
  | 'empty'
  | 'unterminated'
  | 'duplicate_path'
  | 'absolute_path'
  | 'path_traversal'
  | 'too_large'
  | 'binary'
  | 'invalid_json';

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

const MAX_FILE_BYTES = 2_000_000;
const MAX_TOTAL_BYTES = 8_000_000;
const FILE_RE = /<file path="([^"]*)">([\s\S]*?)<\/file>/g;
const OPEN_RE = /<file path="([^"]*)">/;

function isBinary(content: string) {
  if (content.includes('\u0000')) return true;
  let control = 0;
  const sample = content.slice(0, 2048);
  for (const ch of sample) {
    const code = ch.charCodeAt(0);
    if (code < 9 || (code > 13 && code < 32)) control += 1;
  }
  return sample.length > 0 && control / sample.length > 0.3;
}

export function sanitizeGenerationPath(raw: string): { ok: true; path: string } | { ok: false; code: ParseFilesErrorCode } {
  const trimmed = raw.trim().replace(/\\/g, '/');
  if (!trimmed) return { ok: false, code: 'empty' };
  if (trimmed.split('/').some((segment) => segment === '')) {
    return { ok: false, code: 'empty' };
  }
  if (isAbsolute(trimmed) || /^[a-zA-Z]:\//.test(trimmed) || trimmed.startsWith('/')) {
    return { ok: false, code: 'absolute_path' };
  }
  const normalized = normalize(trimmed).replace(/\\/g, '/');
  if (normalized.startsWith('..') || normalized.split('/').includes('..')) {
    return { ok: false, code: 'path_traversal' };
  }
  if (normalized.split(sep).includes('..')) {
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
    if (isBinary(content)) {
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
