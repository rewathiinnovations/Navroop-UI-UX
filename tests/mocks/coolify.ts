import type { MockOutcome } from './ai';

export function createCoolifyMock(outcome: MockOutcome = 'success') {
  const apps = new Map<string, { uuid: string; health: string }>();
  return {
    apps,
    async createApp(name: string) {
      if (outcome === 'failure') throw new Error('Coolify create failed');
      if (outcome === 'timeout') throw Object.assign(new Error('Coolify timeout'), { code: 'ETIMEDOUT' });
      if (outcome === 'rate_limit') throw Object.assign(new Error('rate limit'), { status: 429 });
      const uuid = `coolify-${name}`;
      apps.set(uuid, { uuid, health: outcome === 'partial' ? 'unknown' : 'healthy' });
      return { uuid };
    },
    async deleteApp(uuid: string) {
      apps.delete(uuid);
    },
    async status(uuid: string) {
      return apps.get(uuid) ?? { uuid, health: 'missing' };
    },
  };
}
