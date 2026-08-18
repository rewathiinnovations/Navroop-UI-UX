import { EmptyCompletionError } from './empty-completion';
import { ProviderNotConfiguredError, providerDisplayName, type ProviderName } from './providers';

export type ProviderFailureKind =
  | 'auth'
  | 'not_found'
  | 'quota'
  | 'unavailable'
  | 'content_policy'
  | 'context_length'
  | 'malformed';

/** Matches GitHub / Coolify / Cloudflare client timeouts in this repo — long enough to connect, short enough that a stall does not hold the user for minutes. */
export const PROVIDER_ATTEMPT_TIMEOUT_MS = 30_000;

function statusOf(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const row = error as {
    status?: unknown;
    statusCode?: unknown;
    causeError?: unknown;
    cause?: unknown;
    error?: { code?: unknown };
  };
  if (typeof row.status === 'number') return row.status;
  if (typeof row.statusCode === 'number') return row.statusCode;
  if (typeof row.error?.code === 'number') return row.error.code;
  if (row.causeError != null && row.causeError !== error) return statusOf(row.causeError);
  if (row.cause != null && row.cause !== error) return statusOf(row.cause);
  return null;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object') {
    const row = error as { message?: unknown; error?: { message?: unknown; status?: unknown } };
    if (typeof row.message === 'string' && row.message) return row.message;
    if (typeof row.error?.message === 'string') return row.error.message;
    if (typeof row.error?.status === 'string') return row.error.status;
  }
  return String(error ?? '');
}

export function isRateLimitError(error: unknown) {
  const status = statusOf(error);
  const message = messageOf(error).toLowerCase();
  return (
    status === 429 ||
    message.includes('rate limit') ||
    message.includes('too many requests') ||
    message.includes('resource_exhausted') ||
    message.includes('quota') ||
    message.includes('free_tier')
  );
}

function isContentPolicy(message: string) {
  return (
    message.includes('content filter') ||
    message.includes('content_filter') ||
    (message.includes('safety') && message.includes('block')) ||
    message.includes('responsibleai')
  );
}

function isContextOverflow(message: string) {
  return (
    message.includes('context length') ||
    message.includes('context_length') ||
    message.includes('maximum context') ||
    message.includes('context window')
  );
}

function isUnavailableMessage(message: string) {
  return /econnrefused|econnreset|etimedout|enotfound|socket hang up|network|fetch failed|connect e|timed out|timeout|aborted|deadline/.test(
    message,
  );
}

function isCredentialRejection(message: string) {
  return (
    message.includes('unregistered caller') ||
    message.includes('api consumer identity') ||
    message.includes('established identity') ||
    message.includes('invalid api key') ||
    message.includes('incorrect api key') ||
    message.includes('api key not valid') ||
    message.includes('permission_denied') ||
    message.includes('unauthenticated')
  );
}

function namedProviderOf(error: unknown, explicit?: ProviderName | null): ProviderName | null {
  if (explicit) return explicit;
  if (error && typeof error === 'object' && 'provider' in error) {
    const value = (error as { provider?: unknown }).provider;
    if (value === 'google' || value === 'openai' || value === 'anthropic' || value === 'groq') {
      return value;
    }
  }
  return null;
}

export function classifyProviderFailure(error: unknown): ProviderFailureKind {
  const status = statusOf(error);
  const message = messageOf(error).toLowerCase();

  if (isContentPolicy(message)) return 'content_policy';
  if (isContextOverflow(message)) return 'context_length';
  if (isRateLimitError(error)) return 'quota';
  if (isCredentialRejection(message)) return 'auth';
  if (status === 401) return 'auth';
  if (status === 404) return 'not_found';
  if (status === 403) return 'auth';
  if (status === 529 || (status != null && status >= 500)) return 'unavailable';
  if (isUnavailableMessage(message)) return 'unavailable';
  if (status != null && status >= 400 && status < 500) return 'malformed';
  return 'unavailable';
}

export function shouldFailover(error: unknown) {
  if (error instanceof EmptyCompletionError) return true;
  const kind = classifyProviderFailure(error);
  return kind === 'auth' || kind === 'not_found' || kind === 'quota' || kind === 'unavailable';
}

export function jobErrorCodeForProviderFailure(error: unknown) {
  if (error instanceof ProviderNotConfiguredError) return 'provider_not_configured' as const;
  if (error instanceof EmptyCompletionError) return 'no_files_generated' as const;
  const kind = classifyProviderFailure(error);
  if (kind === 'quota') return 'provider_quota_exhausted' as const;
  if (kind === 'content_policy' || kind === 'context_length' || kind === 'malformed') {
    return 'request_rejected' as const;
  }
  if (kind === 'auth' || kind === 'not_found') return 'provider_not_configured' as const;
  return 'provider_error' as const;
}

export function providerFailureMessage(error: unknown, provider?: ProviderName | null) {
  if (error instanceof ProviderNotConfiguredError) return error.message;
  const kind = classifyProviderFailure(error);
  if (kind === 'quota') {
    const limit = messageOf(error).match(/generate_content_[\w]+/i)?.[0];
    return limit
      ? `The AI provider is out of quota (${limit}) — try again later, or add a different provider key on the server.`
      : 'The AI provider is out of quota — try again later, or add a different provider key on the server.';
  }
  if (kind === 'content_policy') {
    return 'The AI refused this request because of its content policy — try a different prompt.';
  }
  if (kind === 'context_length') {
    return 'This request is too large for the AI — try a shorter prompt or fewer files.';
  }
  if (kind === 'malformed') {
    return 'The AI could not accept this request — try a shorter or clearer prompt.';
  }
  if (kind === 'auth' || kind === 'not_found') {
    const vendor = namedProviderOf(error, provider ?? null);
    if (vendor) {
      const name = providerDisplayName(vendor);
      return `${name} rejected the API key. Ask an administrator to check the ${name} key, then try again.`;
    }
    return 'The AI provider rejected the API key. Ask an administrator to set or fix GEMINI_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, or GROQ_API_KEY, then try again.';
  }
  const detail = messageOf(error).trim();
  return detail || 'The AI service is down — try again in a few minutes.';
}

export function retryAfterMs(error: unknown, attempt = 0) {
  if (!error || typeof error !== 'object') {
    return backoffMs(attempt);
  }
  const headers = (error as { headers?: { get?: (name: string) => string | null; 'retry-after'?: string } })
    .headers;
  const raw =
    typeof headers?.get === 'function'
      ? headers.get('retry-after')
      : headers && 'retry-after' in headers
        ? headers['retry-after']
        : (error as { retryAfter?: string | number }).retryAfter;
  const seconds = typeof raw === 'number' ? raw : Number.parseFloat(String(raw ?? ''));
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(60_000, Math.max(0, seconds * 1000));
  }
  return backoffMs(attempt);
}

export function backoffMs(attempt: number, jitter = Math.random()) {
  const base = Math.min(60_000, 1000 * 2 ** Math.max(0, attempt));
  return Math.min(60_000, Math.round(base * (0.5 + jitter * 0.5)));
}
