/**
 * `Project.lastCode` is the stored form of a project's files.
 *
 * It is deliberately not the model's raw reply: the model answers in fenced
 * blocks surrounded by prose, and storing that verbatim would make the
 * explanation part of the site. Files are normalized into `<file path=…>`
 * blocks here, which is the one shape `getCurrentProjectFiles` parses.
 */
export function toLastCode(files: Record<string, string>): string {
  return Object.entries(files)
    .map(([path, content]) => `<file path="${path.replace(/^\.?\//, '')}">\n${content}\n</file>`)
    .join('\n\n');
}
