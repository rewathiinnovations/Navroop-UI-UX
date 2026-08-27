import type { StackId } from '@/lib/stacks';
import { sanitizeGenerationPath } from '../parse-files';
import { assertWritableGenerationFile } from '../write-guard';

/**
 * The turn's file state, for the tool-calling generation path.
 *
 * The fence path parses one text completion at the end; the tool path
 * accumulates writes as they happen, and something has to hold them. This is
 * that thing, and it is deliberately the *only* place a tool write becomes a
 * file: `write` goes through `assertWritableGenerationFile`, the same gate the
 * parsed-fence path uses, so a tool cannot persist something a fence could not.
 * Path safety, binary content, the per-file size cap and `package.json`
 * JSON-validity are all decided there rather than restated here.
 *
 * `base` is the project as this turn found it. It is never mutated: the store
 * layers writes on top, so `snapshot()` is what the model should believe the
 * project looks like right now, while `writtenFiles()` is only what this turn
 * changed — which is what gets persisted and what `changedPaths` is derived
 * from. Conflating the two would make a one-line edit look like a full rewrite
 * to the validator and to the credit accounting.
 */

export type ToolFileWrite = {
  path: string;
  content: string;
  kind: 'create' | 'update';
};

export type GenerationFileStore = {
  /** Project files this turn started from, plus every accepted write, minus every deletion. */
  snapshot(): Record<string, string>;
  read(path: string): string | null;
  /** Sanitised paths of everything currently visible, for near-match hints and search. */
  paths(): string[];
  /** Validated through `assertWritableGenerationFile`; throws `ParseFilesError` on refusal. */
  write(path: string, content: string): ToolFileWrite;
  /**
   * Drop a file from the project. `true` when something was there to drop.
   *
   * Deletions are tracked separately from writes rather than encoded into
   * `writtenFiles()`, because that map is `Record<string, string>` where a key
   * means "store this content" — an empty string is a legal file, so `''` as a
   * "delete me" sentinel would make an empty file and a deletion the same value.
   */
  remove(path: string): boolean;
  /** Ordered, de-duplicated paths this turn deleted — the other half of the persist payload. */
  deletedPaths(): string[];
  /** Ordered, de-duplicated by path, last write wins — the persist payload. */
  writtenFiles(): Record<string, string>;
  writtenPaths(): string[];
  /** Every accepted write in order, including repeats — for the step-budget report. */
  journal(): readonly ToolFileWrite[];
  readonly stack: StackId;
};

export function createGenerationFileStore(input: {
  base: Record<string, string>;
  stack: StackId;
}): GenerationFileStore {
  // Copied rather than referenced: `base` is the route's own map of the stored
  // project, and a tool write must not reach back into it.
  const base = { ...input.base };
  const written = new Map<string, string>();
  const deleted = new Set<string>();
  const journal: ToolFileWrite[] = [];

  const snapshot = (): Record<string, string> => {
    const files: Record<string, string> = { ...base, ...Object.fromEntries(written) };
    for (const path of deleted) delete files[path];
    return files;
  };

  /**
   * The spelling `write` would have produced, without the content checks.
   *
   * A model that writes `./app/page.tsx` or `app/page.tsx` means one file, and
   * `write` normalises through the guard — so a delete or a read that skipped
   * normalisation would miss the file it had just written.
   */
  const normalize = (path: string): string => {
    const safe = sanitizeGenerationPath(path ?? '');
    return safe.ok ? safe.path : '';
  };

  return {
    stack: input.stack,
    snapshot,
    read(path) {
      const files = snapshot();
      if (path in files) return files[path];
      const normalized = normalize(path);
      return normalized && normalized in files ? files[normalized] : null;
    },
    paths() {
      return Object.keys(snapshot()).sort();
    },
    write(path, content) {
      const file = assertWritableGenerationFile({ path, content });
      // `kind` is decided against the turn's starting state, not against
      // previous writes: a file this turn created and then rewrote is still a
      // `create` from the project's point of view, and reporting the second
      // write as an `update` would tell the user a file existed before it did.
      const kind: ToolFileWrite['kind'] = file.path in base ? 'update' : 'create';
      written.set(file.path, file.content);
      // Writing a path this turn deleted revives it — that is what a rename
      // back, or a delete-then-rewrite, means. Leaving it in `deleted` would
      // have the persist step remove the file the model had just written.
      deleted.delete(file.path);
      const entry: ToolFileWrite = { path: file.path, content: file.content, kind };
      journal.push(entry);
      return entry;
    },
    remove(path) {
      const normalized = normalize(path);
      if (!normalized) return false;
      const existed = normalized in snapshot();
      if (!existed) return false;
      // Dropped from `written` as well: a file created and then deleted in one
      // turn must not be handed to the persist step at all, and a path in both
      // maps would be written and removed by the same settle.
      written.delete(normalized);
      deleted.add(normalized);
      return true;
    },
    deletedPaths() {
      return [...deleted];
    },
    writtenFiles() {
      return Object.fromEntries(written);
    },
    writtenPaths() {
      return [...written.keys()];
    },
    journal() {
      return journal;
    },
  };
}
