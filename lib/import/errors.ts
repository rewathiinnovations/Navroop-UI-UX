export const BLOCKED_ACCESS_MESSAGE =
  "This site blocked automated access — try pasting the page's content directly instead";

const BLOCKED_PATTERN =
  /403|401|430|451|blocked|access denied|captcha|cloudflare|attention required|just a moment|please log in|sign in to continue|login to continue|unauthorized|forbidden|timeout|timed out|net::err_|err_http_response|err_too_many_redirects|err_connection/i;

export function isBlockedAccessError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return BLOCKED_PATTERN.test(message);
}

export function toBlockedAccessError(error: unknown) {
  if (isBlockedAccessError(error)) {
    return new Error(BLOCKED_ACCESS_MESSAGE);
  }
  return error instanceof Error ? error : new Error(String(error ?? 'Import failed'));
}
