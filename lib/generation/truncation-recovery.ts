import { extractCodeBlocks } from './parse-blocks';
import { surfaceStreamFailure, type StreamFailureSource } from '@/lib/ai/empty-completion';
import { jobErrorCodeForProviderFailure, providerFailureMessage } from '@/lib/ai/failover';
import type { ProviderName } from '@/lib/ai/providers';

/**
 * Truncation recovery re-asks the model for the files the first pass cut off.
 *
 * The recovery call is a second generation, so it fails the same ways the first one does —
 * a rejected key, an exhausted quota, a provider that is down. It used to be wrapped in a
 * bare `catch` that logged a warning and moved on, and the run then reported "Truncation
 * recovery complete" over the top of it. Two things went wrong there: the truncated file
 * was replaced with the empty string the swallowed stream returned, and the job settled as
 * if nothing had happened.
 *
 * The rule here is the opposite on both counts. A recovery that fails keeps the truncated
 * files — a file cut off mid-write is still worth more than no file — and names the cause
 * the same classifier the main path uses, so the recovery panel shows the same sentence for
 * the same failure whichever pass hit it.
 */

export const TRUNCATION_INCOMPLETE_KEPT =
  'The build is incomplete — some files were cut off mid-write, and the truncated files were kept rather than replaced with nothing.';

export type TruncationRecoveryOutcome = {
  /** A failed recovery never discards what the first pass produced. */
  keepTruncatedFiles: true;
  complete: false;
  errorCode: ReturnType<typeof jobErrorCodeForProviderFailure>;
  errorMessage: string;
};

/**
 * Drains a recovery `streamText` result and rethrows whatever the stream reported.
 *
 * `textStream` drops error parts, so a call the provider rejected iterates zero chunks and
 * resolves to `''` — indistinguishable from a model that answered with nothing. The caller
 * must bind {@link bindStreamErrorCapture}'s `onError` on the `streamText` options and pass
 * the attached result here, so the rejection surfaces as a throw instead of empty text
 * silently overwriting a real file.
 *
 * `count` is the per-job cap tracker's `addChunk` (F-042). Recovery is a second
 * generation: one call per truncated file, each bounded only by its own `maxOutputTokens`,
 * so nothing bounded the sum and a reply with several truncated files could spend N times
 * `maxTokensPerJob` without the cap firing. Returning an error from `count` aborts the
 * drain immediately, the way the main stream loop aborts on `capTracker.addChunk`, rather
 * than charging the whole file first and checking afterwards.
 */
export async function collectRecoveredStreamText(
  result: StreamFailureSource & { textStream?: AsyncIterable<string> },
  count?: (chunk: string) => Error | null,
): Promise<string> {
  let text = '';
  for await (const chunk of result.textStream ?? []) {
    text += chunk ?? '';
    const abort = count?.(chunk ?? '');
    if (abort) throw abort;
  }
  const failure = await surfaceStreamFailure(result);
  if (failure != null) throw failure;
  return text;
}

export type TruncatedFile = {
  /**
   * The key `extractCodeBlocks` produced: leading `./` already stripped and the `-2`
   * suffix applied when two blocks claim one path. Recovery hands this straight to
   * `replaceBlockInReply`, which compares against that same key — so a `./`-prefixed
   * or deduplicated fence path is found rather than missed.
   */
  path: string;
  /** The sentence the run reports for this file — shown in chat, logged, kept on the job. */
  warning: string;
};

/**
 * Which files the reply cut off, keyed to the fenced `{path=…}` contract.
 *
 * These checks used to scan for `<file path="…">` XML tags — a shape the prompt has never
 * asked for, since `COMPLETION_RULES` mandates fenced blocks — so they matched nothing on
 * real output: `enableTruncationRecovery` was dead code and a reply cut off mid-file
 * shipped as a successful build. The fence is the contract, and a block whose closing
 * fence never arrived is the strongest signal a reply was cut off.
 *
 * An ellipsis on its own is deliberately not a signal, and neither is a short file that
 * exports something: spread operators, `...rest` props and "Loading…" copy made both
 * constant false positives, and a false positive here spends a second model call.
 */
export function detectTruncatedFiles(reply: string): TruncatedFile[] {
  const truncated: TruncatedFile[] = [];
  for (const block of extractCodeBlocks(reply)) {
    // A snippet the model never named cannot be re-asked for by path.
    if (!block.declaredPath) continue;
    const content = block.code.trim();
    const isScript = /\.(?:jsx?|tsx?)$/.test(block.path);
    const isDeclaration = /\.d\.[cm]?ts$/.test(block.path);
    const openBraces = (content.match(/\{/g) || []).length;
    const closeBraces = (content.match(/\}/g) || []).length;
    const endsAbruptly = content.endsWith('...') || content.endsWith(',') || content.endsWith('(');
    const hasEllipsis =
      content.includes('...') && !content.includes('...rest') && !content.includes('...props');
    // Models also just forget the final fence on an otherwise finished file, and a false
    // positive here spends a second model call. Balanced braces plus a closing token is
    // what a file that got to the end looks like.
    const looksFinished = openBraces === closeBraces && /[}\])>;]$/.test(content);

    let warning: string | null = null;
    if (block.truncated && !looksFinished) {
      warning = `File ${block.path} was cut off before its closing fence`;
    } else if (content.endsWith('<') || content.endsWith('</')) {
      warning = `File ${block.path} appears to have incomplete HTML tags`;
    } else if (isScript && Math.abs(openBraces - closeBraces) > 3) {
      warning = `File ${block.path} has severely unmatched braces (${openBraces} open, ${closeBraces} closed)`;
    } else if (
      isScript &&
      !isDeclaration &&
      !looksFinished &&
      content.length < 50 &&
      !content.includes('export')
    ) {
      // `!looksFinished` is what makes this branch safe. Without it, correct closed
      // files were flagged and then overwritten by whatever the recovery model invented
      // for them: `src/vite-env.d.ts` holding one `/// <reference …/>` line,
      // `src/setupTests.ts` holding one import, `src/types/global.d.ts` holding one
      // `declare module`. All three are under 50 chars and export nothing, and all
      // three are finished. Declaration files are exempt outright — they are
      // legitimately tiny and may end on a comment, which no closing token matches.
      warning = `File ${block.path} appears severely truncated`;
    } else if (hasEllipsis && endsAbruptly) {
      warning = `File ${block.path} ends on an ellipsis mid-statement`;
    }
    if (warning) truncated.push({ path: block.path, warning });
  }
  return truncated;
}

/** The sentence shown when recovery failed: what happened, then why. */
export function truncationRecoveryFailureMessage(error: unknown, provider?: ProviderName | null) {
  return `${TRUNCATION_INCOMPLETE_KEPT} ${providerFailureMessage(error, provider)}`;
}

/**
 * What the run should do after a recovery attempt threw: keep the files, settle incomplete,
 * and carry the classified cause so the job's `errorCode` matches the real failure rather
 * than the `no_files_generated` an empty stream would have implied.
 */
export function truncationRecoveryOutcome(
  error: unknown,
  provider?: ProviderName | null,
): TruncationRecoveryOutcome {
  return {
    keepTruncatedFiles: true,
    complete: false,
    errorCode: jobErrorCodeForProviderFailure(error),
    errorMessage: truncationRecoveryFailureMessage(error, provider),
  };
}

/**
 * Recorded on the job when detection fired and recovery is disabled.
 *
 * With recovery off, these warnings rode only the `complete` frame — which the
 * client dropped — so a cut-off build left no trace anywhere an operator looks.
 * This step is what makes it visible in /admin/jobs even though nothing was
 * re-asked.
 */
export function truncationDetectedStepError(warnings: readonly string[]): string {
  return `${TRUNCATION_INCOMPLETE_KEPT} (${warnings.join(' ')})`;
}
