import { NextResponse } from 'next/server';
import { getRequestId } from '@/lib/request-context';
import { createRequestId } from '@/lib/request-id';

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

export function fromUnknownError(error: unknown, fallback = 'Something went wrong', code = 'INTERNAL') {
  const message = error instanceof Error && error.message ? error.message : fallback;
  return jsonError(message, code, 500);
}
