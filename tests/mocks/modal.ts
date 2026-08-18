import type { MockOutcome } from './ai';

export function createModalMock(outcome: MockOutcome = 'success') {
  return {
    async create() {
      if (outcome === 'failure') throw new Error('Modal create failed');
      if (outcome === 'timeout') throw Object.assign(new Error('Modal timeout'), { code: 'ETIMEDOUT' });
      if (outcome === 'rate_limit') throw Object.assign(new Error('rate limit'), { status: 429 });
      return { sandboxId: 'modal_mock', previewUrl: 'https://modal.example' };
    },
    async kill() {
      if (outcome === 'failure') throw new Error('Modal kill failed');
    },
  };
}
