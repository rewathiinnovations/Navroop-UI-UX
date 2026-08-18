import type { MockOutcome } from './ai';

export function createDaytonaMock(outcome: MockOutcome = 'success') {
  return {
    async create() {
      if (outcome === 'failure') throw new Error('Daytona create failed');
      if (outcome === 'timeout') throw Object.assign(new Error('Daytona timeout'), { code: 'ETIMEDOUT' });
      if (outcome === 'rate_limit') throw Object.assign(new Error('rate limit'), { status: 429 });
      return { sandboxId: 'daytona_mock', previewUrl: 'https://daytona.example' };
    },
    async kill() {
      if (outcome === 'failure') throw new Error('Daytona kill failed');
    },
  };
}
