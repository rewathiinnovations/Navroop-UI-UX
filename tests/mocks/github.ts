import type { MockOutcome } from './ai';

export function createGithubMock(outcome: MockOutcome = 'success') {
  const repos = new Set<string>();
  return {
    repos,
    async lookupOrCreateRepo(name: string) {
      if (outcome === 'failure') throw new Error('GitHub repo failed');
      if (outcome === 'timeout') throw Object.assign(new Error('GitHub timeout'), { code: 'ETIMEDOUT' });
      if (outcome === 'rate_limit') throw Object.assign(new Error('rate limit'), { status: 429 });
      if (outcome === 'partial') return { fullName: name, created: false, htmlUrl: null };
      repos.add(name);
      return { fullName: `org/${name}`, created: true, htmlUrl: `https://github.com/org/${name}` };
    },
    async archiveRepo(name: string) {
      repos.delete(name);
    },
  };
}
