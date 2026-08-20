import {
  isBinaryGenerationContent,
  MAX_FILE_BYTES,
  ParseFilesError,
  sanitizeGenerationPath,
  type ParsedGenerationFile,
} from './parse-files';

function isPackageJsonPath(path: string) {
  return path === 'package.json' || path.endsWith('/package.json');
}

/**
 * Last gate before a generated file is persisted. Empty / doubled-slash paths,
 * binary payloads, a file over the per-file cap and a package.json that
 * JSON.parse cannot read must not reach storage — an invalid package.json
 * ships to the deploy repo and fails the build there (F-028).
 *
 * The content checks mirror `parseGenerationFilesUnsafe` exactly (same
 * predicate, same cap, same messages), so the strict parser and the persist
 * path can never disagree about what a writable file is. The whole-reply
 * total cap is the one check that cannot live here: it is cross-file, and
 * `safeGeneratedFiles` carries it.
 */
export function assertWritableGenerationFile(file: {
  path: string;
  content: string;
}): ParsedGenerationFile {
  const safe = sanitizeGenerationPath(file.path ?? '');
  if (!safe.ok) {
    throw new ParseFilesError(safe.code, `Unsafe file path: ${file.path || '(empty)'}`, file.path);
  }
  const content = file.content ?? '';
  if (isBinaryGenerationContent(content)) {
    throw new ParseFilesError('binary', `Binary content is not allowed: ${safe.path}`, safe.path);
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
    throw new ParseFilesError('too_large', `File is too large: ${safe.path}`, safe.path);
  }
  if (isPackageJsonPath(safe.path)) {
    try {
      JSON.parse(content);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ParseFilesError(
        'invalid_json',
        `package.json is not valid JSON: ${detail}`,
        safe.path,
      );
    }
  }
  return { path: safe.path, content };
}
