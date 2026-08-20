/**
 * `Project.lastCode` is the stored form of a project's files.
 *
 * It is deliberately not the model's raw reply: the model answers in fenced
 * blocks surrounded by prose, and storing that verbatim would make the
 * explanation part of the site. Files are normalized into `<file path=…>`
 * blocks here, which is the one shape `getCurrentProjectFiles` parses.
 *
 * Two things make that round-trip total, and both live outside this function:
 * `sanitizeGenerationPath` refuses a path containing `"` (it would close the
 * attribute early), and the reader takes the last `</file>` in a block, so a
 * file whose own text contains that tag comes back whole.
 */
export function toLastCode(files: Record<string, string>): string {
  return Object.entries(files)
    .map(([path, content]) => `<file path="${path.replace(/^\.?\//, '')}">\n${content}\n</file>`)
    .join('\n\n');
}
