import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { OPTIONAL_PREVIEW_DEPS, PREVIEW_DEPS } from '@/lib/preview/deps';
import {
  SECTION_REGISTRY_NAMES,
  renderSectionUsage,
  sectionEntry,
} from '@/lib/stacks/section-registry';
import { getStackScaffold } from '@/lib/stacks/templates';
import { ParseFilesError } from '../parse-files';
import type { GenerationFileStore } from './file-store';

/**
 * The tools a generation may call.
 *
 * Generation used to be one text completion parsed for ` ```lang{path=…} `
 * fences: the model wrote prose that happened to contain code, and a regex
 * decided what a file was. That works until it doesn't — an unclosed fence, a
 * path in a comment, a filename repeated on the first line inside the block —
 * and every one of those failures is silent, because a reply that parses to
 * zero files is indistinguishable from a reply that answered a question.
 *
 * A tool call is a typed, validated boundary instead. The model says what it
 * wants; the store decides whether that is a legal file; the result the model
 * reads back is what actually happened. A refusal is *returned*, never thrown:
 * a model that hears "that path is not allowed" corrects itself on the next
 * step, whereas a throw ends a run the user has already paid for.
 *
 * Every tool returns a short, factual line and *returns* its refusals. A
 * refusal is never thrown: a model that hears "that path is not allowed" or
 * "search appears 3 times" corrects itself on the next step, whereas a throw
 * ends a run the user has already paid for.
 *
 * The writing tools are `write_file`, `edit_file` and `rename_file` — each goes
 * through `store.write`, so all three are held to one gate. `read_file`,
 * `search_files` and `delete_file` write nothing through it; `delete_file`
 * records a deletion the store keeps separately from its writes, because the
 * persist payload is a path→content map in which an empty string is a legal
 * file rather than a "remove this" sentinel.
 */

export type GenerationToolEvent =
  | { phase: 'call'; tool: string; path?: string }
  | {
      phase: 'result';
      tool: string;
      path?: string;
      ok: boolean;
      detail: string;
      /**
       * The complete file, on a successful write only.
       *
       * The client's file rail has no other source for it: the tool arguments are
       * not forwarded to the browser, so without this every tool-written file
       * arrived on the rail as a filename with an empty body while the fence path
       * showed the code. Taken from the accepted write rather than from `detail`,
       * which is a one-line summary. Left undefined on a refusal — there is no
       * file — and on tools that write nothing.
       */
      content?: string;
    };

export type GenerationToolDeps = {
  store: GenerationFileStore;
  /**
   * Rearms the provider idle bound and emits an SSE frame.
   *
   * Both halves matter. A tool that runs for a second emits no stream part
   * while it runs, and the route kills a stream that has been quiet for five
   * minutes — so a step that only calls tools has to say so, or a healthy run
   * is reaped. The frame is what puts the write in the chat and on the file
   * rail.
   */
  notify: (event: GenerationToolEvent) => void;
};

/** A tool's own failure, phrased for the model rather than for a log. */
function refusal(error: unknown): string {
  if (error instanceof ParseFilesError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

/** How many characters of a file the miss/ambiguity hints quote back. */
const HINT_LINES = 40;
/** Cap on `search_files` matches, so one broad query cannot fill the context window. */
const MAX_SEARCH_MATCHES = 40;
/** How many near-miss paths a failed `read_file` names. */
const NEAR_MATCHES = 3;

/**
 * The paths closest to one the project does not have.
 *
 * A miss is answered with suggestions rather than a bare "not found" because the
 * model's next move should be a corrected read, not a guess or a giving-up
 * rewrite of a file it never saw. Ranked by basename equality first — the usual
 * mistake is the right filename in the wrong directory — then by shared prefix.
 */
function nearestPaths(target: string, paths: readonly string[]): string[] {
  const wanted = target.split('/').pop() ?? target;
  const score = (candidate: string): number => {
    const base = candidate.split('/').pop() ?? candidate;
    let points = 0;
    if (base === wanted) points += 1000;
    else if (base.toLowerCase() === wanted.toLowerCase()) points += 500;
    let shared = 0;
    while (
      shared < candidate.length &&
      shared < target.length &&
      candidate[shared] === target[shared]
    ) {
      shared += 1;
    }
    return points + shared;
  };
  return [...paths].sort((a, b) => score(b) - score(a)).slice(0, NEAR_MATCHES);
}

/** The head of a file with 1-based line numbers, so the model can see real whitespace. */
function numberedHead(content: string): string {
  return content
    .split('\n')
    .slice(0, HINT_LINES)
    .map((line, index) => `${index + 1}: ${line}`)
    .join('\n');
}

/**
 * What chat says when a run used every tool step it was allowed.
 *
 * A warning on a *succeeded* job, never a failure: the store is the authoritative
 * output and every file in it went through the same write gate as any other, so
 * partial work here is real, validated work. Failing the job would throw away
 * files the user has already paid for and offer a Try again that would spend the
 * same budget on the same first half.
 */
export const AGENT_STEP_BUDGET_MESSAGE =
  'This needed more steps than one request allows, so I stopped and saved everything I finished. Ask for the next piece and I will carry on.';

/**
 * Whether a run stopped because it ran out of steps rather than because it was done.
 *
 * `>=`, not `===`: the SDK stops *at* the limit, and a provider that reports one
 * extra step must not read as "finished normally" — which is the reading that would
 * suppress the warning and let a half-built site be announced as complete.
 */
export function exhaustedStepBudget(steps: number, limit: number): boolean {
  return limit > 0 && steps >= limit;
}

/**
 * `zod@4`, `zod@^4.0.0` and `zod` all mean `zod`: the version the product pins is
 * the only one that resolves, so a requested one is dropped rather than honoured.
 * A scoped name keeps its leading `@`.
 */
function stripVersionSuffix(requested: string): string {
  const trimmed = requested.trim();
  const at = trimmed.lastIndexOf('@');
  return at > 0 ? trimmed.slice(0, at) : trimmed;
}

/** Where this stack keeps its manifest. REACT nests the app under `src/`. */
function manifestPathFor(store: GenerationFileStore): string {
  return store.read('package.json') !== null || store.stack !== 'REACT'
    ? 'package.json'
    : store.read('src/package.json') !== null
      ? 'src/package.json'
      : 'package.json';
}

/**
 * The manifest with one dependency merged in, pinned.
 *
 * A project whose base carries no manifest is seeded from its own stack scaffold
 * rather than from a hand-written literal, so the seeded file is the one the
 * exported repo would have shipped anyway.
 */
function withDependency(
  current: string | null,
  name: string,
  version: string,
  stack: string,
): string {
  const source = current ?? scaffoldManifest(stack);
  const parsed: unknown = JSON.parse(source);
  const manifest: Record<string, unknown> = isPlainObject(parsed) ? { ...parsed } : {};
  const existing: unknown = manifest.dependencies;
  const dependencies: Record<string, unknown> = isPlainObject(existing) ? { ...existing } : {};
  dependencies[name] = version;
  manifest.dependencies = sortedByKey(dependencies);
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Stable key order, so adding a dependency is a one-line diff. */
function sortedByKey(entries: Record<string, unknown>): Record<string, unknown> {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(entries).sort()) sorted[key] = entries[key];
  return sorted;
}

function scaffoldManifest(stack: string): string {
  const file = getStackScaffold(stack).find((entry) => entry.path === 'package.json');
  return file?.content ?? '{\n  "dependencies": {}\n}\n';
}

export function buildGenerationTools(deps: GenerationToolDeps): ToolSet {
  const { store, notify } = deps;

  return {
    write_file: tool({
      description:
        'Create a new file or completely replace an existing one. content must be the COMPLETE file — no placeholders, no "rest unchanged", no truncation.',
      inputSchema: z.object({
        path: z.string().min(1).max(400),
        content: z.string(),
      }),
      execute: async ({ path, content }) => {
        notify({ phase: 'call', tool: 'write_file', path });
        try {
          const write = store.write(path, content);
          const lines = write.content.split('\n').length;
          const detail = `${write.kind === 'create' ? 'Wrote' : 'Updated'} ${write.path} (${lines} ${
            lines === 1 ? 'line' : 'lines'
          })`;
          notify({
            phase: 'result',
            tool: 'write_file',
            path: write.path,
            ok: true,
            detail,
            content: write.content,
          });
          return detail;
        } catch (error) {
          const detail = refusal(error);
          notify({ phase: 'result', tool: 'write_file', path, ok: false, detail });
          return detail;
        }
      },
    }),
    read_file: tool({
      description:
        'Read the current contents of a project file. Use before editing any file you have not already seen this turn.',
      inputSchema: z.object({ path: z.string().min(1).max(400) }),
      execute: async ({ path }) => {
        notify({ phase: 'call', tool: 'read_file', path });
        const content = store.read(path);
        if (content === null) {
          const near = nearestPaths(path, store.paths());
          const detail = near.length
            ? `No file at ${path}. Closest paths: ${near.join(', ')}.`
            : `No file at ${path}. The project has no files yet.`;
          notify({ phase: 'result', tool: 'read_file', path, ok: false, detail });
          return detail;
        }
        const lines = content.split('\n').length;
        notify({
          phase: 'result',
          tool: 'read_file',
          path,
          ok: true,
          detail: `Read ${path} (${lines} ${lines === 1 ? 'line' : 'lines'})`,
        });
        return content;
      },
    }),

    edit_file: tool({
      description:
        'Change part of an existing file by exact string replacement. search must appear in the file exactly once, including whitespace. Prefer this over write_file for a small change to a large file.',
      inputSchema: z.object({
        path: z.string().min(1).max(400),
        search: z.string().min(1),
        replace: z.string(),
      }),
      execute: async ({ path, search, replace }) => {
        notify({ phase: 'call', tool: 'edit_file', path });
        const current = store.read(path);
        if (current === null) {
          const near = nearestPaths(path, store.paths());
          const detail = near.length
            ? `No file at ${path}. Closest paths: ${near.join(', ')}.`
            : `No file at ${path}.`;
          notify({ phase: 'result', tool: 'edit_file', path, ok: false, detail });
          return detail;
        }
        // Counted with `split`, not a regex: `search` is model-supplied text and
        // would have to be escaped to be a safe pattern.
        const occurrences = current.split(search).length - 1;
        if (occurrences === 0) {
          // The file's own head, numbered, rather than "not found" alone: the
          // usual cause is invisible whitespace, which the model cannot correct
          // from a refusal that does not show it.
          const detail = `search not found in ${path}.`;
          notify({ phase: 'result', tool: 'edit_file', path, ok: false, detail });
          return `${detail}\nFirst ${HINT_LINES} lines of ${path}:\n${numberedHead(current)}`;
        }
        if (occurrences > 1) {
          // Changes nothing on purpose: replacing the first of several matches is
          // how an edit silently lands in the wrong place.
          const detail = `search appears ${occurrences} times in ${path}; include more surrounding context to make it unique.`;
          notify({ phase: 'result', tool: 'edit_file', path, ok: false, detail });
          return detail;
        }
        try {
          // Through `store.write`, so an edit is held to the same path, size,
          // binary and package.json-validity gate as a full write.
          const write = store.write(path, current.replace(search, replace));
          const detail = `Edited ${write.path} (1 replacement)`;
          notify({
            phase: 'result',
            tool: 'edit_file',
            path: write.path,
            ok: true,
            detail,
            content: write.content,
          });
          return detail;
        } catch (error) {
          const detail = refusal(error);
          notify({ phase: 'result', tool: 'edit_file', path, ok: false, detail });
          return detail;
        }
      },
    }),

    search_files: tool({
      description:
        'Find a literal substring across the project. Use this to locate a component or symbol instead of guessing a path. query is plain text, not a regular expression.',
      inputSchema: z.object({
        query: z.string().min(1).max(200),
        include: z.string().max(200).optional(),
      }),
      execute: async ({ query, include }) => {
        notify({ phase: 'call', tool: 'search_files' });
        const files = store.snapshot();
        const needle = query.toLowerCase();
        const filter = include?.toLowerCase();
        const matches: string[] = [];
        let total = 0;
        let searched = 0;
        for (const path of Object.keys(files).sort()) {
          if (filter && !path.toLowerCase().includes(filter)) continue;
          searched += 1;
          const lines = files[path].split('\n');
          for (let i = 0; i < lines.length; i += 1) {
            if (!lines[i].toLowerCase().includes(needle)) continue;
            total += 1;
            if (matches.length < MAX_SEARCH_MATCHES) {
              matches.push(`${path}:${i + 1}: ${lines[i].trim()}`);
            }
          }
        }
        if (total === 0) {
          // The file count is the difference between "this project does not
          // contain that" and "the include filter matched nothing", which are
          // opposite next moves.
          const detail = `No match for "${query}". Searched ${searched} ${
            searched === 1 ? 'file' : 'files'
          }.`;
          notify({ phase: 'result', tool: 'search_files', ok: true, detail });
          return detail;
        }
        const detail = `${total} ${total === 1 ? 'match' : 'matches'} for "${query}"`;
        notify({ phase: 'result', tool: 'search_files', ok: true, detail });
        const truncated =
          total > matches.length
            ? `\nShowing the first ${matches.length} of ${total} matches.`
            : '';
        return `${matches.join('\n')}${truncated}`;
      },
    }),

    delete_file: tool({
      description:
        'Remove a file from the project. Use only when the file should no longer exist — to change a file, use edit_file or write_file.',
      inputSchema: z.object({ path: z.string().min(1).max(400) }),
      execute: async ({ path }) => {
        notify({ phase: 'call', tool: 'delete_file', path });
        const removed = store.remove(path);
        const detail = removed ? `Deleted ${path}` : `No file at ${path}; nothing deleted.`;
        notify({ phase: 'result', tool: 'delete_file', path, ok: removed, detail });
        return detail;
      },
    }),

    rename_file: tool({
      description:
        'Move a file to a new path, keeping its contents. Remember to update every import that referred to the old path.',
      inputSchema: z.object({
        from: z.string().min(1).max(400),
        to: z.string().min(1).max(400),
      }),
      execute: async ({ from, to }) => {
        notify({ phase: 'call', tool: 'rename_file', path: to });
        const content = store.read(from);
        if (content === null) {
          const near = nearestPaths(from, store.paths());
          const detail = near.length
            ? `No file at ${from}. Closest paths: ${near.join(', ')}.`
            : `No file at ${from}; nothing renamed.`;
          notify({ phase: 'result', tool: 'rename_file', path: to, ok: false, detail });
          return detail;
        }
        // Refused rather than merged: overwriting an existing file through a
        // rename destroys it with no way for the model to notice.
        if (store.read(to) !== null) {
          const detail = `${to} already exists; nothing renamed. Delete it first, or pick another path.`;
          notify({ phase: 'result', tool: 'rename_file', path: to, ok: false, detail });
          return detail;
        }
        try {
          // Write first, then remove: `to` goes through the same
          // `assertWritableGenerationFile` gate as every other write, so a
          // refusal leaves `from` untouched.
          const write = store.write(to, content);
          store.remove(from);
          const detail = `Renamed ${from} to ${write.path}`;
          notify({
            phase: 'result',
            tool: 'rename_file',
            path: write.path,
            ok: true,
            detail,
            content: write.content,
          });
          return detail;
        } catch (error) {
          const detail = refusal(error);
          notify({ phase: 'result', tool: 'rename_file', path: to, ok: false, detail });
          return detail;
        }
      },
    }),

    use_section: tool({
      description:
        'Get a ready-to-paste section from the locked kit, with your content already filled in. Returns the import lines and the JSX. Prefer this over hand-writing a <section>: it validates your content against the component and comes back with the section rhythm, the entrance motion and the surface already handled.',
      inputSchema: z.object({
        name: z.string().min(1).max(60),
        /**
         * The section's content. Validated against the registry, so a misspelt or invented
         * field is a refusal the model reads on the same step — not a wrong prop that
         * bundles clean and fails `next build` in the client's repository weeks later.
         */
        content: z.record(z.string(), z.unknown()).optional(),
        /** Optional slots to include, e.g. `media` on the hero. */
        slots: z.array(z.string().min(1).max(40)).max(6).optional(),
      }),
      execute: async ({ name, content, slots }) => {
        notify({ phase: 'call', tool: 'use_section', path: name });
        const entry = sectionEntry(name);
        if (!entry) {
          const detail = `There is no section called ${name}.`;
          notify({ phase: 'result', tool: 'use_section', path: name, ok: false, detail });
          // The full catalogue, so the next step is a choice rather than a guess — the
          // same contract `add_dependency` uses when it refuses a package.
          return [detail, `Available sections: ${SECTION_REGISTRY_NAMES.join(', ')}.`].join('\n');
        }

        const parsed = entry.props.safeParse(content ?? {});
        if (!parsed.success) {
          // Named field by field. "Invalid input" tells the model nothing it can act on,
          // and a retry that guesses again costs another step from the budget.
          const problems = parsed.error.issues
            .slice(0, 8)
            .map((issue) => `- ${issue.path.join('.') || '(root)'}: ${issue.message}`);
          const detail = `The content does not match ${name}.`;
          notify({ phase: 'result', tool: 'use_section', path: name, ok: false, detail });
          return [detail, ...problems].join('\n');
        }

        // The stack decides the media slot's spelling: `next/image` on NEXTJS, a sized
        // `<img>` elsewhere. Without it the tool handed a NEXTJS build a raw <img> that
        // the pipeline's own raw-img advisory then criticised.
        const usage = renderSectionUsage(name, parsed.data, {
          includeOptionalSlots: slots,
          stack: store.stack,
        });
        const unknownSlots = (slots ?? []).filter(
          (slot) => !entry.slots.some((known) => known.name === slot),
        );
        const detail = `Rendered ${name}.`;
        notify({ phase: 'result', tool: 'use_section', path: name, ok: true, detail });
        return [
          `${usage.imports.join('\n')}`,
          '',
          usage.jsx,
          '',
          unknownSlots.length > 0
            ? `Ignored unknown slot(s): ${unknownSlots.join(', ')}. ${name} accepts ${entry.slots.map((slot) => slot.name).join(', ') || 'no slots'}.`
            : '',
          'Paste the JSX into the page and add the imports at the top. Edit the copy; keep the prop names.',
        ]
          .filter(Boolean)
          .join('\n');
      },
    }),

    add_dependency: tool({
      description:
        'Make an npm package available to this project. Only packages from the supported list resolve; anything else must be replaced with code.',
      inputSchema: z.object({ package: z.string().min(1).max(120) }),
      execute: async ({ package: requested }) => {
        // The pin is the product's, not the model's: a version it asks for would
        // put an unreviewed build on the import map of every future reload.
        const name = stripVersionSuffix(requested);
        notify({ phase: 'call', tool: 'add_dependency', path: name });
        if (name in PREVIEW_DEPS) {
          const detail = `${name} is already available; import it directly.`;
          notify({ phase: 'result', tool: 'add_dependency', path: name, ok: true, detail });
          return detail;
        }
        const version = OPTIONAL_PREVIEW_DEPS[name];
        if (!version) {
          const detail = `${name} is not available.`;
          notify({ phase: 'result', tool: 'add_dependency', path: name, ok: false, detail });
          return [
            detail,
            `Available on request: ${Object.keys(OPTIONAL_PREVIEW_DEPS).sort().join(', ')}.`,
            `Already available: ${Object.keys(PREVIEW_DEPS).sort().join(', ')}.`,
          ].join('\n');
        }
        // STATIC_HTML has no manifest and no module graph by design, so there is
        // nowhere for a dependency to be declared.
        if (store.stack === 'STATIC_HTML') {
          const detail = `This project is a single static HTML page, so it has no package.json; ${name} cannot be added. Write the behaviour in plain JavaScript instead.`;
          notify({ phase: 'result', tool: 'add_dependency', path: name, ok: false, detail });
          return detail;
        }
        const manifestPath = manifestPathFor(store);
        const current = store.read(manifestPath);
        try {
          const next = withDependency(current, name, version, store.stack);
          // Through `store.write`, so the JSON-validity guard applies — an invalid
          // package.json ships to the deploy repo and fails the build there.
          const write = store.write(manifestPath, next);
          const detail = `Added ${name}@${version}. Dependencies resolve from the CDN — there is no install step.`;
          notify({
            phase: 'result',
            tool: 'add_dependency',
            path: write.path,
            ok: true,
            detail,
            content: write.content,
          });
          return detail;
        } catch (error) {
          const detail = refusal(error);
          notify({ phase: 'result', tool: 'add_dependency', path: name, ok: false, detail });
          return detail;
        }
      },
    }),
  };
}
