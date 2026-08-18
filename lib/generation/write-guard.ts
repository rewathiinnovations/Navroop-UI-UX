import { ParseFilesError, sanitizeGenerationPath, type ParsedGenerationFile } from './parse-files';

function isPackageJsonPath(path: string) {
  return path === 'package.json' || path.endsWith('/package.json');
}

/**
 * Last gate before a sandbox write. Empty / doubled-slash paths and a
 * package.json that JSON.parse cannot read must not reach npm install.
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
