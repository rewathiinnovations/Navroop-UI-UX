import { isKnownJobErrorCode } from './copy';
import type { JobErrorCode } from './types';

/**
 * The code to file a thrown error under when the thrower did not classify it.
 *
 * `withRecordedJob` used to write `errorCode: 'provider_error'` for whatever threw, for
 * every kind that goes through it — EXPORT, DOMAIN_VERIFY, TEMPLATE_THUMBNAIL and the audit
 * bookkeeping kinds. `/admin/jobs` groups by `errorCode`, so a ZIP export that failed on
 * object storage and a domain check that failed on Cloudflare were both filed under the AI
 * provider, under the line "The AI service did not respond": an operator diagnosing a
 * storage outage was pointed at DeepSeek (F-047).
 *
 * No list of codes here on purpose. Two rules only:
 * - an error that already decided its own code (JobCapError and anything else carrying an
 *   `errorCode`) keeps it, so the specific verdict is not overwritten by a generic one;
 * - everything else is `internal_error` — the neutral member the union was missing.
 *
 * Callers that *do* talk to a provider should classify with
 * `jobErrorCodeForProviderFailure` and pass the result, rather than having this guess.
 */
export function jobErrorCodeFromError(error: unknown): JobErrorCode {
  if (error && typeof error === 'object' && 'errorCode' in error) {
    const carried = error.errorCode;
    if (typeof carried === 'string' && isKnownJobErrorCode(carried)) return carried;
  }
  return 'internal_error';
}
