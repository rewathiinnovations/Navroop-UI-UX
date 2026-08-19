import { describe, expect, it } from 'vitest';
import {
  claimsFilesItDidNotSend,
  classifyReplyOutcome,
  MISSING_FILES_CORRECTION,
} from '../../lib/generation/no-changes';
import { filesFromReply } from '../../lib/generation/parse-blocks';
import { COMPLETION_RULES } from '../../lib/stack-prompts/shared';

/**
 * A FOLLOWUP that produced no files used to be a failure, full stop.
 *
 * Live incident, request `PhQfrFGYDYZo`: a 33-file BUILD had already succeeded on the
 * project, the user typed "hello", and the model answered conversationally — correctly.
 * Because every chat message in build mode goes through the file-generating path, the job
 * FAILED with `no_files_generated` ("The last edit did not finish / The AI finished without
 * producing any files") and the workspace drew the red recovery panel with a Try again
 * button. Nothing was broken except the reporting.
 *
 * These tests pin the three meanings a fileless reply can have, because the middle one is
 * the one that was missing: an answer is not a failure.
 */

/**
 * The shape of that reply. The three quoted fragments are verbatim from the dev-server log
 * of the run above, in stream order; the sentences joining them are reconstructed to the
 * same shape and length (~400 chars), not copied — the reply itself was never persisted.
 */
const CONVERSATIONAL_ANSWER = [
  'Hello! Your landing page is built and running.',
  '',
  'I can help you with the next step. For example, I can:',
  '- Change the copy or images in a section',
  '- Adjust the colours, spacing or app structure - looks are easy to tune',
  '- Fix a component or add a new section to the page',
  '',
  'Just tell me what you want to change and I will do it.',
].join('\n');

/** A reply that says the work is done and ships nothing. This is the retry case. */
const CLAIMED_BUT_SENT_NOTHING = [
  "I've updated the hero section with the new headline and swapped the background image.",
  'The footer now carries the contact details you asked for, and the spacing above the',
  'testimonials is tighter.',
].join('\n');

describe('claimsFilesItDidNotSend', () => {
  it('treats the live conversational reply as an answer, not a missing build', () => {
    // The whole point of the incident: this reply owes nothing, so nothing is asked again
    // and no build is started for a person who typed "hello".
    expect(claimsFilesItDidNotSend(CONVERSATIONAL_ANSWER)).toBe(false);
  });

  it('treats plain greetings and offers of help as answers', () => {
    for (const reply of [
      'Hello! What would you like to build today',
      'Hi there. How can I help with this project',
      "I'm ready to make changes whenever you are.",
      'Happy to help — which page did you have in mind',
      'Could you tell me which section you mean.',
    ]) {
      expect(claimsFilesItDidNotSend(reply)).toBe(false);
    }
  });

  it('treats any question as an answer', () => {
    expect(claimsFilesItDidNotSend('Do you want the pricing table above or below the FAQ?')).toBe(
      false,
    );
  });

  it('asks again when the reply claims a change it never shipped', () => {
    expect(claimsFilesItDidNotSend(CLAIMED_BUT_SENT_NOTHING)).toBe(true);
  });

  it('asks again when source was pasted outside the {path=…} contract', () => {
    // `output-summary.ts` names this exact fault: fences but no path-tagged fences is a
    // model ignoring the output contract. Nothing can save such a reply, and the client
    // filters code out of the chat transcript, so leaving it alone drops it twice over.
    const bareFence = ['Here you go:', '', '```tsx', "import React from 'react';", '```'].join(
      '\n',
    );
    expect(claimsFilesItDidNotSend(bareFence)).toBe(true);
    expect(claimsFilesItDidNotSend('export default function Page() {\n  return null;\n}')).toBe(
      true,
    );
  });

  it('does not read a `?` inside pasted code as a question', () => {
    // Real code is full of `?` — ternaries, optional chaining, JSX props. Scanning the
    // whole reply for one would classify every pasted file as a question and never ask
    // for the files back.
    const codeWithTernary = [
      'Done:',
      '',
      '```tsx',
      "import { clsx } from 'clsx';",
      'export const cls = (on?: boolean) => (on ? clsx("a") : "b");',
      '```',
    ].join('\n');
    expect(claimsFilesItDidNotSend(codeWithTernary)).toBe(true);
  });

  it('leaves a question answered with a snippet as an answer', () => {
    // A person asking how something works must not have a build started on their behalf.
    const explainer = [
      'You centre it with flexbox. Want me to apply that to the hero?',
      '',
      '```css',
      '.hero { display: flex; align-items: center; }',
      '```',
    ].join('\n');
    expect(claimsFilesItDidNotSend(explainer)).toBe(false);
  });

  it('is false for nothing at all — a silent stream is a provider fault, not a claim', () => {
    expect(claimsFilesItDidNotSend('')).toBe(false);
    expect(claimsFilesItDidNotSend('   \n\t ')).toBe(false);
  });
});

describe('classifyReplyOutcome', () => {
  it('reports files whenever any file parsed, whatever the prose said', () => {
    expect(
      classifyReplyOutcome({ fileCount: 3, reply: CONVERSATIONAL_ANSWER, askedAgain: false }),
    ).toBe('files');
    expect(
      classifyReplyOutcome({ fileCount: 1, reply: CLAIMED_BUT_SENT_NOTHING, askedAgain: true }),
    ).toBe('files');
  });

  it('reports an answer for the live conversational reply', () => {
    expect(
      classifyReplyOutcome({ fileCount: 0, reply: CONVERSATIONAL_ANSWER, askedAgain: false }),
    ).toBe('answer');
  });

  it('never asks again for a conversational reply, even before the ask is spent', () => {
    // Contract: "hello" must not trigger a build. If the corrective ask ever fires on a
    // conversational message, that is a bug.
    expect(classifyReplyOutcome({ fileCount: 0, reply: 'hello', askedAgain: false })).not.toBe(
      'ask_again',
    );
  });

  it('asks exactly once for a reply that owed files', () => {
    expect(
      classifyReplyOutcome({ fileCount: 0, reply: CLAIMED_BUT_SENT_NOTHING, askedAgain: false }),
    ).toBe('ask_again');
    // The ask is spent, so the second miss is reported honestly instead of asking forever.
    expect(
      classifyReplyOutcome({ fileCount: 0, reply: CLAIMED_BUT_SENT_NOTHING, askedAgain: true }),
    ).toBe('no_files');
  });

  it('reports no files for a silent stream, before and after the ask', () => {
    expect(classifyReplyOutcome({ fileCount: 0, reply: '', askedAgain: false })).toBe('no_files');
    expect(classifyReplyOutcome({ fileCount: 0, reply: '  ', askedAgain: true })).toBe('no_files');
  });
});

describe('MISSING_FILES_CORRECTION', () => {
  it('repeats the prompt’s own fenced contract verbatim rather than describing it again', () => {
    // Two descriptions of one contract drift apart, and the model then satisfies whichever
    // one it happened to read.
    expect(MISSING_FILES_CORRECTION).toContain(COMPLETION_RULES);
  });

  it('names the failure and forbids another question or explanation', () => {
    expect(MISSING_FILES_CORRECTION).toMatch(/no file block/i);
    expect(MISSING_FILES_CORRECTION).toMatch(/do not ask a question/i);
    expect(MISSING_FILES_CORRECTION).toMatch(/do not explain/i);
  });
});

/**
 * The route asks two questions in a row: what did the block parser find, and what does a
 * fileless reply mean. Each is covered above on its own; these run the pair together on the
 * three replies that matter, because the answer to the second only makes sense given the
 * first.
 */
describe('the parsed reply and the classification agree', () => {
  function outcomeOf(reply: string, askedAgain = false) {
    return classifyReplyOutcome({
      fileCount: Object.keys(filesFromReply(reply)).length,
      reply,
      askedAgain,
    });
  }

  it('reads the live conversational reply as an answer', () => {
    expect(Object.keys(filesFromReply(CONVERSATIONAL_ANSWER))).toEqual([]);
    expect(outcomeOf(CONVERSATIONAL_ANSWER)).toBe('answer');
  });

  it('reads a claim with no fences as one corrective ask, then as a failure', () => {
    expect(Object.keys(filesFromReply(CLAIMED_BUT_SENT_NOTHING))).toEqual([]);
    expect(outcomeOf(CLAIMED_BUT_SENT_NOTHING)).toBe('ask_again');
    expect(outcomeOf(CLAIMED_BUT_SENT_NOTHING, true)).toBe('no_files');
  });

  it('reads the corrective reply’s path-tagged fences as files', () => {
    // What the corrective ask demands back, in the shape COMPLETION_RULES specifies.
    const corrected = [
      '```tsx{path=app/page.tsx}',
      'export default function Page() {',
      '  return <main>Hello</main>;',
      '}',
      '```',
    ].join('\n');
    expect(Object.keys(filesFromReply(corrected))).toEqual(['app/page.tsx']);
    expect(outcomeOf(corrected, true)).toBe('files');
  });
});
