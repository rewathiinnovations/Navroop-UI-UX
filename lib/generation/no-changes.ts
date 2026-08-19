import { COMPLETION_RULES } from '@/lib/stack-prompts/shared';

const FOLLOW_UP_NO_FILES =
  'No changes were made: the AI did not return any files for this request. Please try again, and describe the change in a little more detail — for example, name the page, section or component you want changed.';

export function describeNoChanges(input: {
  isEdit: boolean;
  hasProjectFiles: boolean;
  hasManifest: boolean;
  providersTried?: readonly string[];
}): string {
  if (input.isEdit && !input.hasProjectFiles) {
    return "No changes were made. I could not load this project's current files, so there was nothing to edit. Open the project preview so its workspace starts and its files load, then send this request again.";
  }
  if (input.isEdit && !input.hasManifest) {
    return "No changes were made. I could read this project's files but not work out how they fit together, so I could not tell which file to edit. Please send the request again and name the page or section you want changed.";
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

/** Told to the user in chat when the corrective ask goes out — a retry is never silent. */
export const MISSING_FILES_ASKED_AGAIN =
  'That reply tried to change the project but contained no files we could save, so the AI was asked once more for them.';

/** Recorded on the job so /admin/jobs shows the miss even when the retry then succeeds. */
export const MISSING_FILES_STEP_ERROR =
  'The reply tried to change the project but contained no file blocks, so nothing could be saved.';
