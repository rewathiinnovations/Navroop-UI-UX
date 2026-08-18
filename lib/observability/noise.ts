import { sentryBeforeSend } from '../sentry/scrub';

const WINDOW_MS = 5 * 60 * 1000;
const MAX_PER_WINDOW = 10;
const DROP_STATUSES = new Set([402, 404, 409]);

type ImmediateNoiseSettings = {
  ignoreList: string[];
  fingerprintLimit: number;
  fingerprintWindowMs: number;
};

let immediate: ImmediateNoiseSettings | null = null;

export function applyImmediateNoiseSettings(input: {
  ignoreList?: string[];
  fingerprintLimit?: number;
  fingerprintWindowSec?: number;
}) {
  const current = getNoiseSettings();
  immediate = {
    ignoreList: input.ignoreList ?? current.ignoreList,
    fingerprintLimit: input.fingerprintLimit ?? current.fingerprintLimit,
    fingerprintWindowMs:
      input.fingerprintWindowSec != null ? input.fingerprintWindowSec * 1000 : current.fingerprintWindowMs,
  };
}

export function resetImmediateNoiseSettings() {
  immediate = null;
}

function getNoiseSettings(): ImmediateNoiseSettings {
  if (immediate) return immediate;
  return {
    ignoreList: [],
    fingerprintLimit: MAX_PER_WINDOW,
    fingerprintWindowMs: WINDOW_MS,
  };
}

type Bucket = { times: number[]; suppressed: number };

const buckets = new Map<string, Bucket>();

export function clearNoiseBuckets() {
  buckets.clear();
}

function statusOf(value: unknown): number | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as { status?: unknown; statusCode?: unknown };
  if (typeof record.status === 'number') return record.status;
  if (typeof record.statusCode === 'number') return record.statusCode;
  return undefined;
}

export function shouldCaptureException(error: unknown): boolean {
  const status = statusOf(error);
  if (status !== undefined && DROP_STATUSES.has(status)) return false;
  return !isIgnoredError(error);
}

function isIgnoredError(error: unknown) {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const name = error instanceof Error ? error.name : '';
  const haystack = `${name} ${message}`.toLowerCase();
  if (name === 'AbortError' || haystack.includes('aborted') || haystack.includes('the operation was aborted')) {
    return true;
  }
  if (
    haystack.includes('failed to fetch') ||
    haystack.includes('networkerror') ||
    haystack.includes('load failed') ||
    haystack.includes('net::err_')
  ) {
    return true;
  }
  if (
    haystack.includes('chrome-extension://') ||
    haystack.includes('moz-extension://') ||
    haystack.includes('safari-extension://')
  ) {
    return true;
  }
  const extra = getNoiseSettings().ignoreList;
  return extra.some((pattern) => pattern.trim() && haystack.includes(pattern.trim().toLowerCase()));
}

function eventStatus(event: Record<string, unknown>, hint?: unknown): number | undefined {
  const extra = event.extra && typeof event.extra === 'object' ? (event.extra as Record<string, unknown>) : undefined;
  const fromExtra = extra ? statusOf(extra) : undefined;
  if (fromExtra !== undefined) return fromExtra;
  const contexts = event.contexts && typeof event.contexts === 'object' ? (event.contexts as Record<string, unknown>) : undefined;
  const response = contexts?.response && typeof contexts.response === 'object' ? (contexts.response as Record<string, unknown>) : undefined;
  if (typeof response?.status_code === 'number') return response.status_code;
  const hintObj = hint && typeof hint === 'object' ? (hint as { originalException?: unknown }) : undefined;
  return statusOf(hintObj?.originalException);
}

function eventFingerprint(event: Record<string, unknown>) {
  if (Array.isArray(event.fingerprint) && event.fingerprint.length > 0) {
    return event.fingerprint.map(String).join('\0');
  }
  const exception = event.exception && typeof event.exception === 'object' ? (event.exception as { values?: Array<{ type?: string; value?: string }> }) : undefined;
  const first = exception?.values?.[0];
  if (first?.type || first?.value) return `${first.type || 'Error'}:${first.value || ''}`;
  if (typeof event.message === 'string' && event.message) return event.message;
  return 'unknown';
}

function eventMessageIgnored(event: Record<string, unknown>) {
  const exception = event.exception && typeof event.exception === 'object' ? (event.exception as { values?: Array<{ type?: string; value?: string }> }) : undefined;
  const first = exception?.values?.[0];
  const haystack = `${first?.type || ''} ${first?.value || ''} ${typeof event.message === 'string' ? event.message : ''}`.toLowerCase();
  return getNoiseSettings().ignoreList.some((pattern) => pattern.trim() && haystack.includes(pattern.trim().toLowerCase()));
}

function eventLooksLikeExtensionNoise(event: Record<string, unknown>) {
  const request = event.request && typeof event.request === 'object' ? (event.request as { url?: unknown }) : undefined;
  const url = typeof request?.url === 'string' ? request.url : '';
  return /^(chrome|moz|safari)-extension:\/\//i.test(url);
}

function eventLooksLikeBot404(event: Record<string, unknown>, status?: number) {
  if (status !== 404) return false;
  const request = event.request && typeof event.request === 'object' ? (event.request as { headers?: Record<string, unknown> }) : undefined;
  const ua = String(request?.headers?.['user-agent'] || request?.headers?.['User-Agent'] || '').toLowerCase();
  return /bot|crawler|spider|preview/i.test(ua);
}

export function observabilityBeforeSend<T extends object>(event: T, hint?: unknown, now = Date.now()): T | null {
  const record = event as T & Record<string, unknown>;
  const status = eventStatus(record, hint);
  if (status !== undefined && DROP_STATUSES.has(status)) return null;

  const hintObj = hint && typeof hint === 'object' ? (hint as { originalException?: unknown }) : undefined;
  if (hintObj?.originalException && !shouldCaptureException(hintObj.originalException)) return null;
  if (eventMessageIgnored(record)) return null;
  if (eventLooksLikeExtensionNoise(record)) return null;
  if (eventLooksLikeBot404(record, status)) return null;

  const settings = getNoiseSettings();
  const fingerprint = eventFingerprint(record);
  const bucket = buckets.get(fingerprint) ?? { times: [], suppressed: 0 };
  bucket.times = bucket.times.filter((at) => now - at < settings.fingerprintWindowMs);
  if (bucket.times.length >= settings.fingerprintLimit) {
    bucket.suppressed += 1;
    buckets.set(fingerprint, bucket);
    return null;
  }
  bucket.times.push(now);
  const suppressed = bucket.suppressed;
  bucket.suppressed = 0;
  buckets.set(fingerprint, bucket);

  const scrubbed = sentryBeforeSend(event, hint) as T & { extra?: Record<string, unknown> };
  if (suppressed > 0) {
    return {
      ...scrubbed,
      extra: { ...(scrubbed.extra || {}), suppressedCount: suppressed },
    };
  }
  return scrubbed;
}
