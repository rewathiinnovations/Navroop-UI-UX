import type { MockOutcome } from './ai';

export function createE2bMock(outcome: MockOutcome = 'success') {
  return {
    async create() {
      if (outcome === 'failure') throw new Error('E2B create failed');
      if (outcome === 'timeout') throw Object.assign(new Error('E2B timeout'), { code: 'ETIMEDOUT' });
      if (outcome === 'rate_limit') throw Object.assign(new Error('rate limit'), { status: 429 });
      return { sandboxId: 'e2b_mock', previewUrl: 'https://e2b.example' };
    },
    async kill() {
      if (outcome === 'failure') throw new Error('E2B kill failed');
    },
  };
}
