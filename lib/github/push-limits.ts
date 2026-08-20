/**
 * What one publish push may contain, refused before the request is built.
 *
 * `pushFiles` puts a whole site into a single `POST /git/trees`: every text file rides
 * inline in that one JSON body, and every binary file is uploaded as a blob first. Neither
 * had a bound of any kind (F-261), so a large or binary generated site failed the publish
 * with whatever GitHub said about its own limits — a 4xx about a request body, arriving
 * after the bytes had already been sent, recorded as `provider_error` and read by the user
 * as "the AI service did not respond".
 *
 * Every number below is anchored on a documented GitHub constraint rather than taste; the
 * anchor is named on each one. They are all far above a real generated site, which is the
 * point: this is a transport bound, not a product policy.
 */

/** A text file, or the base64 of a binary one. Binary never rides the inline text field. */
export type PushFileEntry = string | { base64: string };

/**
 * Entries in one tree request.
 *
 * GitHub documents the tree array cap as 100,000 entries (REST API endpoints for Git
 * trees). It is the outer bound — the byte caps below bite long before it on any real
 * site — but a set this large is not a website, and the refusal is cheaper than building
 * a request GitHub will reject.
 */
export const MAX_PUSH_ENTRIES = 100_000;

/**
 * Inline `content` bytes across the whole tree request.
 *
 * 7 MB is GitHub's documented size ceiling for the tree array. Everything with a `content`
 * field is serialised into that one POST body, so this is the number that decides whether
 * the request can exist at all. Binary entries are uploaded as separate blobs and are
 * deliberately *not* counted here.
 */
export const MAX_PUSH_INLINE_BYTES = 7 * 1024 * 1024;

/**
 * One file, text or binary, measured in decoded bytes.
 *
 * GitHub warns above 50 MiB and blocks above 100 MiB, and its browser upload path stops at
 * 25 MiB. The smallest of the three published numbers is the honest ceiling: a file over it
 * either cannot be committed or arrives with a warning attached, and no site asset needs
 * one — uploads are already capped at 10 MB (`MAX_UPLOAD_BYTES`).
 */
export const MAX_PUSH_FILE_BYTES = 25 * 1024 * 1024;

/**
 * The whole push, text plus blobs, in decoded bytes.
 *
 * Not a request-body limit — blobs are separate requests — so it is derived from the
 * repository side instead: GitHub recommends a repository stay under 1 GB, and every
 * publish adds a commit to the same deploy repo, so a per-publish ceiling of 50 MiB keeps
 * twenty publishes inside that recommendation. 50 MiB is also the point at which GitHub
 * starts warning about a single object, which makes it a published number rather than a
 * guess.
 */
export const MAX_PUSH_TOTAL_BYTES = 50 * 1024 * 1024;

/**
 * A lone half of a surrogate pair. Such a string has no UTF-8 encoding: Node's `fetch`
 * substitutes U+FFFD when it encodes the request body, so GitHub would store a file that
 * silently differs from the one generated. Refusing by name beats shipping the corruption.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export type PushRefusalReason = 'too_many_files' | 'file_too_large' | 'too_large' | 'not_text';

/**
 * Thrown by `pushFiles` before it calls GitHub; mapped to the `push_refused` job error code
 * by `publishJobErrorCode`, so the recovery panel renders the sentence built here.
 */
export class PushRefusedError extends Error {
  readonly reason: PushRefusalReason;
  /** The files the refusal is about, largest first — already named in `message`. */
  readonly paths: readonly string[];

  constructor(reason: PushRefusalReason, message: string, paths: readonly string[]) {
    super(message);
    this.name = 'PushRefusedError';
    this.reason = reason;
    this.paths = paths;
  }
}

export function isBinaryPushEntry(entry: PushFileEntry): entry is { base64: string } {
  return typeof entry !== 'string';
}

/** Decoded bytes: base64 is 4/3 of what it carries, and measuring it would over-count. */
export function pushEntryByteLength(entry: PushFileEntry): number {
  return isBinaryPushEntry(entry)
    ? Buffer.byteLength(entry.base64, 'base64')
    : Buffer.byteLength(entry, 'utf8');
}

/**
 * Mirrors `formatExportBytes`, which cannot be imported here: `lib/export/client.ts` is a
 * browser module and touches `document` at import time.
 */
function formatPushBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function largestFirst(sizes: ReadonlyMap<string, number>, count: number) {
  return [...sizes.entries()].sort((a, b) => b[1] - a[1]).slice(0, count);
}

/** "index.html (3.1 MB), hero.webp (2.4 MB)" — what to delete, in the order to delete it. */
function nameContributors(sizes: ReadonlyMap<string, number>) {
  return largestFirst(sizes, 3)
    .map(([path, bytes]) => `${path} (${formatPushBytes(bytes)})`)
    .join(', ');
}

/**
 * Refuses a file set that cannot be pushed, before a single byte is sent.
 *
 * Throws {@link PushRefusedError}; returns the measured totals so the caller does not walk
 * the entries twice.
 */
export function assertPushableFiles(entries: ReadonlyArray<readonly [string, PushFileEntry]>): {
  inlineBytes: number;
  totalBytes: number;
} {
  if (entries.length > MAX_PUSH_ENTRIES) {
    throw new PushRefusedError(
      'too_many_files',
      `This site has ${entries.length} files. One publish is one commit, and GitHub takes at most ` +
        `${MAX_PUSH_ENTRIES} files in it — remove some files and publish again.`,
      [],
    );
  }

  const sizes = new Map<string, number>();
  /** Text only: the inline refusal must name files the reader can shrink, not blobs. */
  const textSizes = new Map<string, number>();
  let inlineBytes = 0;
  let totalBytes = 0;

  for (const [path, entry] of entries) {
    const bytes = pushEntryByteLength(entry);
    sizes.set(path, bytes);
    totalBytes += bytes;

    if (bytes > MAX_PUSH_FILE_BYTES) {
      throw new PushRefusedError(
        'file_too_large',
        `"${path}" is ${formatPushBytes(bytes)}. GitHub blocks a single file over 100 MB and warns ` +
          `above 50 MB, so publish stops at ${formatPushBytes(MAX_PUSH_FILE_BYTES)} — remove or ` +
          `shrink that file and publish again.`,
        [path],
      );
    }

    if (isBinaryPushEntry(entry)) continue;
    inlineBytes += bytes;
    textSizes.set(path, bytes);
    // Only text is inspected, and only for the one shape that cannot survive the wire.
    // Binary content is not a defect here: it travels as base64 through the blobs endpoint.
    if (LONE_SURROGATE.test(entry)) {
      throw new PushRefusedError(
        'not_text',
        `"${path}" contains characters that cannot be stored as text, so publishing it would ` +
          `change its contents. Remove or rewrite that file and publish again.`,
        [path],
      );
    }
  }

  if (inlineBytes > MAX_PUSH_INLINE_BYTES) {
    throw new PushRefusedError(
      'too_large',
      `The text files in this site come to ${formatPushBytes(inlineBytes)}. They all travel in one ` +
        `GitHub request, which takes at most ${formatPushBytes(MAX_PUSH_INLINE_BYTES)}. The largest ` +
        `are ${nameContributors(textSizes)} — remove or shrink them and publish again.`,
      largestFirst(textSizes, 3).map(([path]) => path),
    );
  }

  if (totalBytes > MAX_PUSH_TOTAL_BYTES) {
    throw new PushRefusedError(
      'too_large',
      `This site comes to ${formatPushBytes(totalBytes)}, and publish sends at most ` +
        `${formatPushBytes(MAX_PUSH_TOTAL_BYTES)} in one go. The largest files are ` +
        `${nameContributors(sizes)} — remove or shrink them and publish again.`,
      largestFirst(sizes, 3).map(([path]) => path),
    );
  }

  return { inlineBytes, totalBytes };
}
