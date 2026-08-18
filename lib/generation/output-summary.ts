const PREVIEW_CHARS = 120;

/**
 * A one-line shape report for a model reply, logged next to every stream.
 *
 * `pathFences` vs `fences` is the diagnostic that matters: files arrive as
 * ```lang{path=…} openers, so a reply with fences but no path-tagged ones is a
 * model ignoring the output contract, which reads as "no files generated"
 * unless the log says otherwise.
 */
export function summarizeGenerationOutput(raw: string) {
  const text = String(raw ?? '');
  const preview = text.slice(0, PREVIEW_CHARS).replace(/\s+/g, ' ').trim();
  return {
    chars: text.length,
    preview,
    pathFences: (text.match(/```[^\n`]*\{path=/g) || []).length,
    fences: (text.match(/```/g) || []).length,
  };
}
