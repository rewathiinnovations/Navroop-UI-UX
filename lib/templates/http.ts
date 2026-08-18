import { jsonError } from '@/lib/api/error-response';

export function templateActionError(
  result: { error?: string | null; status?: number; details?: unknown } | null,
) {
  const status = result?.status ?? 500;
  const message = result?.error || 'Request failed';
  const code =
    status === 401
      ? 'UNAUTHORIZED'
      : status === 403
        ? 'FORBIDDEN'
        : status === 404
          ? 'NOT_FOUND'
          : status === 402
            ? 'LIMIT'
            : status === 400
              ? 'VALIDATION'
              : 'TEMPLATE';
  return jsonError(message, code, status);
}
