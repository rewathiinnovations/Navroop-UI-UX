import type { MockOutcome } from './ai';

export function createSentryMock(outcome: MockOutcome = 'success') {
  const events: unknown[] = [];
  const tags: Record<string, string> = {};
  function rejectIfNeeded(action: string) {
    if (outcome === 'failure') throw new Error(`Sentry ${action} failed`);
    if (outcome === 'timeout') throw Object.assign(new Error('Sentry timeout'), { code: 'ETIMEDOUT' });
    if (outcome === 'rate_limit') throw Object.assign(new Error('rate limit'), { status: 429 });
  }
  return {
    events,
    tags,
    setTag(key: string, value: string) {
      rejectIfNeeded('setTag');
      tags[key] = value;
    },
    captureException(event: unknown) {
      rejectIfNeeded('capture');
      events.push(event);
    },
  };
}
