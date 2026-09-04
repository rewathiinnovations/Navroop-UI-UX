import {
  isBinaryGenerationContent,
  MAX_FILE_BYTES,
  ParseFilesError,
  sanitizeGenerationPath,
  type ParsedGenerationFile,
} from './parse-files';
import { SECTION_COMPONENT_NAMES } from '@/lib/stacks/templates/sections';
import { sectionImportsIn } from '@/lib/stacks/section-imports';

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
export function assertWritableGenerationFile(
  file: {
    path: string;
    content: string;
  },
  /**
   * Section files the project itself has, beyond the kit's catalogue.
   *
   * The store passes its own snapshot so a section the model wrote this turn — or one a
   * pre-existing project already had — is importable. Absent, only the catalogue counts,
   * which is the right default for the fence path and for callers with no file set.
   */
  knownProjectSections?: ReadonlySet<string>,
): ParsedGenerationFile {
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
  const invented = inventedSectionImport(safe.path, content, knownProjectSections);
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
 * The first import of a section that exists nowhere, if there is one.
 *
 * A model that wants a carousel writes `@/components/sections/carousel` and moves on. The
 * import is a real module specifier, so `resolveBareSpecifier` never sees it — it looks
 * like a project file, and the failure surfaces as "No matching export" from the bundler
 * with the model already several steps past the mistake. Refusing at the write is the
 * earliest anything can know, and the refusal carries the catalogue so the next step is a
 * choice rather than another guess.
 *
 * "Exists" means the kit's catalogue OR a section file the project itself has. Without the
 * second half the guard contradicted itself within a turn: it allowed a model to write
 * `components/sections/team.tsx` and then refused the page importing it, saying the file
 * "does not exist" about a file the same turn had just created — with no correct recovery
 * except deleting its own component. It also made any project that already had a file there
 * un-editable, since every rewrite of the importing page goes through this same gate.
 *
 * Only code files are read. The check is textual, so a Markdown file quoting an import in
 * prose used to be refused with a message about imports, and on the fence path a refusal is
 * a silent per-file drop rather than a stop — the page vanished from a build that still
 * reported success. Commented-out lines are skipped for the same reason.
 */
const CODE_FILE_FOR_IMPORTS = /\.(tsx|ts|jsx|js|mjs|cjs)$/;

function withoutCommentLines(content: string): string {
  return content
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trimStart();
      return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
    })
    .join(' ');
}

function inventedSectionImport(
  path: string,
  content: string,
  knownProjectSections?: ReadonlySet<string>,
): string | null {
  if (!CODE_FILE_FOR_IMPORTS.test(path)) return null;
  const { unknown } = sectionImportsIn(withoutCommentLines(content));
  return unknown.find((name) => !knownProjectSections?.has(name)) ?? null;
}
