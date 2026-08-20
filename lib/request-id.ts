import { nanoid } from 'nanoid';

export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * A correlation id is only useful if it cannot be forged into something else.
 * This id is echoed in a response header, written into every structured log
 * line, tagged onto Sentry events and persisted as `AuditLog.requestId`, so an
 * inbound value containing a newline, a CR or an ANSI escape could forge log
 * records and split headers (F-758). `nanoid`'s own alphabet is exactly this
 * set, so a propagated id keeps its identity across hops while anything else
 * is replaced rather than sanitised — a rewritten id would silently claim to
 * be the caller's.
 */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export function createRequestId() {
  return nanoid(12);
}

export function readRequestId(headers: { get(name: string): string | null }) {
  const existing = headers.get(REQUEST_ID_HEADER)?.trim();
  if (existing && REQUEST_ID_PATTERN.test(existing)) return existing;
  return createRequestId();
}
