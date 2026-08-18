import { getObservabilityStore } from '../observability/store';
import type { ObservabilityStore } from '../observability/types';

export type CronRecordDeps = {
  store?: Pick<ObservabilityStore, 'createCronRun'>;
  now?: () => Date;
};

function resultLooksFailed(result: unknown) {
  return Boolean(result && typeof result === 'object' && 'ok' in result && (result as { ok: unknown }).ok === false);
}

export async function withCronRun<T>(name: string, fn: () => Promise<T>, deps: CronRecordDeps = {}): Promise<T> {
  const store = deps.store ?? getObservabilityStore();
  const startedMs = Date.now();
  const createdAt = deps.now ? deps.now() : new Date();
  try {
    const result = await fn();
    const ok = !resultLooksFailed(result);
    await store.createCronRun({
      name,
      ok,
      durationMs: Date.now() - startedMs,
      detail: ok ? null : summarizeFailure(result),
      createdAt,
    });
    return result;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await store.createCronRun({
      name,
      ok: false,
      durationMs: Date.now() - startedMs,
      detail,
      createdAt,
    });
    throw error;
  }
}

function summarizeFailure(result: unknown) {
  if (!result || typeof result !== 'object') return 'failed';
  const record = result as { error?: unknown; detail?: unknown; message?: unknown };
  if (typeof record.error === 'string') return record.error;
  if (typeof record.detail === 'string') return record.detail;
  if (typeof record.message === 'string') return record.message;
  try {
    return JSON.stringify(result).slice(0, 500);
  } catch {
    return 'failed';
  }
}
