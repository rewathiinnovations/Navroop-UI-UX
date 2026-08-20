import { sanitizeGenerationPath } from './parse-files';

/** An opening fence carrying a {path=...} tag. */
const FENCE_OPEN_RE = /```[^\n`]*\{path=([^}\n]+)\}/;
/** A closing fence at the start of a line. */
const FENCE_CLOSE_RE = /\n```/;
/**
 * How much text to keep unconsumed between chunks, so a fence split across two
 * provider chunks is still matched. Longer than any real fence header, and
 * bounded so a long prose answer cannot grow the buffer.
 */
const LOOKBEHIND = 512;

export type StreamedFile = { path: string; content: string };

/**
 * Closes fenced `{path=…}` files as they stream, so an abandoned or capped build
 * can still be kept ("Keep what was built") with the files it did finish.
 *
 * This replaces an accumulator kept in the generate route's stream loop, which
 * had two faults that only showed up in a kept partial build:
 *
 * - It appended the chunk and *then* cleared itself on an opener, so everything
 *   the opener chunk carried after `{path=…}` was discarded, and the close
 *   handler stripped a further line on top of that. Kept files came back missing
 *   their first line — usually the top `import` — so the kept site did not
 *   compile.
 * - It handled one opener per chunk and checked for the close afterwards, so a
 *   chunk that ended one file and opened the next dropped the first entirely.
 *
 * Paths are validated here rather than at the far end: a kept build is written
 * with `toLastCode` (`lib/projects/last-code.ts`), which stores whatever key it
 * is handed.
 */
export class StreamedFileTracker {
  private buffer = '';
  /** Inside a fenced file: the validated path, or null while skipping an unsafe one. */
  private path: string | null = null;
  private inFile = false;
  private body = '';
  private readonly rejected: string[] = [];

  /** Paths dropped for failing {@link sanitizeGenerationPath}, in the order seen. */
  get rejectedPaths(): readonly string[] {
    return this.rejected;
  }

  /** The file currently streaming, or null between files. */
  get openPath(): string | null {
    return this.path;
  }

  /** Feeds one stream chunk; returns the files this chunk finished. */
  push(chunk: string): StreamedFile[] {
    const closed: StreamedFile[] = [];
    let pending = this.buffer + chunk;
    this.buffer = '';

    while (pending) {
      const open = pending.match(FENCE_OPEN_RE);
      const openAt = open?.index ?? -1;

      if (!this.inFile) {
        if (openAt === -1 || !open) {
          this.buffer = pending.slice(-LOOKBEHIND);
          return closed;
        }
        const safe = sanitizeGenerationPath(open[1]);
        if (safe.ok) {
          this.path = safe.path;
        } else {
          this.path = null;
          this.rejected.push(open[1].trim());
        }
        this.inFile = true;
        this.body = '';
        // The body starts at the end of the opener, inside this very chunk.
        pending = pending.slice(openAt + open[0].length);
        continue;
      }

      const closeAt = pending.search(FENCE_CLOSE_RE);
      // The fence the scan found may be the *next* opener — a model that never closed this
      // file — and its own leading newline is what FENCE_CLOSE_RE matched. End the file
      // there either way, but leave the opener in place for the loop above instead of
      // consuming it as a close fence, which used to lose the whole following file.
      const openerIsNext = openAt !== -1 && (closeAt === -1 || openAt <= closeAt + 1);
      if (closeAt === -1 && !openerIsNext) {
        // Hold the tail back so a fence straddling two chunks is still matched.
        const keepFrom = Math.max(0, pending.length - LOOKBEHIND);
        this.body += pending.slice(0, keepFrom);
        this.buffer = pending.slice(keepFrom);
        return closed;
      }
      const bodyEnd = openerIsNext && (closeAt === -1 || openAt < closeAt) ? openAt : closeAt;
      this.body += pending.slice(0, bodyEnd);
      const content = this.body.trim();
      // Mirror the batch parser, which skips a fence with nothing in it
      // (`extractCodeBlocks`: `if (!resolved.code.trim()) continue`). Emitting it here
      // put a zero-byte file into `Job.partialFiles`, so "Keep what was built" wrote a
      // file the normal settle path would never have created — and it spent one of
      // `maxFilesPerJob` doing it.
      if (this.path && content) {
        closed.push({ path: this.path, content });
      }
      this.inFile = false;
      this.path = null;
      this.body = '';
      // `\n``` ` is four characters; anything after it is prose or the next opener.
      pending = openerIsNext ? pending.slice(openAt) : pending.slice(closeAt + 4);
    }
    return closed;
  }
}
