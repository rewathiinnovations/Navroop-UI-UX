import { describe, expect, it } from 'vitest';
import { isValidElement } from 'react';
import { renderSnippet } from '@/components/layout/CommandPalette';

/**
 * Search snippets come from `ts_headline`, which inserts the <mark> delimiters and passes
 * the rest of the project name/prompt through verbatim — no entity encoding. The palette
 * used to feed that string to dangerouslySetInnerHTML, so a project named
 * `<img src=x onerror=…>` executed in every other member's session. These assert on the
 * node structure, not on markup: anything that is not a delimiter must come back as a
 * plain string, which React renders as a text node.
 */

const PAYLOAD = '<img src=x onerror=alert(1)>';

describe('renderSnippet', () => {
  it('returns an attacker-supplied tag as text, never as an element', () => {
    const nodes = renderSnippet(`${PAYLOAD} <mark>shop</mark>`);

    const elements = nodes.filter(isValidElement);
    expect(elements).toHaveLength(1);
    expect(elements[0]).toMatchObject({ type: 'mark', props: { children: 'shop' } });

    const text = nodes.filter((node) => typeof node === 'string');
    expect(text).toHaveLength(1);
    // The tag survives byte-for-byte as a string: React escapes text children, so it is
    // displayed rather than parsed.
    expect(text[0]).toBe(`${PAYLOAD} `);
  });

  it('does not treat a payload smuggled inside the highlight as markup either', () => {
    const nodes = renderSnippet(`<mark>${PAYLOAD}</mark>`);

    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ type: 'mark', props: { children: PAYLOAD } });
  });

  it('keeps every highlight and preserves the surrounding text in order', () => {
    const nodes = renderSnippet('a <mark>b</mark> c <mark>d</mark>');

    expect(nodes.map((node) => (isValidElement(node) ? 'mark' : node))).toEqual([
      'a ',
      'mark',
      ' c ',
      'mark',
    ]);
  });

  it('passes a snippet with no highlight through as a single text node', () => {
    expect(renderSnippet(PAYLOAD)).toEqual([PAYLOAD]);
  });
});
