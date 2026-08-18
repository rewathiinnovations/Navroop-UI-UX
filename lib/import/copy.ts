/**
 * Plain-English import copy. One sentence per fact — do not describe an
 * import failure as a failed build, and do not blame the user's URL for a
 * credential or quota problem (those live in firecrawl.ts).
 */

export const IMPORT_NO_FILES_MESSAGE =
  'The import produced no files — the source was not turned into a site. Try the import again.';

export function sectionGenerateFailureMessage(label: string, detail: string) {
  return `Section "${label}" could not be generated (${detail}) — continuing with the other sections. Try that section again if it is missing.`;
}

export function sectionGenerationSeverity(input: { succeeded: number; failed: number }) {
  return input.succeeded > 0 ? 'compose' : 'fallback';
}
