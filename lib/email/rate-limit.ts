export type EmailClass = 'workspace' | 'security';

const WORKSPACE_LIMIT = 20;
const WORKSPACE_WINDOW_MS = 60 * 60 * 1000;

const hits = new Map<string, number[]>();

export function clearEmailRateLimits() {
  hits.clear();
}

export function allowEmail(input: { to: string; emailClass?: EmailClass; now?: number }) {
  if (input.emailClass === 'security') {
    return { allowed: true as const, reason: 'security' as const };
  }
  const now = input.now ?? Date.now();
  const key = String(input.to || '').trim().toLowerCase();
  const prior = (hits.get(key) ?? []).filter((at) => now - at < WORKSPACE_WINDOW_MS);
  if (prior.length >= WORKSPACE_LIMIT) {
    hits.set(key, prior);
    return { allowed: false as const, reason: 'workspace_limit' as const };
  }
  prior.push(now);
  hits.set(key, prior);
  return { allowed: true as const, reason: 'workspace' as const };
}
