import type { MockOutcome } from './ai';

export function createResendMock(outcome: MockOutcome = 'success') {
  const sent: Array<{ to: string; subject: string }> = [];
  return {
    sent,
    async send(input: { to: string; subject: string }) {
      if (outcome === 'failure') throw new Error('Resend failed');
      if (outcome === 'timeout') throw Object.assign(new Error('Resend timeout'), { code: 'ETIMEDOUT' });
      if (outcome === 'rate_limit') throw Object.assign(new Error('rate limit'), { status: 429 });
      sent.push(input);
      return { id: outcome === 'partial' ? null : 're_mock' };
    },
  };
}
