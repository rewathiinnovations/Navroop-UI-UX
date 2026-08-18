/**
 * Last-resort shell write when a driver has no filesystem API.
 * Base64 on the printf side cannot contain quotes, `$`, backticks, or
 * newlines, so the shell cannot reinterpret the payload. `base64 -d`
 * restores the original bytes.
 *
 * Do not use `printf %s ${JSON.stringify(content)}` — that writes literal
 * `\` + `n` for every newline (the Modal `{\n  "name": "sandbox...` bug).
 */
export function base64DecodeWriteCommand(path: string, content: string): string {
  const encoded = Buffer.from(content, 'utf8').toString('base64');
  return `mkdir -p "$(dirname ${JSON.stringify(path)})" && printf %s ${JSON.stringify(encoded)} | base64 -d > ${JSON.stringify(path)}`;
}
