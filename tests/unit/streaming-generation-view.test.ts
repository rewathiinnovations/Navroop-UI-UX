import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import StreamingCodePanel, {
  selectionReducer,
  visibleFile,
} from '@/components/workspace/StreamingCodePanel';
import {
  emptyAssemblyState,
  previewError,
  settleReducer,
  waitingMessage,
  type PreviewState,
  type SettleState,
  type SettleTarget,
} from '@/components/workspace/BrowserPreview';
import { streamingFilesLabel, streamProgressLabel } from '@/components/workspace/BuildingIndicator';
import { summarizeStreamingFiles } from '@/lib/generation/generation-runtime';
import type { PreviewAssembly } from '@/lib/preview/assemble';
import type { GenerationFile } from '@/lib/generation/types';

// esbuild-wasm has no business booting for a reducer test, and nothing below
// reaches the bundler: BrowserPreview only calls it from an effect.
vi.mock('@/lib/preview/bundle', () => ({
  bundlePreview: vi.fn(async () => ({ ok: false as const, error: 'not called' })),
}));

function file(path: string, completed: boolean, content = `// ${path}`): GenerationFile {
  return { path, content, type: 'component', completed };
}

/** Any assembly will do — the scheduler only ever compares the keys. */
function target(key: string): SettleTarget {
  const assembly: PreviewAssembly = { kind: 'bundle', entry: key, files: {}, aliases: {} };
  return { key, assembly };
}

/**
 * The panel is the thing a reader stares at for thirty seconds, so the two
 * claims it makes had better be true: which file is being written, and that it
 * will not move the viewport out from under them.
 */
describe('StreamingCodePanel', () => {
  it('marks exactly the open file as writing', () => {
    const markup = renderToStaticMarkup(
      createElement(StreamingCodePanel, {
        files: [
          file('app/layout.tsx', true),
          file('app/page.tsx', true),
          file('app/hero.tsx', false),
        ],
        activePath: 'app/hero.tsx',
      }),
    );

    expect(markup.match(/data-state="writing"/g)).toHaveLength(1);
    expect(markup.match(/data-state="done"/g)).toHaveLength(2);
    // The rail entry that is writing is the one the stream left open.
    const writing = markup.slice(markup.indexOf('data-state="writing"'));
    expect(writing).toContain('app/hero.tsx');
  });

  it('shows a blinking cursor when a file is still being written', () => {
    const markup = renderToStaticMarkup(
      createElement(StreamingCodePanel, {
        files: [file('app/page.tsx', false)],
        activePath: 'app/page.tsx',
      }),
    );

    // The cursor is an animated span with the pulse animation
    expect(markup).toContain('animate-pulse');
    expect(markup).toContain('bg-emerald-400');
  });

  it('hides the cursor when the file is completed', () => {
    const markup = renderToStaticMarkup(
      createElement(StreamingCodePanel, {
        files: [file('app/page.tsx', true)],
        activePath: 'app/page.tsx',
      }),
    );

    // Completed files should not have the cursor
    expect(markup).not.toContain('animate-pulse bg-emerald-400');
  });

  it('reports paths the parser refused instead of dropping them silently', () => {
    const markup = renderToStaticMarkup(
      createElement(StreamingCodePanel, {
        files: [file('app/page.tsx', true)],
        droppedPaths: [{ path: '../../etc/passwd', reason: 'path_traversal' }],
      }),
    );

    expect(markup).toContain('1 file skipped');
    expect(markup).toContain('../../etc/passwd');
    expect(markup).toContain('path escapes the project');
  });

  it('does not call a leading-slash path "empty"', () => {
    // sanitizeGenerationPath checks for empty segments before it checks for an
    // absolute path, so /etc/passwd reaches the panel as `empty`. The copy has
    // to survive that or it tells the reader something plainly untrue.
    const markup = renderToStaticMarkup(
      createElement(StreamingCodePanel, {
        files: [],
        droppedPaths: [{ path: '/etc/passwd', reason: 'empty' }],
      }),
    );

    expect(markup).toContain('blank or malformed path');
    expect(markup).not.toContain('empty path');
  });

  it('stops following when the reader picks a file and resumes on the control', () => {
    const files = [file('app/page.tsx', true), file('app/hero.tsx', false)];
    let selection = { following: true, pinnedPath: null as string | null };

    // Following: the body tracks whatever the stream has open.
    expect(visibleFile(files, selection, 'app/hero.tsx')?.path).toBe('app/hero.tsx');

    selection = selectionReducer(selection, { type: 'pick', path: 'app/page.tsx' });
    expect(selection.following).toBe(false);
    expect(visibleFile(files, selection, 'app/hero.tsx')?.path).toBe('app/page.tsx');

    selection = selectionReducer(selection, { type: 'follow' });
    expect(selection).toEqual({ following: true, pinnedPath: null });
    expect(visibleFile(files, selection, 'app/hero.tsx')?.path).toBe('app/hero.tsx');
  });

  it('keeps the streamed file on screen when the reader only scrolls', () => {
    const files = [file('app/hero.tsx', false)];
    const scrolled = selectionReducer(
      { following: true, pinnedPath: null },
      { type: 'scrolled-away' },
    );

    expect(scrolled.following).toBe(false);
    // No pin was made, so the file itself must not change — only the auto-scroll stops.
    expect(visibleFile(files, scrolled, 'app/hero.tsx')?.path).toBe('app/hero.tsx');
  });
});

/**
 * esbuild-wasm runs on this thread. A compile per completed file would fight
 * the streaming UI for frames, which is the whole reason the settle window
 * exists rather than rebuilding on every identity change.
 */
describe('preview rebuild scheduling', () => {
  it('coalesces two quick completions into one rebuild', () => {
    const [a, b, c] = [target('A'), target('B'), target('C')];
    let state: SettleState = { active: a, pending: null };

    state = settleReducer(state, { type: 'files', target: b, settling: true });
    expect(state.active.key).toBe('A');

    state = settleReducer(state, { type: 'files', target: c, settling: true });
    expect(state.active.key).toBe('A');
    expect(state.pending?.key).toBe('C');

    state = settleReducer(state, { type: 'settled' });
    // B was never compiled: the window swallowed it.
    expect(state.active.key).toBe('C');
    expect(state.pending).toBeNull();
    // A second elapsed window with nothing queued must not trigger a rebuild.
    expect(settleReducer(state, { type: 'settled' })).toBe(state);
  });

  it('rebuilds immediately when no stream is settling', () => {
    const [a, b] = [target('A'), target('B')];
    const state = settleReducer(
      { active: a, pending: null },
      {
        type: 'files',
        target: b,
        settling: false,
      },
    );

    expect(state.active.key).toBe('B');
    expect(state.pending).toBeNull();
  });

  it('flushes the queued rebuild when the stream ends', () => {
    const [a, b] = [target('A'), target('B')];
    const state = settleReducer(
      { active: a, pending: b },
      {
        type: 'files',
        target: b,
        settling: false,
      },
    );

    expect(state.active.key).toBe('B');
    expect(state.pending).toBeNull();
  });

  it('drops a queued rebuild when the files come back to what is on screen', () => {
    const [a, b] = [target('A'), target('B')];
    const state = settleReducer(
      { active: a, pending: b },
      {
        type: 'files',
        target: a,
        settling: true,
      },
    );

    expect(state.active.key).toBe('A');
    expect(state.pending).toBeNull();
  });
});

/**
 * A build that has produced two of nine files is normal. Before this the pane
 * answered a bundle failure by dropping the srcdoc, so one broken intermediate
 * state blanked a preview that had been working a second earlier.
 */
describe('preview failure states', () => {
  it('keeps the last good preview when a compile fails', () => {
    const good: PreviewState = { status: 'ready', srcdoc: '<html>good</html>' };
    const failed = previewError(good, 'Build failed: Unexpected end of file');

    expect(failed).toEqual({
      status: 'error',
      message: 'Build failed: Unexpected end of file',
      srcdoc: '<html>good</html>',
    });
  });

  it('has no srcdoc to keep when nothing ever rendered', () => {
    expect(previewError({ status: 'idle' }, 'boom')).toEqual({
      status: 'error',
      message: 'boom',
      srcdoc: undefined,
    });
  });

  it('waits rather than erroring while a stream is still writing', () => {
    const state = emptyAssemblyState(
      { status: 'idle' },
      'No root component found — expected app/page.tsx.',
      true,
    );

    expect(state).toEqual({
      status: 'waiting',
      reason: 'No root component found — expected app/page.tsx.',
    });
  });

  it('leaves a rendered preview alone when the file set briefly loses its root', () => {
    const good: PreviewState = { status: 'ready', srcdoc: '<html>good</html>' };
    expect(emptyAssemblyState(good, 'No root component found.', true)).toBe(good);
  });

  it('is a real error once no stream is running', () => {
    expect(emptyAssemblyState({ status: 'idle' }, 'This project has no files yet.', false)).toEqual(
      {
        status: 'error',
        message: 'This project has no files yet.',
        srcdoc: undefined,
      },
    );
  });
});

/**
 * The stream never announces how many files it intends to write, so the copy
 * must not imply a target it cannot know.
 */
describe('streaming status copy', () => {
  it('names the open file and the count written so far', () => {
    expect(
      streamProgressLabel({ activePath: 'app/page.tsx', filesWritten: 4, filesTotal: 5 }),
    ).toBe('Writing app/page.tsx · 4 files written');
  });

  it('gives files-holding callers the identical sentence', () => {
    // Three call sites want this line. If any of them re-derived it from files
    // themselves the two status lines would drift, so they share this accessor.
    const files = [file('app/layout.tsx', true), file('app/page.tsx', false)];

    expect(streamingFilesLabel(files)).toBe('Writing app/page.tsx · 1 file written');
    expect(streamingFilesLabel(files)).toBe(streamProgressLabel(summarizeStreamingFiles(files)));
    expect(streamingFilesLabel([])).toBeNull();
    expect(streamingFilesLabel(null)).toBeNull();
  });

  it('drops the count before anything is finished', () => {
    expect(
      streamProgressLabel({ activePath: 'app/page.tsx', filesWritten: 0, filesTotal: 1 }),
    ).toBe('Writing app/page.tsx');
  });

  it('reports the finished total with nothing open', () => {
    expect(streamProgressLabel({ activePath: null, filesWritten: 9, filesTotal: 9 })).toBe(
      '9 files written',
    );
    expect(streamProgressLabel({ activePath: null, filesWritten: 0, filesTotal: 0 })).toBeNull();
  });

  it('explains why the preview pane is still empty', () => {
    expect(waitingMessage({ activePath: 'app/page.tsx', filesWritten: 2 })).toContain(
      '2 files written',
    );
    expect(waitingMessage({ activePath: 'app/page.tsx', filesWritten: 2 })).toContain(
      'writing app/page.tsx',
    );
    expect(waitingMessage(null)).toBe('Waiting for the first files…');
  });
});
