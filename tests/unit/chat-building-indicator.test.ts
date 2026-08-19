/**
 * The chat's wait state must say what the build is doing.
 *
 * A verified DeepSeek run sat at zero files for 4.5 minutes and then wrote 21
 * files in 90 seconds. Through the whole silent stretch the chat showed a
 * spinner over the frozen sentence "Building your project…", which is what the
 * user read as a hang. Two signals fix that and both are asserted here: the
 * file being written (once files exist) and elapsed time (before they do).
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import BuildingIndicator from '@/components/workspace/BuildingIndicator';
import type { GenerationFile } from '@/lib/generation/types';

function render(props: Parameters<typeof BuildingIndicator>[0]) {
  return renderToStaticMarkup(createElement(BuildingIndicator, props));
}

function file(path: string, completed: boolean): GenerationFile {
  return { path, content: 'x', type: 'tsx', completed, edited: false };
}

const MINUTES_AGO_3 = new Date(Date.now() - 3 * 60_000 - 7_000).toISOString();

describe('chat building indicator', () => {
  it('names the file being written instead of a frozen sentence', () => {
    const html = render({
      files: [file('app/page.tsx', true), file('components/Hero.tsx', false)],
    });

    expect(html).toContain('components/Hero.tsx');
    expect(html).toContain('1 file written');
    expect(html).not.toContain('Building your project');
  });

  it('shows elapsed time while the provider has sent nothing', () => {
    const html = render({ startedAt: MINUTES_AGO_3 });

    // The whole point: something on screen changes during a silent stretch.
    expect(html).toContain('Building your project');
    expect(html).toContain('3m 7s');
  });
  it('keeps the elapsed clock once files start arriving', () => {
    const html = render({
      startedAt: MINUTES_AGO_3,
      files: [file('app/page.tsx', true), file('components/Nav.tsx', false)],
    });

    expect(html).toContain('components/Nav.tsx');
    expect(html).toContain('3m 7s');
  });

  it('counts finished files without naming a path once nothing is mid-write', () => {
    // Existing `streamProgressLabel` behaviour: no active file, no path to name.
    const html = render({ startedAt: MINUTES_AGO_3, files: [file('app/page.tsx', true)] });

    expect(html).toContain('1 file written · 3m 7s');
  });

  it('does not invent a clock without a start time, or in the first seconds', () => {
    expect(render({})).not.toMatch(/\d+s/);
    // A fresh job would otherwise flash "0s" for a moment.
    expect(render({ startedAt: new Date().toISOString() })).not.toMatch(/\d+s/);
    // An unparseable value is absence of information, not zero.
    expect(render({ startedAt: 'not-a-date' })).not.toMatch(/\d+s/);
  });

  it('lets a queue position outrank both, since nothing is being written yet', () => {
    const html = render({ queueAhead: 2, startedAt: MINUTES_AGO_3, files: [file('a.tsx', true)] });

    expect(html).toContain('2 builds ahead');
    expect(html).not.toContain('a.tsx');
  });
});
