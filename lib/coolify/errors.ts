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

export function coolifyErrorMessage(body: unknown, fallback: string) {
  if (!body) return fallback;
  if (typeof body === 'string' && body.trim()) return body;
  if (typeof body === 'object') {
    const row = body as { message?: unknown; error?: unknown; errors?: unknown };
    if (typeof row.message === 'string' && row.message.trim()) return row.message;
    if (typeof row.error === 'string' && row.error.trim()) return row.error;
    if (Array.isArray(row.errors) && typeof row.errors[0] === 'string') return row.errors[0];
  }
  try {
    return JSON.stringify(body);
  } catch {
    return fallback;
  }
}
