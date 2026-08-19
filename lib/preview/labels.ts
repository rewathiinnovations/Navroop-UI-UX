export const PREPARING_PREVIEW = 'Preparing preview…';
export const PREVIEW_BUILD_FAILED = 'Preview could not be built';
export const PREVIEW_NOT_READY_NOTICE =
  'The site is built, but its published preview snapshot is not ready yet.';
/**
 * Shown when `GET/POST /api/projects/[id]/preview` answers 403. Minting a
 * preview token is owner/ADMIN only because the signed URL it returns is
 * spendable anonymously on `/preview-static`, so a workspace member who can
 * read the project still cannot open its preview.
 */
export const PREVIEW_ACCESS_DENIED = 'Only the project owner can open its preview.';
export const PREVIEW_EMPTY = 'Nothing to preview yet — describe what you want built in the chat.';
export const STATIC_PREVIEW_LABEL = 'Preview';
export const LIVE_SANDBOX_LABEL = 'Live sandbox';
/**
 * Live mode died with the sandbox subsystem (migration
 * 20260819010000_drop_sandbox_columns), and the rest of the LIVE_MODE_* copy
 * went with it. This line survives because `getPreviewStatus` still reports
 * `liveReason` for a project whose static export failed (./status.ts).
 */
export const LIVE_MODE_LOCKED_REASON =
  'This project needs a live sandbox because the static export failed.';
export const PREVIEW_TOO_LARGE =
  'Preview is too large to store. It must be under 200 MB and 5,000 files.';
export const PREVIEW_NOT_FOUND_TITLE = 'Page not found';
export const PREVIEW_STATIC_HOST_PREFIX = 'preview-static';

/**
 * The adapted layout copy the assembler mounts when a layout renders its own
 * `<html>`. Declared here because it is a display concern: it must never appear
 * in anything a person reads.
 */
export const PREVIEW_LAYOUT_BASENAME = '__preview-layout.tsx';

/**
 * `vfs:` is the namespace `lib/preview/bundle.ts` gives every generated module
 * inside its virtual filesystem, and esbuild echoes it back in diagnostics. It
 * names nothing that exists in the project, so it is stripped before any of it
 * reaches a reader — the pane shipped
 * `No matching export in "vfs:lib/data.ts" for import "site"` to a user who has
 * no way of knowing what `vfs:` is.
 */
export function stripPreviewScheme(text: string): string {
  return (
    text
      .replace(/\bvfs:/g, '')
      // A reader told "app/__preview-layout.tsx imports SITE_NAME" goes hunting for
      // a file that does not exist in their project. The fault is real; the
      // filename is ours, so it is reported against the file they actually have.
      .replace(/__preview-layout\.(tsx|jsx)/g, 'layout.$1')
  );
}

/**
 * Project-local module specifiers: relative, root-absolute, or the `@/` alias
 * the generated tsconfig maps onto the project root. Everything else is a
 * package name, which no amount of further generation can produce.
 */
export function isLocalPreviewSpecifier(specifier: string): boolean {
  return specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('@/');
}

export type PreviewDiagnostic =
  /** A module resolved, but does not export the name that was imported. */
  | { type: 'missing-export'; module: string; symbol: string; importer: string | null }
  /** An import that resolved to nothing at all. */
  | { type: 'unresolved-import'; specifier: string; importer: string | null }
  /** A syntax error, a type-level failure, a runtime stack — anything else. */
  | { type: 'unknown' };

/** esbuild's wording for a named import a module never exported. */
const MISSING_EXPORT = /^No matching export in "([^"]+)" for import "([^"]+)"/;
/** `Cannot resolve` is our virtual resolver, `Could not resolve` is esbuild's. */
const UNRESOLVED_IMPORT = /^(?:Cannot|Could not) resolve "([^"]+)"(?: from "([^"]+)")?/;
/** The `(app/page.tsx:13:8)` suffix `formatEsbuildError` appends. */
const TRAILING_LOCATION = /\(([^()]+?)(?::\d+){0,2}\)\s*$/;

/**
 * One bundler diagnostic per line — the shape `formatEsbuildError` produces.
 * Unrecognised lines are kept as `unknown` rather than dropped, because the
 * callers below decide what to do about a failure by counting all of them.
 */
export function parsePreviewDiagnostics(message: string): PreviewDiagnostic[] {
  const diagnostics: PreviewDiagnostic[] = [];
  for (const raw of stripPreviewScheme(message).split('\n')) {
    const line = raw.trim();
    if (!line) continue;

    const missingExport = MISSING_EXPORT.exec(line);
    if (missingExport) {
      diagnostics.push({
        type: 'missing-export',
        module: missingExport[1],
        symbol: missingExport[2],
        importer: TRAILING_LOCATION.exec(line)?.[1] ?? null,
      });
      continue;
    }

    const unresolved = UNRESOLVED_IMPORT.exec(line);
    if (unresolved) {
      // `resolveVirtual` reports the entry point as "entry"; it is not a filename,
      // so the location suffix is the only thing that can name the importer.
      const from = unresolved[2];
      diagnostics.push({
        type: 'unresolved-import',
        specifier: unresolved[1],
        importer: from && from !== 'entry' ? from : (TRAILING_LOCATION.exec(line)?.[1] ?? null),
      });
      continue;
    }

    diagnostics.push({ type: 'unknown' });
  }
  return diagnostics;
}

/**
 * Plain-English sentences for the diagnostics we recognise, in reading order.
 *
 * Empty when nothing was recognised, so the caller shows the compiler's own
 * words instead of a guess: a confident sentence about a failure we did not
 * understand would be worse than the raw text.
 */
export function explainPreviewError(message: string): string[] {
  const sentences: string[] = [];
  for (const diagnostic of parsePreviewDiagnostics(message)) {
    if (diagnostic.type === 'missing-export') {
      const { module, symbol, importer } = diagnostic;
      sentences.push(
        importer
          ? `${importer} imports “${symbol}” from ${module}, but ${module} does not export it.`
          : `${module} does not export “${symbol}”, and another file imports it.`,
      );
      continue;
    }
    if (diagnostic.type === 'unresolved-import') {
      const { specifier, importer } = diagnostic;
      const who = importer ?? 'The preview entry';
      sentences.push(
        isLocalPreviewSpecifier(specifier)
          ? `${who} imports “${specifier}”, but no file with that path was generated.`
          : `${who} imports the package “${specifier}”, which the preview cannot load.`,
      );
    }
  }
  return sentences;
}

/**
 * What a still-running generation may yet write, or `null` when at least one
 * diagnostic can never be fixed by more streaming.
 *
 * Incident: with 16 of ~25 files streamed, `app/page.tsx` had completed and
 * imported `@/components/FinalCTA`, which had not been written yet. The pane
 * called that a broken preview while the model was still typing. A missing
 * local file or a not-yet-written export is "not yet"; a package name is a real
 * error even mid-stream, because streaming cannot produce a package.
 */
export function pendingLocalModules(message: string): string[] | null {
  const diagnostics = parsePreviewDiagnostics(message);
  if (diagnostics.length === 0) return null;

  const waiting = new Set<string>();
  for (const diagnostic of diagnostics) {
    if (diagnostic.type === 'missing-export') {
      waiting.add(`${diagnostic.symbol} in ${diagnostic.module}`);
      continue;
    }
    if (diagnostic.type === 'unresolved-import' && isLocalPreviewSpecifier(diagnostic.specifier)) {
      const { specifier } = diagnostic;
      // `@/` is a project alias, not part of the path the reader recognises.
      waiting.add(specifier.startsWith('@/') ? specifier.slice(2) : specifier);
      continue;
    }
    return null;
  }
  return [...waiting];
}

/**
 * Names what the preview is waiting for. Swallowing a mid-stream failure is
 * only acceptable while the pane says which file it is patient about.
 */
export function waitingForModulesMessage(labels: string[]): string {
  const shown = labels.slice(0, 3).join(', ');
  const rest = labels.length - 3;
  const list = rest > 0 ? `${shown} and ${rest} more` : shown;
  return `Waiting for ${list} — the build has not written ${
    labels.length === 1 ? 'it' : 'them'
  } yet.`;
}

/** Which half of the pipeline failed: the compile, or the page once it ran. */
export type PreviewErrorKind = 'code' | 'runtime';

/**
 * What the model is told when the user asks the preview to repair itself.
 *
 * The class has to be named honestly. A first version said "The preview fails to
 * compile" for every failure; handed a runtime `Cannot read properties of
 * undefined (reading 'map')` — code that compiled perfectly — the model went
 * looking for a build error, wrote one unrelated file, and the crash survived.
 */
export function previewRepairInstruction(message: string, kind: PreviewErrorKind): string {
  if (kind === 'runtime') {
    return [
      'The site compiles, but the page crashes as soon as it runs:',
      '',
      message,
      '',
      'Find the code that throws this and fix it. If a list is being mapped over,',
      'make sure the data it reads is always defined when the component renders.',
      'Return the corrected files.',
    ].join('\n');
  }
  return [
    'The site does not compile:',
    '',
    message,
    '',
    'Fix the code so it compiles. Return the corrected files.',
  ].join('\n');
}
