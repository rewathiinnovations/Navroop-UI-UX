/** `<package>name</package>` — the one tag the edit path scans for mid-stream. */
const PACKAGE_RE = /<package>([^<]+)<\/package>/g;

/**
 * How much text to carry between chunks so a `<package>…</package>` split across
 * two provider chunks is still matched. An npm name is at most 214 characters, so
 * 512 covers the whole tag with room to spare, and it is the bound
 * `StreamedFileTracker` in this directory already uses.
 */
export const PACKAGE_LOOKBEHIND = 512;

/**
 * Detects `<package>` tags as an edit's reply streams in.
 *
 * This replaces a `tagBuffer` kept in the generate route's stream loop. That
 * buffer was trimmed with `searchText.substring(Math.max(0, lastIndex - 50))`,
 * where `lastIndex` only advanced when a package tag matched. On an initial build,
 * and on every edit whose reply has no package tag — the normal case — `lastIndex`
 * stayed `0`, so `substring(0)` returned the whole string and the buffer became a
 * second full copy of the reply, growing with every chunk. On edits the regex then
 * re-scanned that accumulation on every chunk, which is quadratic over a reply
 * that `maxOutputTokensForEntry` allows to reach ~500 KB — on the same event loop
 * that is writing every other request's SSE frames.
 *
 * Text up to the last complete tag is consumed, and only the bounded tail is held
 * back, so per-chunk work is O(chunk + lookbehind) and a tag is reported once.
 */
export class StreamedPackageTracker {
  private buffer = '';

  /** Held-back tail length. Bounded by {@link PACKAGE_LOOKBEHIND} at all times. */
  get bufferLength() {
    return this.buffer.length;
  }

  /** Feeds one stream chunk; returns the package names this chunk completed. */
  push(chunk: string): string[] {
    const pending = this.buffer + chunk;
    const found: string[] = [];
    let consumedTo = 0;

    PACKAGE_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = PACKAGE_RE.exec(pending)) !== null) {
      const name = match[1].trim();
      consumedTo = match.index + match[0].length;
      // An empty tag is skipped rather than reported, the way the route's own
      // `if (packageName && …)` guard did.
      if (name) found.push(name);
    }

    // Everything before the last complete tag can never match again. Of what is
    // left, keep only enough for a tag straddling this chunk and the next.
    this.buffer = pending.slice(consumedTo).slice(-PACKAGE_LOOKBEHIND);
    return found;
  }
}
