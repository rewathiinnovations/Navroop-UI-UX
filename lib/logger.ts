/**
 * Structured JSON logger for server code.
 * New server routes and instrumented flows should use `log` / `logError` instead of console.*.
 * Do not replace every existing console.log in the repo — only the flows you touch.
 *
 * Caller fields are redacted with the same `lib/sentry/scrub` pass Sentry and the audit
 * log use (F-633): three destinations, one pattern list. Application logs are collected
 * and retained by the host, so a token in a log line outlives the request that leaked it.
 */
import * as Sentry from '@sentry/nextjs';
import { shouldCaptureException } from './observability/noise';
import { getRequestContext } from './request-context';
import { scrubSensitive } from './sentry/scrub';

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
    // Only the caller's fields are scrubbed: the ids above are generated, and the
    // timestamp/level/event are structural.
    ...(scrubSensitive(omitUndefined(fields, ['requestId', 'userId', 'workspaceId'])) as Record<
      string,
      unknown
    >),
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

/**
 * Ordered so a threshold is a comparison, not a lookup chain.
 */
const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Read once, from the environment, at module load (F-792).
 *
 * Deliberately **not** a `lib/settings/registry.ts` entry, unlike the other operator knobs
 * this engagement moved there. `write` is synchronous and is called from module
 * initialisation, from `instrumentation.ts` and from paths that have no request context; a
 * registry read is an `await` against Postgres, and a cached copy would be per-instance —
 * which is exactly the kind of setting that appears to apply and does not. An unparseable or
 * absent value keeps the previous behaviour (`debug` and up) in development and drops `debug`
 * in production, so nothing an operator has today gets quieter without them asking.
 *
 * Runtime, not build-time: restart the process to change it, no rebuild.
 */
function resolveLogLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? '').trim().toLowerCase();
  if (raw in LEVEL_RANK) return raw as LogLevel;
  return process.env.NODE_ENV === 'production' ? 'info' : 'debug';
}

const MIN_LEVEL_RANK = LEVEL_RANK[resolveLogLevel()];

/**
 * Whether a level would be written. Exported so a caller can skip *building* an expensive
 * field set for a line that is about to be discarded.
 */
export function logLevelEnabled(level: LogLevel) {
  return LEVEL_RANK[level] >= MIN_LEVEL_RANK;
}

function write(level: LogLevel, event: string, fields?: LogFields) {
  if (LEVEL_RANK[level] < MIN_LEVEL_RANK) return;
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

/**
 * Fields describing a thrown value. The stack is what makes a one-line log entry
 * diagnosable; before F-735 this kept `message` and dropped everything else, so finding
 * the call site meant grepping stdout for a string.
 */
export function describeError(error: unknown): LogFields {
  if (!(error instanceof Error)) return { error: String(error) };
  const cause = error.cause;
  return {
    error: error.message,
    errorName: error.name,
    stack: error.stack,
    cause:
      cause === undefined || cause === null
        ? undefined
        : cause instanceof Error
          ? cause.message
          : String(cause),
  };
}

export type LogErrorOptions = {
  /**
   * `false` when the caller has already reported this error to Sentry, or has decided
   * not to. Everything else is captured: `logError` is the repo's designated error
   * logger, and an error the tracker never sees is an error nobody sees (F-735).
   */
  capture?: boolean;
  tags?: Record<string, string | undefined>;
  extra?: Record<string, unknown>;
  captureException?: typeof Sentry.captureException;
};

export function logError(
  event: string,
  error: unknown,
  fields?: LogFields,
  options: LogErrorOptions = {},
) {
  write('error', event, { ...fields, ...describeError(error) });
  if (options.capture === false) return;
  // The same noise filter the SDK's beforeSend applies, checked here so an aborted
  // fetch or an extension error does not become a Sentry issue via this road either.
  if (!shouldCaptureException(error)) return;
  const capture = options.captureException ?? Sentry.captureException;
  capture(error, {
    tags: options.tags,
    extra: options.extra ?? (fields as Record<string, unknown> | undefined),
  });
}
