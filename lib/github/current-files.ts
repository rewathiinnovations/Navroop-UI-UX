/**
 * Reads a project's current files from `Project.lastCode` — the only durable
 * record of what was generated. It used to consult a `sandboxState.fileCache`
 * server-global first; the sandbox subsystem is gone and nothing writes that
 * global, so the branch was dead. It is not restored: both the settle path and
 * the "keep what was built" path spread a generation over what this returns,
 * and a cache winning over the row would resurrect deleted files.
 */

function normalizePath(path: string) {
  return path.replace(/^\.?\//, '');
}

const CLOSE_TAG = '</file>';

/**
 * Splits on openers and takes the *last* closing tag in each block rather than
 * the first — but only when the block actually ends with one.
 *
 * `toLastCode` writes `<file path="p">\ncontent\n</file>`, so the final tag in a
 * block is by construction the closer. Stopping at the first one truncated any
 * file whose own text contains the literal `</file>` (a file documenting this
 * very format), silently, with no rejection anywhere — the stored site simply
 * came back short. The "ends with a closer" condition is what keeps the older
 * shapes intact: a blob with prose after the last block does not end in a tag,
 * so it still stops at the first one and the prose stays out of the file.
 *
 * Still not handled, and not handleable without changing the stored format: a
 * file whose own text contains an *opening* `<file path="…">` tag. That splits
 * into an extra bogus entry, and nothing in the blob distinguishes it from a
 * real block. Anchoring openers to "start of blob, or right after a closer"
 * would fix it but would reject legacy rows that begin with model prose, so it
 * is left as a known limit rather than traded for a worse one.
 */
function filesFromLastCode(lastCode: string | null | undefined): Record<string, string> {
  if (!lastCode?.trim()) return {};

  const tagged: Record<string, string> = {};
  const openRe = /<file path="([^"]+)">/g;
  const openers: { path: string; tagStart: number; bodyStart: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = openRe.exec(lastCode)) !== null) {
    openers.push({
      path: match[1],
      tagStart: match.index,
      bodyStart: match.index + match[0].length,
    });
  }
  for (const [index, opener] of openers.entries()) {
    const regionEnd = openers[index + 1]?.tagStart ?? lastCode.length;
    const region = lastCode.slice(opener.bodyStart, regionEnd);
    const squared = region.trimEnd();
    const firstClose = region.indexOf(CLOSE_TAG);
    const body = squared.endsWith(CLOSE_TAG)
      ? squared.slice(0, -CLOSE_TAG.length)
      : firstClose === -1
        ? region
        : region.slice(0, firstClose);
    tagged[normalizePath(opener.path)] = body.trim();
  }
  if (Object.keys(tagged).length > 0) return tagged;

  const trimmed = lastCode.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const out: Record<string, string> = {};
        for (const [path, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof value === 'string') out[normalizePath(path)] = value;
        }
        if (Object.keys(out).length > 0) return out;
      }
    } catch {
      // not a file map
    }
  }

  return { 'src/App.jsx': lastCode };
}

export function getCurrentProjectFiles(project: { lastCode?: string | null }) {
  return filesFromLastCode(project.lastCode);
}
