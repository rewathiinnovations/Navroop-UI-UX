import type { MockOutcome } from './ai';

export function createStorageMock(outcome: MockOutcome = 'success') {
  const objects = new Map<string, Buffer>();
  return {
    objects,
    async put(key: string, body: Buffer) {
      if (outcome === 'failure') throw new Error('Storage put failed');
      if (outcome === 'timeout') throw Object.assign(new Error('Storage timeout'), { code: 'ETIMEDOUT' });
      if (outcome === 'rate_limit') throw Object.assign(new Error('rate limit'), { status: 429 });
      if (outcome === 'partial') return { key, bytes: 0 };
      objects.set(key, body);
      return { key, bytes: body.length };
    },
    async get(key: string) {
      if (outcome === 'failure') throw new Error('Storage get failed');
      return objects.get(key) ?? null;
    },
    async remove(key: string) {
      objects.delete(key);
    },
  };
}
