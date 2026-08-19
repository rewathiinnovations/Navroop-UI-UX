import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import GenerationCodeView from '@/components/workspace/GenerationCodeView';
import { EMPTY_GENERATION_PROGRESS, type GenerationProgressState } from '@/lib/generation/types';

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
});
