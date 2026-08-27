import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyStreamPart } from '@/lib/generation/stream-parts';
import {
  AGENT_STEP_BUDGET_MESSAGE,
  buildGenerationTools,
  exhaustedStepBudget,
  type GenerationToolEvent,
} from '@/lib/generation/tools';
import { createGenerationFileStore } from '@/lib/generation/tools/file-store';
import { OPTIONAL_PREVIEW_DEPS } from '@/lib/preview/deps';
import { withStarterFiles } from '@/lib/stacks/starter';

/**
 * The tool surface, and the two ways it can be wired wrong silently.
 *
 * A tool that throws instead of returning its refusal ends a run the user has
 * already paid for; a tool part the stream classifier does not recognise makes a
 * healthy tool-writing generation look stalled, because the route's collect loop
 * `continue`s on `ignore` before it rearms the idle bound. Neither shows up as
 * an error — the first looks like a provider failure, the second like a five
 * minute hang — so both are asserted here rather than left to a smoke test.
 */

const BASE = {
  'app/page.tsx': 'export default function Page() { return null; }',
  'package.json': JSON.stringify({ name: 'app', dependencies: {} }, null, 2),
};

function harness() {
  const store = createGenerationFileStore({ base: { ...BASE }, stack: 'NEXTJS' });
  const events: GenerationToolEvent[] = [];
  const tools = buildGenerationTools({ store, notify: (event) => events.push(event) });
  // The SDK passes a second options argument every tool ignores; the cast keeps
  // each helper honest about calling the real `execute` rather than a wrapper.
  const exec = <TInput>(name: string) => {
    const entry = tools[name];
    if (!entry?.execute) throw new Error(`${name} has no execute`);
    return (input: TInput) => (entry.execute as (i: TInput) => Promise<string>)(input);
  };
  const writeCall = exec<{ path: string; content: string }>('write_file');
  const call = (path: string, content: string) => writeCall({ path, content });
  return {
    store,
    events,
    call,
    read: exec<{ path: string }>('read_file'),
    edit: exec<{ path: string; search: string; replace: string }>('edit_file'),
    search: exec<{ query: string; include?: string }>('search_files'),
    remove: exec<{ path: string }>('delete_file'),
    rename: exec<{ from: string; to: string }>('rename_file'),
    addDep: exec<{ package: string }>('add_dependency'),
  };
}

describe('write_file', () => {
  it('creates a new file and updates an existing one', async () => {
    const { store, call } = harness();

    const created = await call('components/Hero.tsx', 'export const Hero = () => null;\n');
    expect(created).toContain('components/Hero.tsx');

    const updated = await call('app/page.tsx', 'export default function Page() { return <div/>; }');
    expect(updated).toContain('app/page.tsx');

    expect(store.writtenFiles()).toEqual({
      'components/Hero.tsx': 'export const Hero = () => null;\n',
      'app/page.tsx': 'export default function Page() { return <div/>; }',
    });
    // `kind` is decided against the turn's starting state: the second write is
    // an update because the file was already in the project.
    expect(store.journal().map((row) => row.kind)).toEqual(['create', 'update']);
  });

  it('reports a line count a reader can check', async () => {
    const { call } = harness();
    expect(await call('a.ts', 'one\ntwo\nthree')).toContain('(3 lines)');
    expect(await call('b.ts', 'only')).toContain('(1 line)');
  });

  it('refuses a traversal path by returning the guard message, not throwing', async () => {
    const { store, call } = harness();
    // A throw here would kill a paid run. The model gets the refusal as a tool
    // result and can correct itself on the next step.
    const result = await call('../outside.ts', 'export const x = 1;');
    expect(result).toMatch(/unsafe file path/i);
    expect(store.writtenFiles()).toEqual({});
    expect(store.journal()).toEqual([]);
  });

  it('refuses a package.json that is not valid JSON', async () => {
    const { store, call } = harness();
    const result = await call('package.json', '{ "name": ');
    expect(result).toMatch(/package\.json is not valid JSON/i);
    // The project's original package.json is untouched.
    expect(store.writtenFiles()).toEqual({});
    expect(store.read('package.json')).toBe(BASE['package.json']);
  });

  it('emits a call frame and a result frame for every attempt, refusals included', async () => {
    const { events, call } = harness();
    await call('app/page.tsx', 'export default function P() { return null; }');
    await call('../nope.ts', 'x');

    expect(events.filter((row) => row.phase === 'call')).toHaveLength(2);
    const results = events.filter(
      (row): row is Extract<GenerationToolEvent, { phase: 'result' }> => row.phase === 'result',
    );
    expect(results.map((row) => row.ok)).toEqual([true, false]);
    // The failing frame carries the reason, so the chat can say what happened
    // instead of showing a write that silently never landed.
    expect(results[1].detail).toMatch(/unsafe file path/i);
  });

  it('the store layers writes over the base without mutating it', async () => {
    const base = { ...BASE };
    const store = createGenerationFileStore({ base, stack: 'NEXTJS' });
    store.write('app/page.tsx', 'changed');
    expect(store.read('app/page.tsx')).toBe('changed');
    expect(store.snapshot()['app/page.tsx']).toBe('changed');
    // The route's own map of the stored project must not move under it.
    expect(base['app/page.tsx']).toBe(BASE['app/page.tsx']);
  });

  it('normalises a path on read the same way the guard does on write', () => {
    const store = createGenerationFileStore({ base: {}, stack: 'NEXTJS' });
    store.write('./app/page.tsx', 'body');
    // A model that writes `./app/page.tsx` and then reads `app/page.tsx` — or
    // the reverse — must not be told its own file is missing.
    expect(store.read('app/page.tsx')).toBe('body');
    expect(store.read('./app/page.tsx')).toBe('body');
    expect(store.writtenPaths()).toEqual(['app/page.tsx']);
  });

  it('last write wins per path, and the journal keeps both', () => {
    const store = createGenerationFileStore({ base: {}, stack: 'NEXTJS' });
    store.write('a.ts', 'first');
    store.write('a.ts', 'second');
    expect(store.writtenFiles()).toEqual({ 'a.ts': 'second' });
    expect(store.writtenPaths()).toEqual(['a.ts']);
    expect(store.journal()).toHaveLength(2);
  });
});

describe('read_file', () => {
  it('returns the file contents', async () => {
    const { read } = harness();
    expect(await read({ path: 'app/page.tsx' })).toBe(BASE['app/page.tsx']);
  });

  it('sees a file written earlier in the same turn', async () => {
    const { call, read } = harness();
    await call('components/Hero.tsx', 'export const Hero = () => null;\n');
    expect(await read({ path: 'components/Hero.tsx' })).toContain('Hero');
  });

  /**
   * A miss names near matches rather than only failing: the usual mistake is the
   * right filename in the wrong directory, and the model's next move should be a
   * corrected read, not a rewrite of a file it never saw.
   */
  it('names the closest paths on a miss instead of only failing', async () => {
    const { read } = harness();
    const answer = await read({ path: 'components/page.tsx' });
    expect(answer).toContain('No file at components/page.tsx');
    expect(answer).toContain('app/page.tsx');
  });

  it('reports a miss by returning it, never by throwing', async () => {
    const { read, events } = harness();
    await expect(read({ path: 'nope.tsx' })).resolves.toContain('No file at nope.tsx');
    expect(events.at(-1)).toMatchObject({ phase: 'result', tool: 'read_file', ok: false });
  });
});

describe('edit_file', () => {
  it('replaces a unique match and writes through the store', async () => {
    const { store, edit } = harness();
    const answer = await edit({
      path: 'app/page.tsx',
      search: 'return null;',
      replace: 'return <div/>;',
    });
    expect(answer).toBe('Edited app/page.tsx (1 replacement)');
    expect(store.writtenFiles()['app/page.tsx']).toContain('return <div/>;');
  });

  it('carries the new content on its result frame, so the rail is not empty', async () => {
    const { edit, events } = harness();
    await edit({ path: 'app/page.tsx', search: 'null', replace: '<div/>' });
    expect(events.at(-1)).toMatchObject({ phase: 'result', tool: 'edit_file', ok: true });
    const last = events.at(-1);
    expect(last && 'content' in last ? last.content : null).toContain('<div/>');
  });

  /**
   * The refusal quotes the file's own numbered head, because the usual cause is
   * whitespace the model cannot see from "not found" alone.
   */
  it('shows numbered lines when the search text is absent', async () => {
    const { store, edit } = harness();
    const answer = await edit({ path: 'app/page.tsx', search: 'nonexistent', replace: 'x' });
    expect(answer).toContain('search not found in app/page.tsx');
    expect(answer).toMatch(/^1: /m);
    expect(store.writtenFiles()).toEqual({});
  });

  /**
   * Changes nothing on an ambiguous match: replacing the first of several is how
   * an edit silently lands in the wrong place.
   */
  it('changes nothing when the search text appears more than once', async () => {
    const { store, call, edit } = harness();
    await call('a.ts', 'const x = 1;\nconst x2 = 1;\n');
    const before = { ...store.writtenFiles() };
    const answer = await edit({ path: 'a.ts', search: '= 1;', replace: '= 2;' });
    expect(answer).toContain('appears 2 times');
    expect(answer).toContain('more surrounding context');
    expect(store.writtenFiles()).toEqual(before);
  });

  it('refuses an edit to a file that does not exist', async () => {
    const { store, edit } = harness();
    expect(await edit({ path: 'nope.tsx', search: 'a', replace: 'b' })).toContain('No file at');
    expect(store.writtenFiles()).toEqual({});
  });
});

describe('search_files', () => {
  it('reports path and line for each match', async () => {
    const { search } = harness();
    const answer = await search({ query: 'export default' });
    expect(answer).toContain('app/page.tsx:1:');
  });

  it('is case-insensitive and literal, not a regular expression', async () => {
    const { call, search } = harness();
    await call('a.ts', 'const COST = 1;\n');
    expect(await search({ query: 'cost' })).toContain('a.ts:1:');
    // A regex metacharacter is matched as text, so this finds nothing rather
    // than matching every line.
    expect(await search({ query: '.*' })).toContain('No match');
  });

  it('filters by path with include', async () => {
    const { call, search } = harness();
    await call('components/Hero.tsx', 'export const Hero = () => null;\n');
    const scoped = await search({ query: 'export', include: 'components/' });
    expect(scoped).toContain('components/Hero.tsx');
    expect(scoped).not.toContain('app/page.tsx');
  });

  /**
   * The searched-file count is the difference between "the project does not
   * contain that" and "the include filter matched nothing", which are opposite
   * next moves.
   */
  it('says how many files it searched when there is no match', async () => {
    const { search } = harness();
    expect(await search({ query: 'zzz' })).toMatch(/No match for "zzz"\. Searched \d+ files?\./);
    expect(await search({ query: 'export', include: 'no-such-dir/' })).toContain('Searched 0 files');
  });

  it('caps the match list and says the real total', async () => {
    const { call, search } = harness();
    await call('big.ts', Array.from({ length: 60 }, (_, i) => `const hit${i} = 1;`).join('\n'));
    const answer = await search({ query: 'hit' });
    expect(answer).toContain('Showing the first 40 of 60 matches.');
    expect(answer.split('\n').filter((line) => line.startsWith('big.ts:'))).toHaveLength(40);
  });
});

describe('delete_file', () => {
  it('removes a file and records it as a deletion, not as a write', async () => {
    const { store, remove } = harness();
    expect(await remove({ path: 'app/page.tsx' })).toBe('Deleted app/page.tsx');
    expect(store.deletedPaths()).toEqual(['app/page.tsx']);
    // Never an empty-string entry in the write payload: an empty file is a legal
    // file, so a sentinel there would be indistinguishable from one.
    expect(store.writtenFiles()).toEqual({});
    expect(store.read('app/page.tsx')).toBeNull();
  });

  it('changes nothing when the file is not there', async () => {
    const { store, remove } = harness();
    expect(await remove({ path: 'nope.tsx' })).toBe('No file at nope.tsx; nothing deleted.');
    expect(store.deletedPaths()).toEqual([]);
  });

  it('a file created and then deleted in one turn reaches neither payload', async () => {
    const { store, call, remove } = harness();
    await call('scratch.ts', 'const a = 1;\n');
    await remove({ path: 'scratch.ts' });
    expect(store.writtenFiles()).toEqual({});
    expect(store.deletedPaths()).toEqual(['scratch.ts']);
  });

  it('writing a deleted path revives it', async () => {
    const { store, remove, call } = harness();
    await remove({ path: 'app/page.tsx' });
    await call('app/page.tsx', 'export default function Page() { return <p/>; }');
    expect(store.deletedPaths()).toEqual([]);
    expect(store.writtenFiles()['app/page.tsx']).toContain('<p/>');
  });
});

describe('rename_file', () => {
  it('moves the content and deletes the old path', async () => {
    const { store, rename } = harness();
    const answer = await rename({ from: 'app/page.tsx', to: 'app/home.tsx' });
    expect(answer).toBe('Renamed app/page.tsx to app/home.tsx');
    expect(store.writtenFiles()['app/home.tsx']).toBe(BASE['app/page.tsx']);
    expect(store.deletedPaths()).toEqual(['app/page.tsx']);
  });

  it('refuses when the source is missing', async () => {
    const { store, rename } = harness();
    expect(await rename({ from: 'nope.tsx', to: 'x.tsx' })).toContain('No file at nope.tsx');
    expect(store.writtenFiles()).toEqual({});
    expect(store.deletedPaths()).toEqual([]);
  });

  /**
   * Refused rather than merged: a rename that overwrites destroys a file with no
   * way for the model to notice.
   */
  it('refuses when the destination already exists', async () => {
    const { store, rename } = harness();
    const answer = await rename({ from: 'app/page.tsx', to: 'package.json' });
    expect(answer).toContain('package.json already exists');
    expect(store.writtenFiles()).toEqual({});
    expect(store.deletedPaths()).toEqual([]);
  });

  it('holds the destination to the same write gate as write_file', async () => {
    const { store, rename } = harness();
    const answer = await rename({ from: 'app/page.tsx', to: '../escape.tsx' });
    expect(answer).toMatch(/Unsafe file path/);
    // The source survives a refused destination.
    expect(store.read('app/page.tsx')).toBe(BASE['app/page.tsx']);
    expect(store.deletedPaths()).toEqual([]);
  });
});

describe('add_dependency', () => {
  it('registers a supported package at the product pin, ignoring the asked version', async () => {
    const { store, addDep } = harness();
    const answer = await addDep({ package: 'zod@4.0.0' });
    expect(answer).toContain('Added zod@');
    // "no install step" is the honest phrasing: resolution is from the CDN.
    expect(answer).toMatch(/no install step/i);
    const manifest = JSON.parse(store.writtenFiles()['package.json']);
    expect(manifest.dependencies.zod).toBe(OPTIONAL_PREVIEW_DEPS.zod);
  });

  it('keeps the dependencies the manifest already had', async () => {
    const { store, addDep } = harness();
    await addDep({ package: 'zod' });
    await addDep({ package: 'react-hook-form' });
    const manifest = JSON.parse(store.writtenFiles()['package.json']);
    expect(Object.keys(manifest.dependencies).sort()).toEqual(['react-hook-form', 'zod']);
    expect(manifest.name).toBe('app');
  });

  it('writes nothing for a package that is already available', async () => {
    const { store, addDep } = harness();
    const answer = await addDep({ package: 'react' });
    expect(answer).toBe('react is already available; import it directly.');
    expect(store.writtenFiles()).toEqual({});
  });

  /**
   * The refusal lists both tiers, because "not available" alone leaves the model
   * guessing again — and a second guess costs another step.
   */
  it('refuses an unlisted package and names both tiers', async () => {
    const { store, addDep } = harness();
    const answer = await addDep({ package: 'left-pad' });
    expect(answer).toContain('left-pad is not available.');
    expect(answer).toContain('Available on request:');
    expect(answer).toContain('Already available:');
    expect(store.writtenFiles()).toEqual({});
  });

  it('produces a manifest the write guard accepts', async () => {
    const { store, addDep } = harness();
    await addDep({ package: 'zod' });
    // The guard refuses a package.json that JSON.parse cannot read, so reaching
    // `writtenFiles` at all is the assertion; parsing it twice is the belt.
    expect(() => JSON.parse(store.writtenFiles()['package.json'])).not.toThrow();
  });

  it('refuses on STATIC_HTML, which has no manifest by design', async () => {
    const store = createGenerationFileStore({ base: {}, stack: 'STATIC_HTML' });
    const tools = buildGenerationTools({ store, notify: () => {} });
    const entry = tools.add_dependency;
    if (!entry?.execute) throw new Error('add_dependency has no execute');
    const answer = await (entry.execute as (i: { package: string }) => Promise<string>)({
      package: 'zod',
    });
    expect(answer).toMatch(/static HTML/i);
    expect(store.writtenFiles()).toEqual({});
  });

  it('seeds a manifest from the stack scaffold when the project has none', async () => {
    const store = createGenerationFileStore({ base: {}, stack: 'NEXTJS' });
    const tools = buildGenerationTools({ store, notify: () => {} });
    const entry = tools.add_dependency;
    if (!entry?.execute) throw new Error('add_dependency has no execute');
    await (entry.execute as (i: { package: string }) => Promise<string>)({ package: 'zod' });
    const manifest = JSON.parse(store.writtenFiles()['package.json']);
    expect(manifest.dependencies.zod).toBe(OPTIONAL_PREVIEW_DEPS.zod);
    // Seeded from the real scaffold, so it is the manifest the repo would ship.
    expect(manifest.dependencies.next).toBeDefined();
  });
});

describe('the step budget stops a run without losing its work', () => {
  it('is exhausted at the limit and not before', () => {
    expect(exhaustedStepBudget(24, 24)).toBe(true);
    expect(exhaustedStepBudget(23, 24)).toBe(false);
    // The SDK stops *at* the limit; a provider reporting one extra step must not
    // read as "finished normally" and suppress the warning.
    expect(exhaustedStepBudget(25, 24)).toBe(true);
  });

  /**
   * A zero budget is the fence path, where there are no steps to run out of.
   * Without this guard `steps >= limit` would be true for every fenced run and
   * every one of them would carry the warning.
   */
  it('is never exhausted when there is no budget', () => {
    expect(exhaustedStepBudget(0, 0)).toBe(false);
    expect(exhaustedStepBudget(5, 0)).toBe(false);
  });

  it('says the work was kept, and does not promise a retry', () => {
    expect(AGENT_STEP_BUDGET_MESSAGE).toMatch(/saved everything I finished/i);
    expect(AGENT_STEP_BUDGET_MESSAGE).toMatch(/ask for the next piece/i);
    // It must not read as a failure: this lands on a succeeded job.
    expect(AGENT_STEP_BUDGET_MESSAGE).not.toMatch(/failed|error|sorry/i);
  });
});

/**
 * The prompt and the tools have to agree about what exists.
 *
 * Starter files are deliberately absent from `Project.lastCode` — a non-empty
 * `lastCode` is the product's evidence that a site exists — so the route's
 * `backendFiles` does not contain `components/ui/button.tsx`. The prompt's
 * ALREADY IN THE PROJECT rule names it anyway, and correctly: both bundlers merge
 * the starter kit through `withStarterFiles`.
 *
 * Measured live before this was pinned: the model read `components/ui/button.tsx`,
 * `input.tsx`, `label.tsx` and `tailwind.config.js`, was told "No file at ...", and
 * spent four of its twenty-four steps finding out — the setup for hand-rolling a
 * Button, which is the one thing naming those paths exists to prevent.
 */
describe('the store sees the starter kit the prompt promises', () => {
  it('reads a starter file that is not in the project row', () => {
    const base = withStarterFiles('NEXTJS', { 'app/page.tsx': 'export default () => null;' });
    const store = createGenerationFileStore({ base, stack: 'NEXTJS' });
    expect(store.read('components/ui/button.tsx')).toContain('Button');
    expect(store.read('lib/utils.ts')).toContain('twMerge');
    expect(store.read('tailwind.config.js')).toContain('theme');
  });

  it('lists a starter path, so search can find a symbol instead of guessing', () => {
    const store = createGenerationFileStore({
      base: withStarterFiles('NEXTJS', {}),
      stack: 'NEXTJS',
    });
    expect(store.paths()).toContain('components/ui/button.tsx');
  });

  /**
   * The base widens; the payload does not. An untouched starter file must never be
   * re-stored into `lastCode`, or every edit would rewrite the whole starter kit
   * into the project row and the "does a site exist" evidence would go with it.
   */
  it('does not put an untouched starter file in the persist payload', () => {
    const base = withStarterFiles('NEXTJS', { 'app/page.tsx': 'export default () => null;' });
    const store = createGenerationFileStore({ base, stack: 'NEXTJS' });
    store.read('components/ui/button.tsx');
    expect(store.writtenFiles()).toEqual({});
    expect(store.writtenPaths()).toEqual([]);
  });

  it('reports an edit to a starter file as an update, not a create', () => {
    const store = createGenerationFileStore({
      base: withStarterFiles('NEXTJS', {}),
      stack: 'NEXTJS',
    });
    const write = store.write('components/ui/button.tsx', 'export const Button = () => null;\n');
    expect(write.kind).toBe('update');
  });

  it('is what the route hands the store', () => {
    const route = readFileSync(
      path.join(process.cwd(), 'app/api/generate-ai-code-stream/route.ts'),
      'utf8',
    );
    expect(route).toMatch(/base: withStarterFiles\(projectStack, backendFiles, projectDirection\)/);
  });
});

describe('tool stream parts are progress, not noise', () => {
  it('no tool part classifies as ignore', () => {
    // The route rearms the provider idle bound only for parts that are not
    // `ignore`, and it does so *after* the `continue`. A step that only calls
    // tools emits none of the text parts, so any of these falling through to
    // `ignore` means a healthy build is reaped after five minutes of silence.
    const parts = [
      { type: 'tool-call', toolName: 'write_file', toolCallId: 'c1' },
      { type: 'tool-result', toolName: 'write_file', toolCallId: 'c1' },
      { type: 'tool-error', toolName: 'write_file', toolCallId: 'c2' },
      { type: 'finish-step' },
    ];
    for (const part of parts) {
      expect(classifyStreamPart(part).kind, JSON.stringify(part)).not.toBe('ignore');
    }
  });

  it('carries the tool name and call id through', () => {
    const call = classifyStreamPart({
      type: 'tool-call',
      toolName: 'write_file',
      toolCallId: 'abc',
    });
    expect(call).toEqual({ kind: 'tool-call', toolName: 'write_file', toolCallId: 'abc' });
  });

  it('still ignores a part it genuinely knows nothing about', () => {
    // Control: the assertion above is only meaningful if `ignore` is reachable.
    expect(classifyStreamPart({ type: 'some-future-part' }).kind).toBe('ignore');
    expect(classifyStreamPart(null).kind).toBe('ignore');
  });

  it('does not reclassify the text and reasoning parts', () => {
    expect(classifyStreamPart({ type: 'text-delta', text: 'hi' })).toEqual({
      kind: 'text',
      text: 'hi',
    });
    expect(classifyStreamPart({ type: 'reasoning-delta', text: 'mm' }).kind).toBe('reasoning');
    expect(classifyStreamPart({ type: 'reasoning-end' }).kind).toBe('reasoning-end');
  });
});

describe('a multi-step run is billed for every step', () => {
  const GENERATE_ROUTE = 'app/api/generate-ai-code-stream/route.ts';
  const route = () => readFileSync(path.join(process.cwd(), GENERATE_ROUTE), 'utf8');

  it('reads totalUsage, not the last step', () => {
    // Measured on a real tool-path build: six files, ~430 lines, and
    // `Job.tokensOut` recorded 338 — the closing prose only. The SDK documents
    // `usage` as "the token usage of the last step" and `totalUsage` as the sum
    // across steps, and a tool build is one step per write_file plus a closing
    // one. `Job.estimatedCostUsd`, the /admin/usage figures and
    // `Workspace.spendUsd` (the auto-pause ceiling) are all derived from it, so
    // the error is silent and always downward.
    //
    // Identical on the fence path, which is exactly why this went unnoticed:
    // one step means `usage === totalUsage`.
    const text = route();
    expect(text).toMatch(/stream\.totalUsage/);
    // No `stream.usage` read may come back. Scoped to the main stream handle:
    // the corrective and recovery calls have their own handles.
    expect(text).not.toMatch(/\bstream\.usage\b/);
  });
});
