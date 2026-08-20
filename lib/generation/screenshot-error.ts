/**
 * The sentence the workspace shows when a URL screenshot capture fails.
 *
 * `captureUrlScreenshot` used to call `response.json()` unconditionally, so a
 * screenshot endpoint that answered with an HTML error page threw a SyntaxError
 * and landed in the network catch: the user was told the network failed when the
 * server had errored, and retried instead of reporting it (F-057).
 *
 * Three outcomes, three sentences: the server's own message when it sent one, the
 * status when it sent something unreadable, and the network line only when the
 * request never completed.
 */

export const SCREENSHOT_NETWORK_ERROR = 'Network error while capturing screenshot';

/** No status to name and no body to read — the endpoint said nothing usable. */
const SCREENSHOT_UNKNOWN_ERROR = 'Failed to capture screenshot';

export function screenshotErrorMessage(input: {
  /** HTTP status, or null when `fetch` itself rejected. */
  status: number | null;
  /** The parsed JSON body, or null when it was absent or unparseable. */
  body: unknown;
}): string {
  if (input.status === null) return SCREENSHOT_NETWORK_ERROR;
  if (input.body && typeof input.body === 'object' && 'error' in input.body) {
    const reported = input.body.error;
    if (typeof reported === 'string' && reported.trim()) return reported.trim();
  }
  // A status with no readable body: name it rather than blaming the connection.
  // "Failed to capture screenshot (500)" is the difference between "retry" and
  // "tell someone".
  if (input.status >= 400) return `${SCREENSHOT_UNKNOWN_ERROR} (${input.status})`;
  return SCREENSHOT_UNKNOWN_ERROR;
}
