/**
 * Structured JSON logger for server code.
 * New server routes and instrumented flows should use `log` / `logError` instead of console.*.
 * Do not replace every existing console.log in the repo — only the flows you touch.
 */
import { getRequestContext } from './request-context';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogFields = Record<string, unknown> & {
  durationMs?: number;
  userId?: string;
  workspaceId?: string;
  requestId?: string;
};

export function formatLogLine(level: LogLevel, event: string, fields: LogFields = {}) {
  const ctx = getRequestContext();
  const line = {
    timestamp: new Date().toISOString(),
    level,
    event,
    requestId: fields.requestId ?? ctx?.requestId,
    userId: fields.userId ?? ctx?.userId,
    workspaceId: fields.workspaceId ?? ctx?.workspaceId,
    ...omitUndefined(fields, ['requestId', 'userId', 'workspaceId']),
  };
  return JSON.stringify(line);
}

function omitUndefined(fields: LogFields, keys: string[]) {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (keys.includes(key)) continue;
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function write(level: LogLevel, event: string, fields?: LogFields) {
  const line = formatLogLine(level, event, fields);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const log = {
  debug: (event: string, fields?: LogFields) => write('debug', event, fields),
  info: (event: string, fields?: LogFields) => write('info', event, fields),
  warn: (event: string, fields?: LogFields) => write('warn', event, fields),
  error: (event: string, fields?: LogFields) => write('error', event, fields),
};

export function logError(event: string, error: unknown, fields?: LogFields) {
  const message = error instanceof Error ? error.message : String(error);
  write('error', event, { ...fields, error: message });
}
