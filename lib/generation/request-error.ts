/**
 * What the client should say when the generation request is refused before the stream
 * starts.
 *
 * The route's contract is `text/event-stream`, but its pre-stream refusals answer JSON —
 * 401 "Sign in required", 400 "Prompt is required", 503 `PROVIDER_NOT_CONFIGURED`, 429
 * `QUEUE_TIMEOUT`, 500 `GENERATION_FAILED`. The client threw
 * `HTTP error! status: ${response.status}` for all of them, so the single most
 * operator-actionable sentence in the product ("DeepSeek is not configured — add an API key
 * in Admin → Configuration") reached chat as "Error: HTTP error! status: 503" (F-008).
 *
 * Two body shapes are in play and both are read here: `errorPayload`'s
 * `{ error: { message, code, requestId } }` and the route's plain
 * `{ success: false, error: 'text' }`. `useGenerationJob.act` already reads both; this is
 * that logic in one testable place.
 */
export function generationRequestErrorMessage(status: number, body: unknown): string {
  const fallback = `The build could not be started (HTTP ${status}).`;
  if (!body || typeof body !== 'object') return fallback;
  if ('error' in body) {
    const { error } = body;
    if (typeof error === 'string' && error.trim()) return error.trim();
    if (error && typeof error === 'object' && 'message' in error) {
      const nested = error.message;
      if (typeof nested === 'string' && nested.trim()) return nested.trim();
    }
  }
  if ('message' in body && typeof body.message === 'string' && body.message.trim()) {
    return body.message.trim();
  }
  return fallback;
}
