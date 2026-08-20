import { providerDisplayName, type ProviderName } from './providers';

export class EmptyCompletionError extends Error {
  readonly code = 'empty_completion' as const;
  readonly provider: ProviderName;
  readonly model: string;

  constructor(provider: ProviderName, model: string) {
    super(`${providerDisplayName(provider)} finished without producing any files`);
    this.name = 'EmptyCompletionError';
    this.provider = provider;
    this.model = model;
  }
}

/**
 * The provider accepted the request and then stopped sending.
 *
 * Lives beside `EmptyCompletionError` — the other "the stream did not deliver" verdict —
 * so `failover.ts` can classify it without importing `run.ts`, which imports `failover.ts`.
 * See `STREAM_IDLE_TIMEOUT_MS` in `run.ts` for the bound that raises it (F-030).
 */
export class StreamStalledError extends Error {
  readonly provider: ProviderName;
  readonly idleMs: number;

  constructor(provider: ProviderName, idleMs: number) {
    super(`The AI stopped sending output for ${Math.round(idleMs / 1000)}s — the stream stalled.`);
    this.name = 'StreamStalledError';
    this.provider = provider;
    this.idleMs = idleMs;
  }
}

export type StreamFailureSource = {
  text?: PromiseLike<string>;
  streamError?: unknown;
};

/**
 * `streamText().textStream` drops error parts. The SDK's default `onError`
 * only console.errors them. Capture that rejection here so an empty stream
 * is not mistaken for a model that had nothing to say.
 */
export function bindStreamErrorCapture() {
  let streamError: unknown;
  return {
    onError({ error }: { error: unknown }) {
      streamError = error;
      console.error(error);
    },
    attach<T extends object>(result: T): T & StreamFailureSource {
      // `Object.assign` would read the getter once and copy the value it returned, pinning
      // `streamError` to the `undefined` it holds before the stream has run. The property
      // has to stay a getter on the result, so define it rather than assign it.
      Object.defineProperty(result, 'streamError', {
        get: () => streamError,
        enumerable: true,
        configurable: true,
      });
      return result as T & StreamFailureSource;
    },
  };
}

export async function surfaceStreamFailure(result: StreamFailureSource | null | undefined) {
  if (result?.streamError != null) return result.streamError;
  if (!result?.text) return null;
  try {
    await result.text;
    return null;
  } catch (error) {
    return error;
  }
}
