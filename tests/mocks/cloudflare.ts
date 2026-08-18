import type { MockOutcome } from './ai';

export function createCloudflareMock(outcome: MockOutcome = 'success') {
  const records = new Map<string, string>();
  return {
    records,
    async upsertDns(name: string, target: string) {
      if (outcome === 'failure') throw new Error('Cloudflare DNS failed');
      if (outcome === 'timeout') throw Object.assign(new Error('Cloudflare timeout'), { code: 'ETIMEDOUT' });
      if (outcome === 'rate_limit') throw Object.assign(new Error('rate limit'), { status: 429 });
      if (outcome === 'partial') return { id: null as string | null };
      const id = `dns-${name}`;
      records.set(id, target);
      return { id };
    },
    async deleteDns(id: string) {
      records.delete(id);
    },
  };
}
