export class CoolifyApiError extends Error {
  status: number;
  body: unknown;
  path: string;

  constructor(message: string, status: number, body: unknown, path: string) {
    super(message);
    this.name = 'CoolifyApiError';
    this.status = status;
    this.body = body;
    this.path = path;
  }
}

// A user reads `CoolifyApiError.message` (it flows to Job.errorMessage -> Deployment.lastError
// -> the publish sheet and /deployments), so a provider sentence has to be short and single-lined.
const MAX_MESSAGE_LENGTH = 300;

function cleanSentence(value: string): string | null {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (!collapsed) return null;
  return collapsed.length > MAX_MESSAGE_LENGTH
    ? `${collapsed.slice(0, MAX_MESSAGE_LENGTH - 1)}…`
    : collapsed;
}

/**
 * Turn a Coolify error body into one sentence a user may read — never the body itself.
 *
 * Only the provider's own string-valued `message`/`error`/`errors[0]` is kept; anything
 * else returns `fallback`, which already names the status and the path. The old
 * `JSON.stringify(body)` fallback (F-229) is gone: a validation error can echo the
 * submitted application payload, which carries `PREVIEW_PASSWORD` and basic-auth
 * credentials, and stringifying it put those into a user-facing string and the audit
 * trail. The structured body stays on `CoolifyApiError.body` for server-side logs; scrub
 * it with `scrubSensitive` (`lib/sentry/scrub.ts`) before it leaves the client. This
 * module used to carry a second redactor of its own; F-684 folded its two extra rules
 * into the shared one so all four destinations share a single pattern list.
 */
export function coolifyErrorMessage(body: unknown, fallback: string) {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const row = body as { message?: unknown; error?: unknown; errors?: unknown };
    if (typeof row.message === 'string') {
      const message = cleanSentence(row.message);
      if (message) return message;
    }
    if (typeof row.error === 'string') {
      const error = cleanSentence(row.error);
      if (error) return error;
    }
    if (Array.isArray(row.errors) && typeof row.errors[0] === 'string') {
      const first = cleanSentence(row.errors[0]);
      if (first) return first;
    }
  }
  return fallback;
}
