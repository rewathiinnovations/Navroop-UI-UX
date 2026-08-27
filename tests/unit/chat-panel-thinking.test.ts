/**
 * The collapsible "AI is thinking..." card that lives in the Chat panel.
 *
 * It moved here from the Code pane (`GenerationCodeView`): the user waits in the
 * chat, so that is where chain-of-thought is surfaced, and it can be collapsed to
 * keep the thread from filling with reasoning text.
 *
 * Rendered through `react-dom/server` like the other workspace view tests, so the
 * assertions are about output rather than component internals.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import ChatPanel from '@/components/workspace/ChatPanel';

function render(overrides: {
  isGenerating?: boolean;
  isThinking?: boolean;
  thinkingText?: string | null;
  thinkingDuration?: number | null;
}) {
  return renderToStaticMarkup(
    createElement(ChatPanel, {
      messages: [],
      projectId: 'p1',
      ...overrides,
    }),
  );
}

describe('ChatPanel thinking card', () => {
  it('shows "AI is thinking..." with the reasoning text while the model thinks', () => {
    const html = render({ isGenerating: true, isThinking: true, thinkingText: 'Planning the layout' });

    expect(html).toContain('AI is thinking');
    expect(html).toContain('Planning the layout');
  });

  it('reports a duration it actually knows', () => {
    const html = render({
      isGenerating: true,
      isThinking: false,
      thinkingText: 'Planning the layout',
      thinkingDuration: 7,
    });

    expect(html).toContain('Thought for 7 seconds');
  });

  it('never claims it thought for zero seconds', () => {
    const html = render({
      isGenerating: true,
      isThinking: false,
      thinkingText: 'Planning the layout',
      thinkingDuration: undefined,
    });

    expect(html).not.toContain('Thought for 0 seconds');
    expect(html).toContain('Finished thinking');
  });

  it('renders nothing when no build is running', () => {
    const html = render({ isGenerating: false, isThinking: true, thinkingText: 'stale' });

    expect(html).not.toContain('AI is thinking');
    expect(html).not.toContain('stale');
  });

  it('does not invent a thinking card from a generating flag alone', () => {
    const html = render({ isGenerating: true, isThinking: false, thinkingText: undefined });

    expect(html).not.toContain('AI is thinking');
    expect(html).not.toContain('Finished thinking');
  });
});
