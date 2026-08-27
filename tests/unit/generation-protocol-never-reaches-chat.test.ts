import { describe, expect, it } from 'vitest';
import { createConversationalScrubber, SKILL_MARKER_PREFIX } from '@/lib/generation/output-summary';
import { buildSkillInjectionBlock } from '@/lib/skills/inject';

/**
 * The generate route flushes `conversationalBuffer` as a `conversation` frame, and
 * that frame *is* the assistant's chat message. A live build (deepseek-v4-flash,
 * NEXTJS, Chai Point) put its four picture requests and the two skills it had been
 * given into that stream, so the customer's first build ended with
 *
 *   NEED_IMAGE: Interior of a cozy tea cafe … | 16:9 | Hero background
 *   Skill: Landing page structure
 *
 * in the transcript. Internal protocol is not speech, and no shape of it may reach
 * the client — including one the flush boundary cut in half.
 */

const CHAI_POINT_REPLY = [
  'I have built the Chai Point landing page.',
  '',
  'Skill: Landing page structure',
  'Skill: Form UX',
  '',
  'NEED_IMAGE: Interior of a cozy tea cafe with warm lighting | 16:9 | Hero background',
  'NEED_IMAGE: Open graph image with Chai Point branding | 1200x630',
  '',
  'Tell me if you want a different palette.',
].join('\n');

describe('internal protocol never reaches the chat transcript', () => {
  it('strips both marker families out of one flush', () => {
    const chat = createConversationalScrubber().finish(CHAI_POINT_REPLY);

    expect(chat).not.toContain('NEED_IMAGE');
    expect(chat).not.toContain(SKILL_MARKER_PREFIX);
    expect(chat).toContain('Chai Point landing page');
    expect(chat).toContain('different palette');
  });

  it('holds a directive that a flush boundary cut in half', () => {
    // The buffer is flushed the moment a `<file …>` opener arrives, which can land
    // anywhere — including inside a token. Scrubbing each half on its own removes the
    // front and lets ` cafe … | 16:9` through as if it were prose.
    const scrubber = createConversationalScrubber();

    const first = scrubber.take('Building it now.\nNEED_IMAGE: Interior of a cozy tea');
    const second = scrubber.finish(' cafe with warm lighting | 16:9\nDone.');

    expect(first).toBe('Building it now.\n');
    expect(second).not.toContain('NEED_IMAGE');
    expect(second).not.toContain('cafe with warm lighting');
    expect(second).toContain('Done.');
    expect(`${first}${second}`).not.toContain('16:9');
  });

  it('holds a skill marker that a flush boundary cut in half', () => {
    const scrubber = createConversationalScrubber();

    const first = scrubber.take('Here you go.\nSkill: Landing page');
    const second = scrubber.finish(' structure\nAll set.');

    expect(first).toBe('Here you go.\n');
    expect(second).not.toContain('Landing page structure');
    expect(second).toContain('All set.');
  });

  it('releases a held fragment that never gets completed', () => {
    const scrubber = createConversationalScrubber();

    expect(scrubber.take('NEED_IMAGE: a hero shot')).toBe('');
    // The stream ended mid-token. Nothing may survive by simply never finishing.
    expect(scrubber.finish()).not.toContain('NEED_IMAGE');
  });

  it('never holds ordinary prose back across a flush', () => {
    // The text on either side of a flush is not contiguous — a whole `<file>` block
    // sits between them — so gluing unrelated halves would feed real sentences into
    // the NEED_IMAGE sweep and delete them.
    const scrubber = createConversationalScrubber();

    const first = scrubber.take('Here is the hero section');
    const second = scrubber.finish(' and here is the footer.');

    expect(first).toBe('Here is the hero section');
    expect(second).toBe(' and here is the footer.');
  });

  it('leaves a reply with no protocol in it byte-for-byte alone', () => {
    const plain = 'I updated the pricing table and tightened the spacing.';

    expect(createConversationalScrubber().finish(plain)).toBe(plain);
  });

  it('keeps a paragraph that merely opens with the marker word', () => {
    // Anchored and length-bounded: a line that is *only* `Skill: X` is the chip
    // syntax; a sentence that runs on is the assistant answering a question.
    const prose =
      'Skill: the workspace skill you asked about is applied whenever the request mentions a landing page, a hero, or a call to action, so it fires here.';

    expect(createConversationalScrubber().finish(prose)).toBe(prose);
  });
});

describe('the skill block asks for what the stripper enforces', () => {
  it('tells the model not to announce the skills it was given', () => {
    const block = buildSkillInjectionBlock([
      { name: 'Landing page structure', content: 'Use one primary CTA.' },
    ]);

    // The instruction and the stripper have to be talking about the same string, or
    // the prompt asks for one thing and the route removes another.
    expect(block).toContain(SKILL_MARKER_PREFIX);
    expect(block).toContain('Never name or announce these skills');
    // The block still does its actual job.
    expect(block).toContain('### Landing page structure');
    expect(block).toContain('Use one primary CTA.');
  });
});
