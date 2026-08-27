import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import GenerationCodeView from '@/components/workspace/GenerationCodeView';
import { entryFile, visibleFile } from '@/components/workspace/StreamingCodePanel';
import {
  EMPTY_GENERATION_PROGRESS,
  type GenerationFile,
  type GenerationProgressState,
} from '@/lib/generation/types';

/**
 * The Code view swap. `GenerationWorkspace` used to draw its own rail and its
 * own per-file code blocks, and both were built from closed `</file>` fences
 * only — so the file the model had *open*, the one thing a reader watching a
 * 30-second build wants to see, was never on screen. These assert that the view
 * now hands its state to `StreamingCodePanel` and that the open file shows.
 *
 * The workspace itself is ~2200 lines of client state (next/navigation, the
 * generation provider, framer-motion) and will not render in this harness,
 * which is why the view was extracted into its own pure component.
 */
function progress(overrides: Partial<GenerationProgressState>): GenerationProgressState {
  return { ...EMPTY_GENERATION_PROGRESS, ...overrides };
}

describe('GenerationCodeView', () => {
  it('shows the file still being written, not just the closed ones', () => {
    const markup = renderToStaticMarkup(
      createElement(GenerationCodeView, {
        progress: progress({
          isGenerating: true,
          status: 'Generating app/hero.tsx',
          files: [
            { path: 'app/layout.tsx', content: '// layout', type: 'component', completed: true },
            {
              path: 'app/hero.tsx',
              content: 'export function Her',
              type: 'component',
              completed: false,
            },
          ],
        }),
      }),
    );

    expect(markup.match(/data-state="writing"/g)).toHaveLength(1);
    expect(markup.match(/data-state="done"/g)).toHaveLength(1);
    const writing = markup.slice(markup.indexOf('data-state="writing"'));
    expect(writing).toContain('app/hero.tsx');
    // The partial body is what the old view could never render. The highlighter
    // splits it across token spans, so compare the text, not the markup.
    expect(markup.replace(/<[^>]+>/g, '')).toContain('export function Her');
    expect(markup).toContain('Writing app/hero.tsx · 1 file written');
  });

  it('lands a build with no fences yet on the panel rather than a bare spinner', () => {
    const markup = renderToStaticMarkup(
      createElement(GenerationCodeView, {
        progress: progress({ isGenerating: true, status: 'Initializing AI...' }),
      }),
    );

    expect(markup).toContain('Code appears here as each file is written.');
    expect(markup).toContain('Initializing AI...');
  });

  it('gives the streaming panel a height so the body is not a one-line strip over white', () => {
    // `absolute inset-0` on a parent that is not a positioned box collapses the
    // panel to its header. The code (or the empty-state line) then sits in a
    // zero-height overflow and the rest of the pane is the studio background.
    const markup = renderToStaticMarkup(
      createElement(GenerationCodeView, {
        progress: progress({ isGenerating: true, status: 'Initializing AI...' }),
      }),
    );

    expect(markup).toContain('h-full');
    expect(markup).not.toContain('absolute inset-0');
  });

  it('passes refused paths through so they are not dropped silently', () => {
    const markup = renderToStaticMarkup(
      createElement(GenerationCodeView, {
        progress: progress({
          isGenerating: true,
          files: [{ path: 'app/page.tsx', content: '// page', type: 'component', completed: true }],
          droppedPaths: [{ path: '../../etc/passwd', reason: 'path_traversal' }],
        }),
      }),
    );

    expect(markup).toContain('1 file skipped');
    expect(markup).toContain('path escapes the project');
  });

  it('no longer renders the thinking banner in the Code pane', () => {
    // The thinking card moved to the Chat panel (`ChatPanel`), where the user is
    // waiting. The Code pane is all code: with no file landed yet, the panel's
    // own empty state is the only thing on screen.
    const markup = renderToStaticMarkup(
      createElement(GenerationCodeView, {
        progress: progress({
          isGenerating: true,
          isThinking: true,
          thinkingText: 'Analyzing your request...',
          files: [],
        }),
      }),
    );

    expect(markup).not.toContain('AI is thinking');
    expect(markup).not.toContain('Analyzing your request');
    expect(markup).not.toContain('Finished thinking');
    expect(markup).not.toContain('Thought for');
  });

  it('retires the thinking banner once code has landed', () => {
    // A photographed build showed "Analyzing your request…" above a rail of 33
    // written files: the screen claimed to be thinking while the code streamed in.
    const markup = renderToStaticMarkup(
      createElement(GenerationCodeView, {
        progress: progress({
          isGenerating: true,
          isThinking: false,
          thinkingText: 'Analyzing your request...',
          files: [{ path: 'app/page.tsx', content: '// page', type: 'component', completed: true }],
        }),
      }),
    );

    expect(markup).not.toContain('Analyzing your request');
    expect(markup).toContain('app/page.tsx');
  });

  /**
   * F-8, second half. The Code view outlives the build, and a finished build has
   * no open file, so the panel fell through to the last entry in the rail: the
   * measured run settled on `components/Footer.tsx`, the last thing streamed.
   */
  it('settles on the project entry file rather than the last one streamed', () => {
    const markup = renderToStaticMarkup(
      createElement(GenerationCodeView, {
        progress: progress({
          isGenerating: false,
          files: [
            { path: 'app/layout.tsx', content: '// LAYOUT', type: 'component', completed: true },
            { path: 'app/page.tsx', content: '// PAGE_ENTRY', type: 'component', completed: true },
            {
              path: 'components/Footer.tsx',
              content: '// FOOTER_LAST',
              type: 'component',
              completed: true,
            },
          ],
        }),
      }),
    );

    const text = markup.replace(/<[^>]+>/g, '');
    expect(text).toContain('// PAGE_ENTRY');
    expect(text).not.toContain('// FOOTER_LAST');
  });

  it('does not jump to the entry file between two fences of a live build', () => {
    // Mid-stream the parser sits with nothing open after a closed `</file>` and
    // before the next opener. Re-selecting there would pull the reader off the
    // file they are watching every time one completes.
    const markup = renderToStaticMarkup(
      createElement(GenerationCodeView, {
        progress: progress({
          isGenerating: true,
          files: [
            { path: 'app/page.tsx', content: '// PAGE_ENTRY', type: 'component', completed: true },
            {
              path: 'components/Footer.tsx',
              content: '// FOOTER_LAST',
              type: 'component',
              completed: true,
            },
          ],
        }),
      }),
    );

    expect(markup.replace(/<[^>]+>/g, '')).toContain('// FOOTER_LAST');
  });

  /**
   * F-8, first half. Measured at a 747px viewport: the code element had
   * clientWidth 94 against scrollWidth 1638 — 6% of each line — because the file
   * rail kept its fixed 240px share of a pane that had none to give.
   */
  it('does not give the file rail a fixed share below the workspace breakpoint', () => {
    const markup = renderToStaticMarkup(
      createElement(GenerationCodeView, {
        progress: progress({
          isGenerating: true,
          files: [{ path: 'app/page.tsx', content: '// page', type: 'component', completed: true }],
        }),
      }),
    );

    // The 240px rail survives, but only from `md` up — the breakpoint the
    // workspace already changes shape at.
    expect(markup).toContain('md:w-[240px]');
    expect(markup).not.toMatch(/(?<!md:)w-\[240px\]/);
    // Below it the rail and the code stack instead of sharing a row.
    expect(markup).toMatch(/class="[^"]*\bflex-col\b[^"]*\bmd:flex-row\b/);
  });
});

function file(path: string): GenerationFile {
  return { path, content: `// ${path}`, type: 'component', completed: true };
}

/**
 * The entry file is read off the file set because `GenerationProgressState`
 * carries no stack field. Hardcoding `app/page.tsx` would leave the React/Vite
 * and static-HTML stacks landing on whatever streamed last.
 */
describe('entryFile', () => {
  it('finds the entry for each stack the generator emits', () => {
    expect(entryFile([file('components/Hero.tsx'), file('app/page.tsx')])?.path).toBe(
      'app/page.tsx',
    );
    expect(entryFile([file('components/Hero.tsx'), file('pages/index.tsx')])?.path).toBe(
      'pages/index.tsx',
    );
    expect(entryFile([file('src/components/Hero.jsx'), file('src/App.jsx')])?.path).toBe(
      'src/App.jsx',
    );
    expect(entryFile([file('styles.css'), file('index.html')])?.path).toBe('index.html');
  });

  it('falls back to the first file written when it recognises nothing', () => {
    expect(entryFile([file('scripts/build.mjs'), file('docs/readme.md')])?.path).toBe(
      'scripts/build.mjs',
    );
    expect(entryFile([])).toBeNull();
  });
});

describe('visibleFile once a build has settled', () => {
  const files = [file('app/page.tsx'), file('components/Footer.tsx')];

  it('leaves the reader on the file they picked', () => {
    const picked = { following: false, pinnedPath: 'components/Footer.tsx' };

    expect(visibleFile(files, picked, null, true)?.path).toBe('components/Footer.tsx');
  });

  it('opens the entry file only when nothing is open and nothing was picked', () => {
    const following = { following: true, pinnedPath: null };

    expect(visibleFile(files, following, null, true)?.path).toBe('app/page.tsx');
    expect(visibleFile(files, following, null, false)?.path).toBe('components/Footer.tsx');
  });
});
