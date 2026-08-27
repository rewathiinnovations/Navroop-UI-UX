import { stripNeedImageTokens } from '@/lib/assets/need-image';

const PREVIEW_CHARS = 120;

/**
 * A one-line shape report for a model reply, logged next to every stream.
 *
 * `pathFences` vs `fences` is the diagnostic that matters: files arrive as
 * ```lang{path=…} openers, so a reply with fences but no path-tagged ones is a
 * model ignoring the output contract, which reads as "no files generated"
 * unless the log says otherwise.
 */
export function summarizeGenerationOutput(raw: string) {
  const text = String(raw ?? '');
  const preview = text.slice(0, PREVIEW_CHARS).replace(/\s+/g, ' ').trim();
  return {
    chars: text.length,
    preview,
    pathFences: (text.match(/```[^\n`]*\{path=/g) || []).length,
    fences: (text.match(/```/g) || []).length,
  };
}

/**
 * The literal the workspace itself puts in front of an applied skill's name.
 *
 * `ChatPanel` renders one chip per entry of `metadata.skillNames` reading
 * `Skill: <name>`, and the injected block hands the model those same names under
 * `### <name>` headings. A live build echoed them back as two lines of its own —
 * `Skill: Landing page structure`, `Skill: Form UX` — which the chat then showed
 * verbatim beside the chips that already said it. Nothing ever asked the model
 * for that line, which is why `buildSkillInjectionBlock` now says so out loud and
 * imports this constant to say it: the instruction and the stripper must be
 * talking about the same string.
 */
export const SKILL_MARKER_PREFIX = 'Skill:';

/**
 * A whole line that is nothing but a skill marker, optionally bulleted, numbered
 * or bolded. Anchored and length-bounded on purpose: a paragraph that happens to
 * open with the word "Skill:" and then keeps going is prose, and deleting it
 * would be the same silent-loss failure in the other direction.
 */
const SKILL_MARKER_LINE_RE =
  /^[ \t]*(?:[-*•]\s*|\d+[.)]\s*)?\*{0,2}Skills?\*{0,2}\s*:\s*\S[^\n]{0,120}$/;

/**
 * True when a fragment could still be the front half of a protocol line.
 *
 * Only a fragment that already carries a marker is held back. Holding every
 * trailing partial line would be worse than the leak: the conversational buffer
 * is flushed when a `<file …>` opener arrives, so the text on either side of a
 * flush is *not* contiguous, and gluing two unrelated halves together would feed
 * ordinary prose into the `NEED_IMAGE:`-to-end-of-line sweep and delete it.
 */
function looksLikeProtocolFragment(line: string): boolean {
  return line.includes('NEED_IMAGE:') || SKILL_MARKER_LINE_RE.test(line);
}

function scrubConversationalChunk(text: string): string {
  const withoutImages = stripNeedImageTokens(text);
  if (!withoutImages.includes(SKILL_MARKER_PREFIX)) return withoutImages;
  return withoutImages
    .split('\n')
    .filter((line) => !SKILL_MARKER_LINE_RE.test(line))
    .join('\n');
}

/**
 * Internal protocol out of the assistant's chat message, in stream order.
 *
 * The route flushes `conversationalBuffer` as a `conversation` frame every time a
 * `<file …>` opener interrupts the prose, and that frame *is* the assistant's chat
 * message — so a single-shot `.replace()` at each flush lets through the tail of
 * any directive the flush boundary cut in half. This carries that half over to the
 * next flush instead, and `finish` releases whatever is still held when the stream
 * ends, so a fragment can never escape by simply never being completed.
 *
 * Stateful and per-attempt: a failover retry starts a new reply, so the caller
 * builds a new scrubber alongside its new `conversationalBuffer`.
 *
 * Not exported: every caller gets this shape by inference from
 * `createConversationalScrubber`, and an exported name nothing imports is a
 * symbol a test can quietly stop covering while still looking like public API.
 */
type ConversationalScrubber = {
  /** Scrub one flushed buffer. Returns '' when everything in it was protocol. */
  take(chunk: string): string;
  /** Scrub the last buffer plus anything held back. Call once, at stream end. */
  finish(chunk?: string): string;
};

export function createConversationalScrubber(): ConversationalScrubber {
  let held = '';
  return {
    take(chunk: string): string {
      const text = held + chunk;
      held = '';
      const cut = text.lastIndexOf('\n');
      const tail = cut < 0 ? text : text.slice(cut + 1);
      if (!looksLikeProtocolFragment(tail)) return scrubConversationalChunk(text);
      held = tail;
      return cut < 0 ? '' : scrubConversationalChunk(text.slice(0, cut + 1));
    },
    finish(chunk = ''): string {
      const text = held + chunk;
      held = '';
      return scrubConversationalChunk(text);
    },
  };
}
