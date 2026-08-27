import {
  formatNeedImageToken,
  hasNeedImageMarker,
  needImageKey,
  parseNeedImageDirectives,
  type NeedImageDirective,
} from '@/lib/assets/need-image';
import { explanationFromReply } from '@/lib/generation/parse-blocks';
import { BASE_RULES } from '@/lib/stack-prompts/base-rules';
import { COMPLETION_RULES } from '@/lib/stack-prompts/shared';

const FOLLOW_UP_NO_FILES =
  'No changes were made: the AI did not return any files for this request. Please try again, and describe the change in a little more detail — for example, name the page, section or component you want changed.';

export function describeNoChanges(input: {
  isEdit: boolean;
  hasProjectFiles: boolean;
  /**
   * Legacy flag from the deleted edit-search manifest; nothing produces a
   * manifest any more, so it no longer selects a message. Kept so the
   * generate route's call site stays source-compatible.
   */
  hasManifest: boolean;
  providersTried?: readonly string[];
}): string {
  if (input.isEdit && !input.hasProjectFiles) {
    // There is no workspace VM to "start" any more — the preview compiles in
    // the browser. The only recovery that exists is asking again, so that is
    // what the copy offers.
    return 'No changes were made: the AI did not send back any updated files for this request. Use Try again, and describe the change in a little more detail — for example, name the page, section or component you want changed.';
  }
  if (input.isEdit) return FOLLOW_UP_NO_FILES;

  const tried = (input.providersTried ?? []).filter(Boolean);
  const named = tried.length > 0 ? tried.join(', ') : 'the configured AI providers';
  return `The first build finished without any files. Every provider we tried (${named}) returned no files.`;
}

/**
 * A reply that parsed to zero files is not automatically a failure.
 *
 * Live incident (request `PhQfrFGYDYZo`): a 33-file BUILD had already succeeded, the user
 * typed "hello", and the model answered in prose — correctly. Because every chat message in
 * build mode goes through the file-generating path, that answer was reported as
 * `no_files_generated` ("The AI finished without producing any files"), the job FAILED and
 * the workspace drew the red recovery panel with a Try again button. Nothing was broken
 * except the reporting.
 *
 * So a fileless reply has three meanings, and only two of them are failures:
 *   - nothing came back at all → the provider produced nothing; a real failure
 *   - the reply is an answer    → surface it in chat; the turn simply changed nothing
 *   - the reply owed us files   → ask once more, then report honestly
 */
export type ReplyOutcome =
  /** Files parsed out of the reply; the normal path. */
  | 'files'
  /** The reply owed files. One corrective ask against the same provider is warranted. */
  | 'ask_again'
  /** Nothing usable, and asking again is either spent or pointless. */
  | 'no_files'
  /** A conversational answer. Not a failure: nothing was asked to change. */
  | 'answer';

export function classifyReplyOutcome(input: {
  fileCount: number;
  reply: string;
  /** True once the single corrective ask has been spent — it is never repeated. */
  askedAgain: boolean;
}): ReplyOutcome {
  if (input.fileCount > 0) return 'files';
  // A silent stream is a provider that produced nothing, not an answer. That path already
  // fails over to the next provider and reports honestly, and it stays as it was.
  if (!input.reply.trim()) return 'no_files';
  if (!claimsFilesItDidNotSend(input.reply)) return 'answer';
  return input.askedAgain ? 'no_files' : 'ask_again';
}

/**
 * Whether a provider attempt did its job. That is the only question the failover layer
 * asks, and this is the whole answer to it: the model said something.
 *
 * "Files or nothing" used to be the answer, which made a conversational reply a failed
 * attempt — `shouldFailover` reads an empty completion as a reason to try the NEXT vendor,
 * so a user typing "hello" walked the entire provider chain, paid a second vendor for the
 * same answer, recorded a failure against a healthy provider's circuit breaker, and ended
 * as `no_files_generated`. Whether the text contained files is a separate question, decided
 * once by {@link classifyReplyOutcome} on the final reply.
 *
 * A silent stream — no text at all — is still an incomplete attempt and still fails over.
 * `stop` is the disconnected client: that run is over on purpose, not incomplete.
 */
export function attemptProducedOutput(out: {
  stop: boolean;
  files: readonly unknown[];
  generatedCode: string;
}): boolean {
  return out.stop || out.files.length > 0 || out.generatedCode.trim().length > 0;
}

/** Phrases in which the model is asking the user for direction instead of building. */
const ASKS_FOR_DIRECTION = [
  /\bjust tell me\b/i,
  /\blet me know\b/i,
  /\btell me (?:what|which|more)\b/i,
  /\bwhat (?:would|do) you\b/i,
  /\bwhat (?:kind|sort|type) of\b/i,
  /\bwhich (?:page|section|component|file|part|one)\b/i,
  /\bplease (?:provide|share|describe|specify|tell|send)\b/i,
  /\b(?:could|can|would) you (?:please )?(?:tell|share|describe|specify|clarify|confirm)\b/i,
  /\bclarif(?:y|ication)\b/i,
  /\bhow can i (?:help|assist)\b/i,
  /\b(?:i'?m|i am) ready to\b/i,
  /\bhappy to help\b/i,
];

/** Phrases in which the model claims it already changed the project. */
const CLAIMS_A_CHANGE = [
  /\b(?:i|we)(?:'ve|'ll| have| had| will)?\s+(?:just\s+|now\s+)?(?:updated|added|created|changed|modified|fixed|removed|replaced|implemented|refactored|rewrote|rewritten|built|made)\b/i,
  /\bhere(?:'s| is| are) the (?:updated|new|complete|full|revised|final|changed)\b/i,
  /\bthe (?:following|updated|new) (?:files?|code|components?)\b/i,
  /\bchanges? (?:are|is|have been|has been) (?:complete|completed|applied|made|done)\b/i,
];

/**
 * Lines that only ever occur in a source file, never in chat prose.
 *
 * This is the same family of signals the client already uses to keep code out of the chat
 * transcript (`generation-runtime.ts` drops a `conversation` frame containing `import
 * React`, `export default` or `className=`) and the same fault `output-summary.ts` names: a
 * reply with fences but no `{path=…}` fences is a model ignoring the output contract. The
 * test is on the source lines rather than on the fence, because a model that drops the
 * fence altogether fails in exactly the same way. Since this only runs when the reply parsed
 * to zero files, source text here means the model tried to ship code in a shape nothing can
 * save — those files are owed, not answered. Left unasked, such a reply is silently dropped
 * twice over: nothing to persist, and the client filters it out of chat too.
 */
const FILE_SHAPE = [
  /^\s*import\s+[^\n]*from\s+['"]/m,
  /^\s*export\s+(?:default|const|function|class)\b/m,
  /^\s*<!DOCTYPE\s+html/im,
];

/**
 * True when a fileless reply was an attempt to change the project rather than an answer:
 * it either claims a change it never shipped, or pastes source that missed the `{path=…}`
 * contract. False for a question, a request for direction, or plain conversation — those are
 * answers, and reporting one as a missing build is the incident documented above.
 *
 * Call only when the reply parsed to zero files.
 */
export function claimsFilesItDidNotSend(reply: string): boolean {
  // Everything outside a fenced block: what the model said, without the code it pasted.
  const prose = reply.replace(/```[\s\S]*?(?:```|$)/g, ' ').trim();
  // A question is always an answer. Asked of the prose only: real code is full of `?`
  // (ternaries, optional chaining, JSX props), so scanning the whole reply would read a
  // pasted file as a question and never ask for the files back.
  if (prose.includes('?')) return false;
  if (ASKS_FOR_DIRECTION.some((phrase) => phrase.test(prose))) return false;
  if (FILE_SHAPE.some((shape) => shape.test(reply))) return true;
  return CLAIMS_A_CHANGE.some((phrase) => phrase.test(prose));
}

/**
 * The corrective ask for a reply that owed files.
 *
 * It repeats `COMPLETION_RULES` verbatim rather than describing the fenced contract a
 * second time in its own words — two descriptions of one contract drift apart, and the
 * model then satisfies whichever one it happened to read.
 */
export const MISSING_FILES_CORRECTION = `Your last reply changed nothing: it contained no file block, so there was nothing to save.

Send the files now, complete. Do not ask a question. Do not explain what you would do.

${COMPLETION_RULES}`;

/**
 * The second thing a reply can owe: every picture it described in prose that no file it
 * sent actually carries.
 *
 * Live reproduction (deepseek-v4-flash, NEXTJS, a cafe landing page): the model wanted
 * four photographs and wrote all four requests as prose lines in its reply rather than as
 * the `src` value of an image element. Eleven files shipped with no `<img>`, no
 * `next/image` and no `backgroundImage`; `/api/projects/{id}/assets` answered
 * `{"assets":[]}`. The prompt already says the token IS the URL and must never sit on a
 * line of its own — but a prompt is a request, not a guarantee, and the round that made
 * the settle *buy* those pictures instead only added a bill to the same empty page. So it
 * is decided here, on the reply, and repaired the way owed files are: one corrective ask
 * to the model that just answered, then the file-side fulfilment that already works.
 * Nothing in this module reaches an image provider.
 *
 * The prose parse runs on {@link explanationFromReply} — the reply with its fenced blocks
 * removed — rather than on the whole reply, because a token inside a `src` is exactly the
 * case that is *not* owed, and the prose terminator set would read it (quote and all) as a
 * second request for the same picture. Subtracting on {@link needImageKey} rather than on
 * the raw text is what makes `… | 1:1` in the file and `… | 1:1 | About section` in the
 * prose one picture, so a request written in both places is not reported as unplaced.
 */
export function imagesOwedByReply(input: {
  reply: string;
  files: ReadonlyArray<{ content: string }>;
}): NeedImageDirective[] {
  if (!hasNeedImageMarker(input.reply)) return [];
  const placed = placedImageKeys(input.files);
  return parseNeedImageDirectives(explanationFromReply(input.reply), 'prose').filter(
    (directive) => !placed.has(needImageKey(directive)),
  );
}

/**
 * How many of `owed` the given files now carry — the adoption test for the corrective ask.
 *
 * A corrected reply is worth taking only when it produced what was owed; a second helping
 * of prose must leave the first reply standing, or the run would trade eleven good files
 * for whatever the nudge happened to resend.
 */
export function imagesPlacedIn(
  files: ReadonlyArray<{ content: string }>,
  owed: readonly NeedImageDirective[],
): number {
  if (owed.length === 0) return 0;
  const placed = placedImageKeys(files);
  return owed.filter((directive) => placed.has(needImageKey(directive))).length;
}

function placedImageKeys(files: ReadonlyArray<{ content: string }>): Set<string> {
  const contents = files.map((file) => file.content).join('\n');
  if (!hasNeedImageMarker(contents)) return new Set();
  return new Set(parseNeedImageDirectives(contents, 'file').map(needImageKey));
}

/**
 * How many requests the corrective ask lists back.
 *
 * The file side is bounded by the site — a token has to sit in a `src` to count — but
 * reply prose has no such bound, and a chatty model listing thirty "nice to have" pictures
 * would otherwise turn the ask into a wall of protocol that buries the instruction under
 * it. Anything past this stays unplaced and is reported as unplaced.
 */
export const MAX_CORRECTIVE_IMAGE_TOKENS = 8;

/**
 * The prompt's own image rules, quoted rather than restated.
 *
 * Same discipline as {@link MISSING_FILES_CORRECTION} repeating `COMPLETION_RULES`: two
 * descriptions of one contract drift apart and the model satisfies whichever it read.
 * `BASE_RULES` ends with its `IMAGES:` section, so the slice is the whole of it; an empty
 * result means that section moved or was renamed, which is a drift the correction must not
 * paper over with a paraphrase — `tests/unit/reply-owed-images.test.ts` fails on it.
 */
export const IMAGE_PLACEMENT_RULES = (() => {
  const at = BASE_RULES.indexOf('\nIMAGES:\n');
  return at === -1 ? '' : BASE_RULES.slice(at + 1).trim();
})();

/** The corrective ask for pictures the reply described instead of placing. */
export function imagePlacementCorrection(owed: readonly NeedImageDirective[]): string {
  const listed = owed.slice(0, MAX_CORRECTIVE_IMAGE_TOKENS);
  const one = listed.length === 1;
  const complaint = [
    `Your last reply asked for ${one ? 'a picture' : `${listed.length} pictures`} in words instead of placing ${one ? 'it' : 'them'}.`,
    'A NEED_IMAGE token only becomes a photograph where it stands: written as the src value inside a file it is rewritten to a real URL before the files are saved, and written anywhere else — a line of its own, a list, a comment, your reply text — it produces no picture at all.',
    `The files you sent carry no image for ${one ? 'this request' : 'any of these requests'}:`,
  ].join(' ');
  const tokens = listed.map(formatNeedImageToken).join('\n');
  // The list above puts the tokens on lines of their own, which is the shape the rules
  // forbid — so the instruction says outright that the list is the request and not the
  // layout. Without that a model can copy the nearest example it can see, which here is
  // the mistake it is being corrected for.
  const instruction =
    'That list is what you asked for, not where it goes. Send those files now, complete, with each token above written exactly as it appears here — as the src value of its image element, or as the og:image URL in metadata. Do not ask a question. Do not explain what you would do.';
  const rules = IMAGE_PLACEMENT_RULES
    ? `${COMPLETION_RULES}\n\n${IMAGE_PLACEMENT_RULES}`
    : COMPLETION_RULES;
  return `${complaint}\n\n${tokens}\n\n${instruction}\n\n${rules}`;
}

/** Told to the user in chat when the corrective ask goes out — a retry is never silent. */
export const MISSING_FILES_ASKED_AGAIN =
  'That reply tried to change the project but contained no files we could save, so the AI was asked once more for them.';

/** Recorded on the job so /admin/jobs shows the miss even when the retry then succeeds. */
export const MISSING_FILES_STEP_ERROR =
  'The reply tried to change the project but contained no file blocks, so nothing could be saved.';

/** The images twin of {@link MISSING_FILES_ASKED_AGAIN}. Plain words, never the protocol. */
export function unplacedImagesAskedAgain(count: number): string {
  return count === 1
    ? 'That reply described an image in words instead of putting it on the page, so the AI was asked once more to place it.'
    : `That reply described ${count} images in words instead of putting them on the page, so the AI was asked once more to place them.`;
}

/** Recorded on the job so /admin/jobs shows the miss even when the ask then succeeds. */
export const MISSING_IMAGES_STEP_ERROR =
  'The reply asked for images in its own words instead of writing the tokens into an image src, so the generated files carried no pictures.';

/**
 * The floor under the corrective ask: what the person is told when the pictures are still
 * not on the page.
 *
 * Reached when the ask was skipped, failed, or the model wrote prose a second time. The
 * `NEED_IMAGE:` lines themselves are stripped from the transcript (`stripNeedImageTokens`),
 * and deleting them silently would trade one invisible failure for another — the person
 * asked for a cafe page, four photographs were requested, and the page has none. Says that
 * in plain words. It does not claim the pictures exist somewhere: nothing bought them,
 * because a picture nothing references is spend with no product.
 */
export function unplacedImagesNotice(input: { count: number; asked: boolean }): string {
  const one = input.count === 1;
  const described = one
    ? 'The AI described an image in words instead of putting it on the page'
    : `The AI described ${input.count} images in words instead of putting them on the page`;
  const retried = input.asked ? (one ? ', and did not place it when asked again' : ', and did not place them when asked again') : '';
  const result = one
    ? ', so the page has no photograph there.'
    : ', so the page has no photographs where they belong.';
  const nextStep = one
    ? ' Ask for it again, or upload your own picture from the Assets tab.'
    : ' Ask for them again, or upload your own pictures from the Assets tab.';
  return `${described}${retried}${result}${nextStep}`;
}
