/**
 * Credential-shaped property names. This is the *union* of what this module matched
 * and what `lib/coolify/errors.ts` matched independently (F-684). Before the merge the
 * Coolify path redacted `authorization`, `auth`, `credential` and `passwd` while the
 * logger and the audit log — the two destinations retained longest — wrote them in the
 * clear, because none of those names contains `token`, `secret`, `password`, `key` or
 * `pem` as a substring. `authorization` only ever survived by accident, when its value
 * happened to begin with "Bearer " and the free-text pass caught it.
 *
 * Keep in step with `CREDENTIAL_KEY`'s intent: over-redacting a flag is the safe
 * failure, leaking a secret is not.
 */
const SENSITIVE_KEY = /token|secret|password|passwd|key|pem|authorization|credential/i;

/**
 * Bare `auth` as its own name segment — `auth`, `x-auth`, `authToken` — but not a word
 * that merely starts with it. `authorName` is a person, and redacting a whole field on
 * a three-letter substring is how a log becomes unreadable.
 */
const BARE_AUTH = /(?:^|[^a-zA-Z])auth(?![a-z])/;

function isSensitiveKey(key: string) {
  if (SENSITIVE_KEY.test(key)) return true;
  // Split camelCase so `xAuthHeader` is seen as segments, like `x_auth_header`.
  return BARE_AUTH.test(key.replace(/([a-z])([A-Z])/g, '$1_$2'));
}

const SENSITIVE_HEADERS = new Set(['authorization', 'cookie', 'set-cookie', 'x-api-key']);
const FILTERED = '[Filtered]';

function scrubQuery(value: string) {
  return value.replace(
    /(^|[?&])((?:token|secret|password|key|pem|resetToken)=)[^&]*/gi,
    `$1$2${FILTERED}`,
  );
}

/**
 * Provider-key shapes that identify a secret by its value alone, aligned with
 * `lib/secret-scan.ts` (keep the two lists in step): OpenAI/Anthropic/DeepSeek
 * `sk-`, Google `AIza`, Groq `gsk_`, GitHub token family, Firecrawl `fc-`,
 * Resend `re_`, AWS `AKIA`.
 */
const VALUE_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
  /\bgsk_[A-Za-z0-9]{20,}/g,
  /\b(?:ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)[A-Za-z0-9_]{20,}/g,
  /\bfc-[A-Za-z0-9]{20,}/g,
  /\bre_[A-Za-z0-9_]{16,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
];

/**
 * Redact secrets embedded in free text — error messages, exception values,
 * breadcrumb messages, and any string field of the event. Applies the same
 * key patterns as the structural scrub (`SENSITIVE_KEY`) to `key=value` /
 * `key: value` fragments, plus URL query params, URL userinfo credentials,
 * bearer/basic auth values, PEM blocks, and known provider-key shapes.
 */
export function redactText(value: string): string {
  let out = value.replace(
    // Like scrubQuery, but stops at whitespace so surrounding prose survives.
    /(^|[?&])((?:token|secret|password|key|pem|resetToken)=)[^&\s]*/gi,
    `$1$2${FILTERED}`,
  );
  out = out.replace(/(\/\/)[^\s/@:]+:[^\s/@]+@/g, `$1${FILTERED}@`);
  out = out.replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${FILTERED}`);
  out = out.replace(
    /\b([\w-]*(?:token|secret|password|passwd|key|pem)[\w-]*\s*[:=]\s*)["']?[^\s"'&]{4,}["']?/gi,
    `$1${FILTERED}`,
  );
  out = out.replace(
    /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END[A-Z ]*PRIVATE KEY-----|$)/g,
    FILTERED,
  );
  for (const pattern of VALUE_PATTERNS) {
    out = out.replace(pattern, FILTERED);
  }
  return out;
}

function scrubValue(key: string, value: unknown): unknown {
  if (isSensitiveKey(key)) return FILTERED;
  if (typeof value === 'string') {
    if (key === 'url' || key === 'query_string' || key === 'referrer') return scrubQuery(value);
    // Every other string gets the text redactor, so secrets survive in no
    // field just because its name is unremarkable (redirectUrl, endpoint, …).
    return redactText(value);
  }
  if (Array.isArray(value)) return value.map((item) => scrubValue(key, item));
  if (value && typeof value === 'object') return scrubObject(value as Record<string, unknown>);
  return value;
}

export function scrubSensitive(value: unknown): unknown {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map((item) => scrubValue('', item));
  if (typeof value === 'object') return scrubObject(value as Record<string, unknown>);
  return value;
}

function scrubObject(input: Record<string, unknown>): Record<string, unknown> {
  // An environment variable arrives as `{ key: 'PREVIEW_PASSWORD', value: '…' }`, so
  // the credential name is in the *sibling* `key` and the property holding the secret
  // is called `value` — a name no matcher would flag. `lib/coolify/errors.ts` carried
  // this rule alone (F-684); it belongs with the redactor, because Coolify env
  // payloads are exactly what reaches the logger and the audit log.
  const isEnvPair = typeof input.key === 'string' && 'value' in input;
  const credentialEnvPair = isEnvPair && isSensitiveKey(input.key as string);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (credentialEnvPair && key === 'value') {
      out[key] = FILTERED;
      continue;
    }
    // In this shape `key` holds a variable *name*, not a credential, so it must not be
    // redacted for being called "key" — that would turn every env pair into
    // `{ key: '[Filtered]', value: '[Filtered]' }` and lose which variable it was.
    // Still runs the free-text pass, so a name that somehow embeds a secret is caught.
    if (isEnvPair && key === 'key') {
      out[key] = redactText(value as string);
      continue;
    }
    out[key] = scrubValue(key, value);
  }
  return out;
}

function scrubHeaders(headers: Record<string, unknown> | undefined) {
  if (!headers) return headers;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = SENSITIVE_HEADERS.has(key.toLowerCase()) ? FILTERED : value;
  }
  return out;
}

export function sentryBeforeSend<T extends object>(event: T, _hint?: unknown): T {
  const next = { ...event } as T & {
    request?: Record<string, unknown>;
    extra?: Record<string, unknown>;
    contexts?: Record<string, unknown>;
    breadcrumbs?: Array<Record<string, unknown>>;
    message?: unknown;
    exception?: { values?: Array<Record<string, unknown>> };
    tags?: Record<string, unknown>;
    user?: Record<string, unknown>;
  };

  if (next.request && typeof next.request === 'object') {
    const request = { ...next.request };
    if (typeof request.url === 'string') request.url = scrubQuery(request.url);
    if (typeof request.query_string === 'string')
      request.query_string = scrubQuery(request.query_string);
    if (request.headers && typeof request.headers === 'object') {
      request.headers = scrubHeaders(request.headers as Record<string, unknown>);
    }
    if (request.data && typeof request.data === 'object') {
      request.data = scrubObject(request.data as Record<string, unknown>);
    }
    if (request.cookies) request.cookies = FILTERED;
    next.request = request;
  }

  if (next.extra && typeof next.extra === 'object') {
    next.extra = scrubObject(next.extra as Record<string, unknown>);
  }
  if (next.contexts && typeof next.contexts === 'object') {
    next.contexts = scrubObject(next.contexts as Record<string, unknown>);
  }
  if (typeof next.message === 'string') {
    next.message = redactText(next.message);
  } else if (next.message && typeof next.message === 'object') {
    // Sentry's structured message ({ formatted, message, params }).
    next.message = scrubObject(next.message as Record<string, unknown>);
  }
  if (next.exception && Array.isArray(next.exception.values)) {
    next.exception = {
      ...next.exception,
      values: next.exception.values.map((item) =>
        typeof item.value === 'string' ? { ...item, value: redactText(item.value) } : item,
      ),
    };
  }
  if (next.tags && typeof next.tags === 'object') {
    next.tags = scrubObject(next.tags);
  }
  if (next.user && typeof next.user === 'object') {
    next.user = scrubObject(next.user);
  }
  if (Array.isArray(next.breadcrumbs)) {
    next.breadcrumbs = next.breadcrumbs.map((crumb) => {
      const data =
        crumb.data && typeof crumb.data === 'object'
          ? scrubObject(crumb.data as Record<string, unknown>)
          : crumb.data;
      const url =
        typeof crumb.data === 'object' && crumb.data && 'url' in crumb.data
          ? scrubQuery(String((crumb.data as { url?: string }).url || ''))
          : undefined;
      const message = typeof crumb.message === 'string' ? redactText(crumb.message) : crumb.message;
      return { ...crumb, message, data: url ? { ...(data as object), url } : data };
    });
  }

  return next;
}
