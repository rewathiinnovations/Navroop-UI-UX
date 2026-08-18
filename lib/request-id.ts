import { nanoid } from 'nanoid';

export const REQUEST_ID_HEADER = 'x-request-id';

export function createRequestId() {
  return nanoid(12);
}

export function readRequestId(headers: { get(name: string): string | null }) {
  const existing = headers.get(REQUEST_ID_HEADER)?.trim();
  if (existing && existing.length <= 64) return existing;
  return createRequestId();
}
