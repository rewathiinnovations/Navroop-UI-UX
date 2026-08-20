import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { StreamedFileTracker } from '@/lib/generation/stream-file-tracker';

const FENCE = '```';

/**
 * Mid-stream capture feeds "Keep what was built": the files a build closed before it was
 * abandoned or capped are written to the project as-is. The accumulator this replaced
 * cleared itself *after* the chunk was appended and then stripped a further line, so kept
 * files arrived without their first line — usually the top import — and the kept site did
 * not compile. Every case here is a chunk split that produced that.
 */
describe('StreamedFileTracker', () => {
  it('keeps the body the opener chunk carried after {path=...}', () => {
    const tracker = new StreamedFileTracker();

    const closed = tracker.push(
      `${FENCE}tsx{path=src/App.tsx}\nimport { Hero } from './Hero';\nexport default function App() { return <Hero />; }\n${FENCE}`,
    );

    expect(closed).toEqual([
      {
        path: 'src/App.tsx',
        content:
          "import { Hero } from './Hero';\nexport default function App() { return <Hero />; }",
      },
    ]);
  });

  it('keeps the first line when the opener and the first body line share a chunk', () => {
    const tracker = new StreamedFileTracker();

    expect(tracker.push(`${FENCE}tsx{path=src/App.tsx}\nimport React from 'react';`)).toEqual([]);
    const closed = tracker.push(`\nexport const A = 1;\n${FENCE}\n`);

    expect(closed).toHaveLength(1);
    expect(closed[0].content).toBe("import React from 'react';\nexport const A = 1;");
    expect(closed[0].content.startsWith('import')).toBe(true);
  });

  it('keeps the first line when the opener arrives alone', () => {
    const tracker = new StreamedFileTracker();

    tracker.push(`${FENCE}ts{path=src/data.ts}`);
    const closed = tracker.push(`\nexport const data = [];\n${FENCE}`);

    expect(closed).toEqual([{ path: 'src/data.ts', content: 'export const data = [];' }]);
  });

  it('matches an opener that straddles two chunks', () => {
    const tracker = new StreamedFileTracker();

    tracker.push(`Here you go.\n${FENCE}tsx{path=src/`);
    const closed = tracker.push(`App.tsx}\nconst a = 1;\n${FENCE}`);

    expect(closed).toEqual([{ path: 'src/App.tsx', content: 'const a = 1;' }]);
  });

  it('closes a file whose closing fence straddles two chunks', () => {
    const tracker = new StreamedFileTracker();

    tracker.push(`${FENCE}ts{path=src/a.ts}\nexport const a = 1;\n${'`'}${'`'}`);
    const closed = tracker.push('`\nDone.');

    expect(closed).toEqual([{ path: 'src/a.ts', content: 'export const a = 1;' }]);
  });

  it('closes both files when one chunk ends one and opens the next', () => {
    const tracker = new StreamedFileTracker();

    const closed = tracker.push(
      [
        `${FENCE}ts{path=src/a.ts}`,
        'export const a = 1;',
        FENCE,
        '',
        `${FENCE}ts{path=src/b.ts}`,
        'export const b = 2;',
        FENCE,
      ].join('\n'),
    );

    expect(closed).toEqual([
      { path: 'src/a.ts', content: 'export const a = 1;' },
      { path: 'src/b.ts', content: 'export const b = 2;' },
    ]);
  });

  it('ends an unclosed file at the next opener instead of losing the next file', () => {
    const tracker = new StreamedFileTracker();

    const closed = tracker.push(
      [
        `${FENCE}ts{path=src/a.ts}`,
        'export const a = 1;',
        `${FENCE}ts{path=src/b.ts}`,
        'export const b = 2;',
        FENCE,
      ].join('\n'),
    );

    expect(closed.map((file) => file.path)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(closed[1].content).toBe('export const b = 2;');
  });

  it('drops a traversal path rather than handing it to the kept build', () => {
    const tracker = new StreamedFileTracker();

    const closed = tracker.push(
      `${FENCE}ts{path=../../secret.env}\nSECRET=1\n${FENCE}\n${FENCE}ts{path=src/ok.ts}\nexport const ok = 1;\n${FENCE}`,
    );

    expect(closed).toEqual([{ path: 'src/ok.ts', content: 'export const ok = 1;' }]);
    expect(tracker.rejectedPaths).toEqual(['../../secret.env']);
  });

  it('drops an absolute path and reports it', () => {
    const tracker = new StreamedFileTracker();

    const closed = tracker.push(`${FENCE}ts{path=C:/x.ts}\nexport const x = 1;\n${FENCE}`);

    expect(closed).toEqual([]);
    expect(tracker.rejectedPaths).toEqual(['C:/x.ts']);
  });

  it('reports nothing for a file still streaming', () => {
    const tracker = new StreamedFileTracker();

    expect(tracker.push(`${FENCE}tsx{path=src/App.tsx}\nexport default function App() {`)).toEqual(
      [],
    );
    expect(tracker.openPath).toBe('src/App.tsx');
  });

  it('survives a reply split one character at a time', () => {
    const tracker = new StreamedFileTracker();
    const reply = `Building.\n${FENCE}tsx{path=src/App.tsx}\nimport React from 'react';\nexport const A = 1;\n${FENCE}\nDone.`;

    const closed = [...reply].flatMap((character) => tracker.push(character));

    expect(closed).toEqual([
      { path: 'src/App.tsx', content: "import React from 'react';\nexport const A = 1;" },
    ]);
  });

  it('skips a fence with nothing in it, the way the batch parser does', () => {
    const tracker = new StreamedFileTracker();

    // `extractCodeBlocks` refuses an empty block (`if (!resolved.code.trim()) continue`), so
    // the settle path never creates such a file. Emitting it here put a zero-byte entry in
    // `Job.partialFiles`, and "Keep what was built" then wrote a file no normal build would
    // have produced — while spending one of the job's file-count allowance on it.
    const closed = tracker.push(
      `${FENCE}tsx{path=src/Empty.tsx}\n\n${FENCE}\n${FENCE}tsx{path=src/App.tsx}\nexport const A = 1;\n${FENCE}`,
    );

    expect(closed).toEqual([{ path: 'src/App.tsx', content: 'export const A = 1;' }]);
    expect(tracker.rejectedPaths).toEqual([]);
  });

  it('the generate route tells the user about a dropped path, not only the log', () => {
    const route = readFileSync(
      fileURLToPath(new URL('../../app/api/generate-ai-code-stream/route.ts', import.meta.url)),
      'utf8',
    );
    const block = route.slice(route.indexOf("log.warn('generation.unsafe_stream_paths'"));
    // A server log is not the user learning anything: the post-stream loop drops the same
    // path with a bare `continue`, so without this frame the run reported ten fences, stored
    // nine files, and said nothing about the tenth.
    expect(block.slice(0, 600)).toMatch(/sendProgress\(\{\s*\n\s*type: 'warning'/);
    expect(block.slice(0, 600)).toMatch(/warnings: rejectedPaths/);
  });

  it('folds the post-parse rejects into the same announced set as the live tracker', () => {
    const route = readFileSync(
      fileURLToPath(new URL('../../app/api/generate-ai-code-stream/route.ts', import.meta.url)),
      'utf8',
    );
    // The live tracker only sees fences it recognised as it streamed; the post-stream
    // parse recovers glued/split/unclosed fences it missed. A path unique to that set
    // used to drop with a bare `continue` and no notice (F-045). The loop now records
    // into the same set the warning frame reads, seeded from the tracker's own rejects.
    expect(route).toMatch(/const droppedPaths = new Set<string>\(streamedFiles\.rejectedPaths\)/);
    const loop = route.slice(route.indexOf('for (const [filePath, content] of Object.entries'));
    expect(loop.slice(0, 300)).toMatch(/if \(!safe\.ok\) \{\s*\n\s*droppedPaths\.add\(filePath\)/);
    // The frame counts the union, not just the tracker's list.
    expect(route).toMatch(/const rejectedPaths = \[\.\.\.droppedPaths\]/);
  });
});
