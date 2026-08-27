/**
 * No sentence reaches chat as the model's unless the model wrote it.
 *
 * The generate route matched `<explanation>…</explanation>` in the reply and, when
 * it found none, put the literal `'Code generated successfully!'` on the `complete`
 * frame. No prompt in `lib/stack-prompts/*` asks for that tag — the output contract
 * is fenced ```lang{path=…} files and prose — so the fallback is what shipped on
 * every single run, and the workspace posts `explanation` as an `ai` message under
 * an `if (explanation)` guard a non-empty default can never fail. Every finished
 * build therefore closed with a canned line attributed to the model, immediately
 * after the model's own scrubbed closing words: the duplicate closing line F-053
 * removed, rebuilt out of a fallback value.
 *
 * It was also the one route to the transcript `createConversationalScrubber` did
 * not cover. The stream loop's `isInTag` gate keeps an `<explanation>` block out of
 * `conversationalBuffer`, so a `NEED_IMAGE:` or `Skill:` directive written inside
 * the block travelled to chat through this extraction, unscrubbed.
 *
 * The route is a single 2400-line handler with no exportable seams — a Next route
 * module may export only its HTTP verbs — so the wiring is asserted against its
 * source and the scrubbing against the production scrubber itself.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createConversationalScrubber } from '@/lib/generation/output-summary';
import { codeBetween, requireAnchor } from '../setup/source-slice';

const ROUTE = readFileSync(
  path.join(process.cwd(), 'app/api/generate-ai-code-stream/route.ts'),
  'utf8',
);
const PROMPTS = ['base-rules.ts', 'shared.ts', 'nextjs.ts', 'react.ts', 'static-html.ts'].map(
  (file) => readFileSync(path.join(process.cwd(), 'lib/stack-prompts', file), 'utf8'),
);

/**
 * The route with its comments removed. The comment above the extraction records the
 * literal that was deleted — the sentence is the point of the comment — so a scan
 * for the canned line has to read code only or it fails on its own explanation.
 */
const ROUTE_CODE = ROUTE.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * The `<explanation>` handling, code only, up to the truncation scan after it.
 *
 * The end anchor is the *declaration*, not its initialiser: the tool path skips
 * truncation detection (there is no unclosed fence to recover when files arrive as
 * validated tool calls), so the line now reads
 * `const truncatedFiles = useTools ? [] : detectTruncatedFiles(...)`. Anchoring on
 * the call spelling pinned an expression that had no business being stable.
 */
function explanationBlock() {
  return codeBetween(ROUTE, 'const explanationMatch =', 'const truncatedFiles =');
}

/** The final `complete` frame — the one that closes a build that wrote files. */
function completeFrame() {
  const at = ROUTE.lastIndexOf("type: 'complete',");
  expect(at, 'the route sends no complete frame at all').toBeGreaterThan(-1);
  const open = ROUTE.lastIndexOf('await sendProgress({', at);
  const close = requireAnchor(ROUTE.slice(at), '});', 'end of the complete frame') + at;
  return ROUTE.slice(open, close);
}

describe('the <explanation> tag is protocol nothing asks for', () => {
  it('appears in no generation prompt, which is why the fallback was what shipped', () => {
    for (const prompt of PROMPTS) {
      expect(prompt).not.toMatch(/<explanation>/);
    }
  });
});

describe('a build closes without a line the model never wrote', () => {
  it('has no canned success sentence left to attribute to anyone', () => {
    expect(ROUTE_CODE).not.toContain('Code generated successfully!');
  });

  it('does not fall back to a default when the reply carries no explanation', () => {
    const block = explanationBlock();
    // A ternary here is the shape of the bug: the miss branch is the every-run branch.
    expect(block).not.toMatch(/explanationMatch\s*\n?\s*\?/);
    expect(block).toMatch(/if \(explanationMatch\) \{/);
  });

  it('keeps `explanation` off the complete frame, so the workspace posts no ai message for it', () => {
    // The workspace does `addChatMessage(explanation, 'ai')` for anything non-empty
    // here; an absent field is what makes that guard mean something again.
    expect(completeFrame()).not.toMatch(/^\s*explanation,?\s*$/m);
    expect(completeFrame()).toMatch(/type: 'complete',/);
    // The rest of the frame is untouched — this is not a frame rewrite.
    expect(completeFrame()).toMatch(/files: files\.length,/);
    expect(completeFrame()).toMatch(/skillNames: injectedSkills\.names,/);
  });

  it('still names the skills that were applied, which never depended on the explanation', () => {
    // Chips render from `metadata.skillNames`, and the route sends them on their own
    // `skills` frame the moment they are injected — the client stamps them onto the
    // user's message. Dropping the canned ai message costs the reader nothing.
    expect(ROUTE).toMatch(/sendProgress\(\{ type: 'skills', names: injectedSkills\.names \}\)/);
  });
});

describe('an explanation the model does write goes to chat the way every other word does', () => {
  it('is sent as a conversation frame, through the shared scrubber', () => {
    const block = explanationBlock();
    expect(block).toMatch(/createConversationalScrubber\(\)\.finish\(explanationMatch\[1\]\)/);
    expect(block).toMatch(/sendProgress\(\{ type: 'conversation', text: spoken \}\)/);
  });

  it('sends nothing when the block held only protocol', () => {
    // An empty `conversation` frame renders as an empty assistant bubble, which is
    // the rule the stream loop's own flush already follows.
    expect(explanationBlock()).toMatch(/if \(spoken\)/);
  });

  it('strips a NEED_IMAGE directive instead of reading it out to the user', () => {
    const scrubbed = createConversationalScrubber().finish(
      'Built the landing page.\nNEED_IMAGE: a barista pouring chai | 1:1\n',
    );
    expect(scrubbed).not.toContain('NEED_IMAGE');
    expect(scrubbed).toContain('Built the landing page.');
  });

  it('strips a Skill: marker the chips already show', () => {
    const scrubbed = createConversationalScrubber().finish(
      'Skill: Landing page structure\nHere is your site.',
    );
    expect(scrubbed.trim()).toBe('Here is your site.');
  });
});
