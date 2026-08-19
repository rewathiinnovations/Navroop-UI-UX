import { ProviderNotConfiguredError } from '../ai/providers.ts';
import { IMPORT_NO_FILES_MESSAGE } from './copy.ts';
import type { JobErrorCode } from '../jobs/types.ts';
import { URL_GUARD_MESSAGES } from '../security/url-guard-messages.ts';
import { UnsafeUrlError } from '../security/url-guard.ts';
import { BLOCKED_ACCESS_MESSAGE } from './error-messages.ts';

export { BLOCKED_ACCESS_MESSAGE };

const URL_GUARD_SENTENCES = new Set<string>(Object.values(URL_GUARD_MESSAGES));

/**
 * Hard import failures are not AI-provider failures. One code covers capture
 * abort, SSRF, a login wall, and an empty filesXml — the specific English is
 * already on the job's errorMessage and in chat.
 */
export function importJobErrorCode(error: unknown): JobErrorCode {
  if (error instanceof UnsafeUrlError) return 'import_failed';
  // A missing key is not an outage. `provider_error` would tell the operator
  // to wait for DeepSeek to recover, when what they have to do is put the key
  // where the sectioning pass can read it.
  if (error instanceof ProviderNotConfiguredError) return 'provider_not_configured';
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (
    message === BLOCKED_ACCESS_MESSAGE ||
    message === IMPORT_NO_FILES_MESSAGE ||
    URL_GUARD_SENTENCES.has(message)
  ) {
    return 'import_failed';
  }
  return 'provider_error';
}

const BLOCKED_PATTERN =
  /403|401|430|451|blocked|access denied|captcha|cloudflare|attention required|just a moment|please log in|sign in to continue|login to continue|unauthorized|forbidden|timeout|timed out|net::err_|err_http_response|err_too_many_redirects|err_connection/i;

export function isBlockedAccessError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return BLOCKED_PATTERN.test(message);
}

export function toBlockedAccessError(error: unknown) {
  if (error instanceof Error && error.name === 'UnsafeUrlError') {
    return error;
  }
  if (isBlockedAccessError(error)) {
    return new Error(BLOCKED_ACCESS_MESSAGE);
  }
  return error instanceof Error ? error : new Error(String(error ?? 'Import failed'));
}
