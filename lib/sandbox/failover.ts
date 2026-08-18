import { log } from '@/lib/logger';
import type { ProviderCandidate } from './router';

export type CreateAttempt = {
  configId: string;
  driver: string;
  ok: boolean;
  error?: string;
  at: string;
  selectionReason?: string;
  skipped?: Array<{ configId: string; name: string; reason: string }>;
};

function attemptFrom(
  row: ProviderCandidate,
  extra: { ok: boolean; error?: string },
): CreateAttempt {
  return {
    configId: row.id,
    driver: row.driver,
    ok: extra.ok,
    ...(extra.error ? { error: extra.error } : {}),
    at: new Date().toISOString(),
    ...(row.selectionReason ? { selectionReason: row.selectionReason } : {}),
    ...(row.outrankedEligible?.length ? { skipped: row.outrankedEligible } : {}),
  };
}

const FAILOVER_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

export function isFailoverError(error: unknown) {
  if (!error) return false;
  const record = error as { code?: string; status?: number; statusCode?: number; message?: string };
  if (record.code && FAILOVER_CODES.has(record.code)) return true;
  const status = record.status ?? record.statusCode;
  if (typeof status === 'number' && status >= 500) return true;
  const message = String(record.message || error).toLowerCase();
  if (message.includes('quota') || message.includes('rate limit') || message.includes('too many requests')) {
    return true;
  }
  if (message.includes('timeout') || message.includes('timed out') || message.includes('econnreset')) {
    return true;
  }
  if (message.includes('network') || message.includes('socket hang up') || message.includes('unavailable')) {
    return true;
  }
  if (message.includes('invalid image') || message.includes('malformed')) return false;
  return false;
}

export async function createWithFailover<T>(opts: {
  candidates: ProviderCandidate[];
  create: (row: ProviderCandidate) => Promise<T>;
  isFailoverError?: (error: unknown) => boolean;
  maxAttempts?: number;
  onAttempt?: (attempt: CreateAttempt) => Promise<void> | void;
}) {
  const classify = opts.isFailoverError ?? isFailoverError;
  const maxAttempts = opts.maxAttempts ?? 3;
  const attempts: CreateAttempt[] = [];
  let lastError: unknown;

  for (const row of opts.candidates.slice(0, maxAttempts)) {
    try {
      const result = await opts.create(row);
      const attempt = attemptFrom(row, { ok: true });
      attempts.push(attempt);
      // The sandbox already exists. Attempt bookkeeping must not discard the handle,
      // or the caller never gets it back to terminate.
      try {
        await opts.onAttempt?.(attempt);
      } catch (error) {
        log.error('sandbox.attempt_record_failed', {
          configId: row.id,
          driver: row.driver,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return { ...result, provider: row, attempts };
    } catch (error) {
      lastError = error;
      const attempt = attemptFrom(row, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
      attempts.push(attempt);
      try {
        await opts.onAttempt?.(attempt);
      } catch (recordError) {
        log.error('sandbox.attempt_record_failed', {
          configId: row.id,
          driver: row.driver,
          error: recordError instanceof Error ? recordError.message : String(recordError),
        });
      }
      if (!classify(error)) {
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), { attempts });
      }
    }
  }

  const wrapped = lastError instanceof Error ? lastError : new Error('Sandbox create failed');
  throw Object.assign(wrapped, { attempts });
}
