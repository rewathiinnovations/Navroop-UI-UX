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
