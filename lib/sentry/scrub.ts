const SENSITIVE_KEY = /token|secret|password|key|pem/i;
const SENSITIVE_HEADERS = new Set(['authorization', 'cookie', 'set-cookie', 'x-api-key']);
const FILTERED = '[Filtered]';

function scrubQuery(value: string) {
  return value.replace(
    /(^|[?&])((?:token|secret|password|key|pem|resetToken)=)[^&]*/gi,
    `$1$2${FILTERED}`,
  );
}

function scrubValue(key: string, value: unknown): unknown {
  if (SENSITIVE_KEY.test(key)) return FILTERED;
  if (typeof value === 'string') {
    if (key === 'url' || key === 'query_string' || key === 'referrer') return scrubQuery(value);
    return value;
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
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
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
  };

  if (next.request && typeof next.request === 'object') {
    const request = { ...next.request };
    if (typeof request.url === 'string') request.url = scrubQuery(request.url);
    if (typeof request.query_string === 'string') request.query_string = scrubQuery(request.query_string);
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
  if (Array.isArray(next.breadcrumbs)) {
    next.breadcrumbs = next.breadcrumbs.map((crumb) => {
      const data = crumb.data && typeof crumb.data === 'object' ? scrubObject(crumb.data as Record<string, unknown>) : crumb.data;
      const url = typeof crumb.data === 'object' && crumb.data && 'url' in crumb.data
        ? scrubQuery(String((crumb.data as { url?: string }).url || ''))
        : undefined;
      return { ...crumb, data: url ? { ...(data as object), url } : data };
    });
  }

  return next;
}
