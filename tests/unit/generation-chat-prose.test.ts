import { describe, expect, it } from 'vitest';
import { chatTextFromConversation } from '../../lib/generation/parse-blocks';

/**
 * What a `conversation` frame contributes to the transcript.
 *
 * The client used to append the frame only if its text contained none of `<file`,
 * `import React`, `export default`, `className=` — a substring match over the whole
 * frame. The intent (keep pasted source out of chat) is right; the test is not. Ask
 * "why did you use a default export here?" and the model's answer names the phrase, so
 * the whole answer was discarded with no chat line and no log. On the chat-answer path
 * the `conversation` frame *is* the reply, so the run finished having said nothing.
 *
 * The rule now is structural: strip the code, keep the prose. Goes red if the substring
 * filter comes back (the prose cases return '') or if stripping stops working (the code
 * cases leak a fence or a `<file>` body into the transcript).
 */

const FENCE = '```';

describe('chatTextFromConversation', () => {
  it('keeps prose that merely names a code construct', () => {
    const text = 'I used `export default` here because the router imports the page directly.';
    expect(chatTextFromConversation(text)).toBe(text);
  });

  it('keeps prose that names a JSX attribute', () => {
    const text = 'Each card carries a className= for the hover state, so the styles stay local.';
    expect(chatTextFromConversation(text)).toBe(text);
  });

  it('keeps the prose around a fenced block and drops the block', () => {
    const frame = [
      'Here is the new page.',
      `${FENCE}tsx{path=app/page.tsx}`,
      'export default function Page() { return null; }',
      FENCE,
      'Tell me if the heading should be larger.',
    ].join('\n');

    const chat = chatTextFromConversation(frame);

    expect(chat).toContain('Here is the new page.');
    expect(chat).toContain('Tell me if the heading should be larger.');
    expect(chat).not.toContain('function Page()');
    expect(chat).not.toContain(FENCE);
  });

  it('drops a <file> block but keeps the sentence that introduced it', () => {
    const frame = [
      'Updated the header.',
      '<file path="src/Header.tsx">',
      "import React from 'react';",
      'export default function Header() { return null; }',
      '</file>',
    ].join('\n');

    const chat = chatTextFromConversation(frame);

    expect(chat).toBe('Updated the header.');
  });

  it('drops a <file> block the stream cut off before its closing tag', () => {
    const frame = ['Working on the header.', '<file path="src/Header.tsx">', 'import React'].join(
      '\n',
    );

    expect(chatTextFromConversation(frame)).toBe('Working on the header.');
  });

  it('drops package tags, which are instructions rather than speech', () => {
    const frame = 'Adding charts. <package>recharts</package> Done.';
    expect(chatTextFromConversation(frame)).toBe('Adding charts.  Done.');
  });

  it('returns nothing for a frame that is only code', () => {
    const frame = [
      `${FENCE}tsx{path=app/page.tsx}`,
      'export default function Page() {}',
      FENCE,
    ].join('\n');

    // The caller appends nothing for an empty string, which is the one case the old
    // substring filter got right.
    expect(chatTextFromConversation(frame)).toBe('');
  });

  it('returns nothing for whitespace', () => {
    expect(chatTextFromConversation('   \n  ')).toBe('');
  });
});
