import { NextResponse } from 'next/server';
import { getRequestId } from '@/lib/request-context';
import { createRequestId } from '@/lib/request-id';
import { logError } from '@/lib/logger';

export type ApiErrorBody = {
  error: {
    message: string;
    code: string;
    requestId: string;
  };
};

export function errorPayload(message: string, code: string, requestId?: string): ApiErrorBody {
  return {
    error: {
      message,
      code,
      requestId: requestId || getRequestId() || createRequestId(),
    },
  };
}

export function jsonError(message: string, code: string, status = 500, requestId?: string) {
  const body = errorPayload(message, code, requestId);
  return NextResponse.json(body, {
    status,
    headers: { 'x-request-id': body.error.requestId },
  });
}

/**
 * The generic 500. The thrown message is deliberately *not* forwarded: the
 * strings that end up here are Prisma connection failures naming the database
 * host, driver errors echoing query text and provider errors echoing our
 * request metadata (F-079). The caller gets a fixed sentence and the request
 * id; the detail goes to the log and to Sentry under the same id, which is
 * what makes the two ends joinable without shipping internals to a browser.
 */
export function fromUnknownError(
  error: unknown,
  fallback = 'Something went wrong',
  code = 'INTERNAL',
) {
  const body = errorPayload(fallback, code);
  logError('api.unhandled_error', error, { requestId: body.error.requestId, code });
  return NextResponse.json(body, {
    status: 500,
    headers: { 'x-request-id': body.error.requestId },
  });
}
