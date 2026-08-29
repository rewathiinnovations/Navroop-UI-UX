import {
  isBinaryGenerationContent,
  MAX_FILE_BYTES,
  ParseFilesError,
  sanitizeGenerationPath,
  type ParsedGenerationFile,
} from './parse-files';
import { SECTION_COMPONENT_NAMES } from '@/lib/stacks/templates/sections';

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
  const invented = inventedSectionImport(content);
  if (invented) {
    throw new ParseFilesError(
      'unknown_section',
      `${safe.path} imports @/components/sections/${invented}, which does not exist. The catalogue is: ${SECTION_COMPONENT_NAMES.join(', ')}. Call use_section to get one, or write the markup inline.`,
      safe.path,
    );
  }
  return { path: safe.path, content };
}

/**
 * The first import of a section the kit does not ship, if there is one.
 *
 * A model that wants a carousel writes `@/components/sections/carousel` and moves on. The
 * import is a real module specifier, so `resolveBareSpecifier` never sees it — it looks
 * like a project file, and the failure surfaces as "No matching export" from the bundler
 * with the model already several steps past the mistake. Refusing at the write is the
 * earliest anything can know, and the refusal carries the catalogue so the next step is a
 * choice rather than another guess.
 *
 * The path prefix is fixed rather than derived from the layout: REACT projects import
 * through the same `@/` alias, so `src/` never appears in a specifier.
 */
function inventedSectionImport(content: string): string | null {
  const pattern = /from\s+['"]@\/components\/sections\/([A-Za-z0-9._-]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const name = match[1].replace(/\.(tsx|ts|jsx|js)$/, '');
    if (!KNOWN_SECTIONS.has(name)) return name;
  }
  return null;
}

const KNOWN_SECTIONS = new Set<string>(SECTION_COMPONENT_NAMES);
