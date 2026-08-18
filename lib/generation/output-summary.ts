const PREVIEW_CHARS = 120;

export function summarizeGenerationOutput(raw: string) {
  const text = String(raw ?? '');
  const preview = text.slice(0, PREVIEW_CHARS).replace(/\s+/g, ' ').trim();
  return {
    chars: text.length,
    preview,
    fileOpen: (text.match(/<file\b/g) || []).length,
    fileClose: (text.match(/<\/file>/g) || []).length,
    markdownFences: (text.match(/```/g) || []).length,
  };
}
