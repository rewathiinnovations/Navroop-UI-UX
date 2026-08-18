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
 */
export async function collectRecoveredStreamText(
  result: StreamFailureSource & { textStream?: AsyncIterable<string> },
): Promise<string> {
  let text = '';
  for await (const chunk of result.textStream ?? []) {
    text += chunk ?? '';
  }
  const failure = await surfaceStreamFailure(result);
  if (failure != null) throw failure;
  return text;
}

/** The sentence shown when recovery failed: what happened, then why. */
export function truncationRecoveryFailureMessage(
  error: unknown,
  provider?: ProviderName | null,
) {
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
