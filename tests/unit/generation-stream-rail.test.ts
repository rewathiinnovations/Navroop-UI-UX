import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  applyStreamedCode,
  finalizeStreamedFiles,
  scanStreamedFences,
  summarizeStreamingFiles,
} from '@/lib/generation/generation-runtime';
import {
  EMPTY_GENERATION_PROGRESS,
  type GenerationFile,
  type GenerationProgressState,
} from '@/lib/generation/types';

/**
 * The streaming rail. `applyStreamedCode` used to match only *closed* fences, so
 * a 400-line file was invisible for the ~30 seconds it took to write and then
 * appeared complete. The rail now also carries the block being written.
 *
 * Two things are load-bearing and both are pinned here:
 *
 * - A finished entry must be byte-identical to what the closed-fence-only pass
 *   produced, because `hasExistingSite`, "Keep what was built" and the `complete`
 *   frame all read this list. `closedFencesOnly` below is that old pass, kept
 *   verbatim as the oracle.
 * - The invariants the panel and the preview rely on: at most one incomplete
 *   entry, always last; `completed` only goes false → true; content only grows.
 */

const fence = '```';

/** Copy of the runtime's private `fileTypeFromPath`, so the oracle stays independent. */
function fileTypeFromPath(filePath: string) {
  const fileExt = filePath.split('.').pop() || '';
  if (fileExt === 'jsx' || fileExt === 'js') return 'javascript';
  if (fileExt === 'css') return 'css';
  if (fileExt === 'json') return 'json';
  if (fileExt === 'html') return 'html';
  return 'text';
}

/** The pass this change replaced: the oracle for a closed entry's final shape. */
function closedFencesOnly(text: string): GenerationFile[] {
  const fileRegex = new RegExp('```[^\\n`]*\\{path=([^}\\n]+)\\}\\n([^]*?)\\n```', 'g');
  const files: GenerationFile[] = [];
  const processed = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = fileRegex.exec(text)) !== null) {
    if (processed.has(match[1])) continue;
    processed.add(match[1]);
    files.push({
      path: match[1],
      content: match[2].trim(),
      type: fileTypeFromPath(match[1]),
      completed: true,
      edited: false,
    });
  }
  return files;
}

function emptyProgress(overrides?: Partial<GenerationProgressState>): GenerationProgressState {
  return { ...EMPTY_GENERATION_PROGRESS, files: [], droppedPaths: [], ...overrides };
}

function expectContract(before: GenerationProgressState, after: GenerationProgressState) {
  const incomplete = after.files.filter((file) => !file.completed);
  expect(incomplete.length).toBeLessThanOrEqual(1);
  if (incomplete.length === 1) {
    expect(after.files[after.files.length - 1]).toBe(incomplete[0]);
  }
  for (const file of before.files) {
    const next = after.files.find((candidate) => candidate.path === file.path);
    expect(next, `entry for ${file.path} disappeared`).toBeDefined();
    if (!next) continue;
    if (file.completed) expect(next.completed).toBe(true);
    expect(next.content.startsWith(file.content)).toBe(true);
  }
}

/** Feeds chunks one at a time, asserting the contract after every one. */
function replay(chunks: readonly string[]): GenerationProgressState {
  let state = emptyProgress();
  for (const chunk of chunks) {
    const before = state;
    state = applyStreamedCode(state, chunk);
    expectContract(before, state);
  }
  return state;
}

function splitInto(text: string, cuts: readonly number[]): string[] {
  const bounds = [...new Set(cuts.filter((cut) => cut > 0 && cut < text.length))].sort(
    (a, b) => a - b,
  );
  const chunks: string[] = [];
  let start = 0;
  for (const bound of bounds) {
    chunks.push(text.slice(start, bound));
    start = bound;
  }
  chunks.push(text.slice(start));
  return chunks;
}

/**
 * Two files plus a third block re-claiming a path already written: the old pass
 * kept the first body and ignored the repeat, so this one must too.
 */
const WELL_FORMED_REPLY = [
  "Here's the app.",
  `${fence}tsx{path=src/App.tsx}`,
  "import Card from './Card';",
  '',
  'export default function App() {',
  '  return <Card />;',
  '}',
  fence,
  'And the styles.',
  `${fence}css{path=src/index.css}`,
  'body { margin: 0; }',
  fence,
  `${fence}tsx{path=src/App.tsx}`,
  'export default function App() { return null; }',
  fence,
  'Done.',
].join('\n');

describe('scanStreamedFences', () => {
  it('reads two closed blocks out of one chunk', () => {
    const fences = scanStreamedFences(
      [
        `${fence}tsx{path=a.tsx}`,
        'const a = 1;',
        fence,
        `${fence}css{path=b.css}`,
        'b { color: red; }',
        fence,
      ].join('\n'),
    );
    expect(fences).toEqual([
      { path: 'a.tsx', body: 'const a = 1;', closed: true },
      { path: 'b.css', body: 'b { color: red; }', closed: true },
    ]);
  });

  it('reports the block still being written as the last, open entry', () => {
    const fences = scanStreamedFences(
      [`${fence}tsx{path=a.tsx}`, 'const a = 1;', fence, `${fence}tsx{path=b.tsx}`, 'const b'].join(
        '\n',
      ),
    );
    expect(fences).toEqual([
      { path: 'a.tsx', body: 'const a = 1;', closed: true },
      { path: 'b.tsx', body: 'const b', closed: false },
    ]);
  });

  it('keeps every file when the model forgets to close a block', () => {
    // The next file's opener sits where the closing fence should be. Resuming
    // past those three backticks left `tsx{path=b.tsx}` behind, which matched no
    // opener, so every file after the unclosed one was lost — the fault
    // parse-blocks documents for its own BLOCK_RE.
    const fences = scanStreamedFences(
      [
        `${fence}tsx{path=a.tsx}`,
        'const a = 1;',
        `${fence}tsx{path=b.tsx}`,
        'const b = 2;',
        fence,
      ].join('\n'),
    );
    expect(fences).toEqual([
      { path: 'a.tsx', body: 'const a = 1;', closed: true },
      { path: 'b.tsx', body: 'const b = 2;', closed: true },
    ]);
  });

  it('reads CRLF blocks, which used to yield no files at all', () => {
    // The old opener demanded `}\n`; CRLF put a `\r` in between, nothing matched,
    // and the whole build rendered as prose. Inner line endings are the model's
    // own content and are left alone, as in parse-blocks.
    const fences = scanStreamedFences(
      [`${fence}tsx{path=a.tsx}`, 'const a = 1;', 'const b = 2;', fence].join('\r\n'),
    );
    expect(fences).toEqual([{ path: 'a.tsx', body: 'const a = 1;\r\nconst b = 2;', closed: true }]);
  });

  it('emits nothing for a header that is still arriving', () => {
    expect(scanStreamedFences(`${fence}tsx{path=src/Ap`)).toEqual([]);
    expect(scanStreamedFences(`${fence}tsx{path=src/App.tsx}`)).toEqual([]);
  });

  it('treats a prose code block as the close of the file before it, as the old pass did', () => {
    const fences = scanStreamedFences(
      [`${fence}tsx{path=a.tsx}`, 'const a = 1;', fence, `${fence}bash`, 'npm i', fence].join('\n'),
    );
    expect(fences).toEqual([{ path: 'a.tsx', body: 'const a = 1;', closed: true }]);
  });
});

describe('applyStreamedCode chunking', () => {
  it('survives a split in the middle of a path', () => {
    const state = replay([`${fence}tsx{path=src/A`, `pp.tsx}\nconst a = 1;\n${fence}`]);
    expect(state.files).toEqual([
      {
        path: 'src/App.tsx',
        content: 'const a = 1;',
        type: 'text',
        completed: true,
        edited: false,
      },
    ]);
    expect(state.droppedPaths).toEqual([]);
  });

  it('grows one open entry across splits in the middle of a body', () => {
    let state = applyStreamedCode(emptyProgress(), `${fence}jsx{path=src/App.jsx}\nconst a`);
    expect(state.files).toEqual([
      {
        path: 'src/App.jsx',
        content: 'const a',
        type: 'javascript',
        completed: false,
        edited: false,
      },
    ]);
    expect(summarizeStreamingFiles(state.files)).toEqual({
      activePath: 'src/App.jsx',
      filesWritten: 0,
      filesTotal: 1,
    });

    const before = state;
    state = applyStreamedCode(state, ' = 1;\nconst b = 2;');
    expectContract(before, state);
    expect(state.files).toHaveLength(1);
    expect(state.files[0].content).toBe('const a = 1;\nconst b = 2;');
    expect(state.files[0].completed).toBe(false);

    state = applyStreamedCode(state, `\n${fence}\n`);
    expect(state.files).toEqual([
      {
        path: 'src/App.jsx',
        content: 'const a = 1;\nconst b = 2;',
        type: 'javascript',
        completed: true,
        edited: false,
      },
    ]);
    // Nothing is open any more, so the legacy mirror clears with it.
    expect(state.currentFile).toBeUndefined();
    expect(summarizeStreamingFiles(state.files)).toEqual({
      activePath: null,
      filesWritten: 1,
      filesTotal: 1,
    });
  });

  it('closes one file and opens the next inside a single chunk', () => {
    const state = replay([
      `${fence}css{path=a.css}\nbody {}`,
      `\n${fence}\n${fence}json{path=b.json}\n{"a":`,
    ]);
    expect(state.files.map((file) => [file.path, file.completed])).toEqual([
      ['a.css', true],
      ['b.json', false],
    ]);
    expect(state.currentFile).toEqual({ path: 'b.json', content: '{"a":', type: 'json' });
  });

  it('finishes the abandoned block when the model opens the next one instead of closing', () => {
    const state = replay([
      `${fence}tsx{path=a.tsx}\nconst a = 1;\n`,
      `${fence}tsx{path=b.tsx}\nconst b`,
    ]);
    expect(state.files).toEqual([
      { path: 'a.tsx', content: 'const a = 1;', type: 'text', completed: true, edited: false },
      { path: 'b.tsx', content: 'const b', type: 'text', completed: false, edited: false },
    ]);
  });

  it('ignores a block that re-opens a path already finished', () => {
    const state = replay([
      `${fence}tsx{path=a.tsx}\nfirst\n${fence}\n`,
      `${fence}tsx{path=a.tsx}\nsecond`,
    ]);
    expect(state.files).toEqual([
      { path: 'a.tsx', content: 'first', type: 'text', completed: true, edited: false },
    ]);
    expect(state.currentFile).toBeUndefined();
  });

  it('never shows the closing fence it is still receiving', () => {
    // The tail of a file arrives as `\n`, `` \n` ``, `` \n`` ``, then the fence.
    // Rendering those backticks and then removing them is content that shrinks,
    // which the preview and the panel are promised never happens.
    let state = emptyProgress();
    const bodies: string[] = [];
    for (const char of `${fence}tsx{path=a.tsx}\nconst a = 1;\n${fence}`) {
      const before = state;
      state = applyStreamedCode(state, char);
      expectContract(before, state);
      if (state.files[0]) bodies.push(state.files[0].content);
    }
    expect(bodies.filter((body) => body.includes('`'))).toEqual([]);
    expect(state.files).toEqual([
      { path: 'a.tsx', content: 'const a = 1;', type: 'text', completed: true, edited: false },
    ]);
  });
});

describe('applyStreamedCode status line', () => {
  it('names the file being written instead of a generic line', () => {
    // `Generating code...` used to survive an entire edit stream, because naming
    // the file was gated on `!isEdit` — while the panel could see the file.
    const first = applyStreamedCode(emptyProgress({ isEdit: true }), 'thinking about it');
    expect(first.status).toBe('Generating code...');

    const second = applyStreamedCode(first, `${fence}tsx{path=src/App.tsx}\nconst a`);
    expect(second.status).toBe('Generating src/App.tsx');

    const third = applyStreamedCode(second, ` = 1;\n${fence}`);
    expect(third.status).toBe('Completed src/App.tsx');
  });
});

describe('applyStreamedCode path safety', () => {
  it('drops an unsafe partial path and says which and why', () => {
    const state = replay([
      `${fence}tsx{path=../../etc/passwd}\nowned`,
      `\n${fence}\n${fence}tsx{path=C:/Windows/system32/x}\nowned`,
      `\n${fence}\n${fence}tsx{path=/etc/shadow}\nowned`,
      `\n${fence}\n${fence}tsx{path=src/App.tsx}\nconst a = 1;\n${fence}`,
    ]);
    expect(state.files.map((file) => file.path)).toEqual(['src/App.tsx']);
    // The codes are `sanitizeGenerationPath`'s own: a leading `/` trips its
    // empty-segment check before the absolute-path one, so it reports `empty`.
    expect(state.droppedPaths).toEqual([
      { path: '../../etc/passwd', reason: 'path_traversal' },
      { path: 'C:/Windows/system32/x', reason: 'absolute_path' },
      { path: '/etc/shadow', reason: 'empty' },
    ]);
  });

  it('reports an unsafe path once, not once per chunk', () => {
    const state = replay([`${fence}tsx{path=../evil.ts}\nlet`, ' a', ' = 1;', `\n${fence}`]);
    expect(state.files).toEqual([]);
    expect(state.droppedPaths).toEqual([{ path: '../evil.ts', reason: 'path_traversal' }]);
  });

  it('keeps the same droppedPaths reference while nothing new is dropped', () => {
    const first = applyStreamedCode(emptyProgress(), `${fence}tsx{path=a.tsx}\nconst a`);
    const second = applyStreamedCode(first, ' = 1;');
    expect(second.droppedPaths).toBe(first.droppedPaths);
  });
});

describe('a closed entry is unchanged from the closed-fence-only pass', () => {
  it('matches the old pass when the whole reply arrives at once', () => {
    const state = applyStreamedCode(emptyProgress(), WELL_FORMED_REPLY);
    expect(state.files).toEqual(closedFencesOnly(WELL_FORMED_REPLY));
    expect(state.files.map((file) => file.path)).toEqual(['src/App.tsx', 'src/index.css']);
    expect(state.currentFile).toBeUndefined();
  });

  it('matches the old pass however the reply is chunked', () => {
    const oracle = closedFencesOnly(WELL_FORMED_REPLY);
    fc.assert(
      fc.property(fc.array(fc.nat(WELL_FORMED_REPLY.length), { maxLength: 24 }), (cuts) => {
        const state = replay(splitInto(WELL_FORMED_REPLY, cuts));
        expect(state.files).toEqual(oracle);
        expect(state.streamedCode).toBe(WELL_FORMED_REPLY);
      }),
      { numRuns: 200 },
    );
  });

  it('splits the reply one character at a time and still lands on the old shape', () => {
    const state = replay([...WELL_FORMED_REPLY]);
    expect(state.files).toEqual(closedFencesOnly(WELL_FORMED_REPLY));
  });
});

describe('finalizeStreamedFiles', () => {
  it('closes the block the reply stopped inside', () => {
    const files: GenerationFile[] = [
      { path: 'a.tsx', content: 'a', type: 'text', completed: true, edited: false },
      { path: 'b.tsx', content: 'half', type: 'text', completed: false, edited: false },
    ];
    expect(finalizeStreamedFiles(files)).toEqual([
      files[0],
      { path: 'b.tsx', content: 'half', type: 'text', completed: true, edited: false },
    ]);
  });

  it('returns the same list when nothing is open', () => {
    const files: GenerationFile[] = [
      { path: 'a.tsx', content: 'a', type: 'text', completed: true, edited: false },
    ];
    expect(finalizeStreamedFiles(files)).toBe(files);
    expect(finalizeStreamedFiles([])).toEqual([]);
  });
});

describe('summarizeStreamingFiles', () => {
  it('counts what is written and names what is open', () => {
    const done = (path: string): GenerationFile => ({
      path,
      content: 'x',
      type: 'text',
      completed: true,
    });
    expect(summarizeStreamingFiles([])).toEqual({
      activePath: null,
      filesWritten: 0,
      filesTotal: 0,
    });
    expect(summarizeStreamingFiles([done('a'), done('b')])).toEqual({
      activePath: null,
      filesWritten: 2,
      filesTotal: 2,
    });
    expect(
      summarizeStreamingFiles([
        done('a'),
        { path: 'b', content: '', type: 'text', completed: false },
      ]),
    ).toEqual({ activePath: 'b', filesWritten: 1, filesTotal: 2 });
  });
});
