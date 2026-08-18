export type HttpLikeError = { status?: number; message?: string };

export function isRetryableProviderError(error: unknown) {
  if (!error) return false;
  if (typeof error === 'object' && 'status' in error) {
    const status = Number((error as HttpLikeError).status);
    if (Number.isFinite(status) && status >= 400 && status < 500) return false;
    if (Number.isFinite(status) && status >= 500) return true;
  }
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return (
      message.includes('econnreset') ||
      message.includes('etimedout') ||
      message.includes('econnrefused') ||
      message.includes('network') ||
      message.includes('fetch failed') ||
      message.includes('socket')
    );
  }
  return false;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One retry on network errors and 5xx, 2 second backoff.
 * Never retry 4xx. Callers must not wrap a step that already recorded a resource id.
 */
export async function withProviderRetry<T>(
  fn: () => Promise<T>,
  opts?: { sleep?: (ms: number) => Promise<void>; backoffMs?: number },
): Promise<T> {
  const wait = opts?.sleep ?? sleep;
  const backoffMs = opts?.backoffMs ?? 2_000;
  try {
    return await fn();
  } catch (error) {
    if (!isRetryableProviderError(error)) throw error;
    await wait(backoffMs);
    return fn();
  }
}
