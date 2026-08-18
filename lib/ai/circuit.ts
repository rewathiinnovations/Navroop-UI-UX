import { loadProviderChain, type ProviderEntry } from './providers';

const FAILURE_WINDOW_MS = 2 * 60_000;
const OPEN_MS = 5 * 60_000;
const TRIP_COUNT = 5;

export type CircuitBreaker = {
  recordFailure: (id: string) => void;
  recordSuccess: (id: string) => void;
  isHealthy: (id: string) => boolean;
};

export type ProviderHealthRow = {
  id: string;
  provider: string;
  model: string;
  healthy: boolean;
};

export function createCircuitBreaker(opts: { now?: () => number } = {}): CircuitBreaker {
  const now = opts.now ?? Date.now;
  const failures = new Map<string, number[]>();
  const openedUntil = new Map<string, number>();

  return {
    recordFailure(id: string) {
      const t = now();
      const recent = (failures.get(id) ?? []).filter((ts) => t - ts <= FAILURE_WINDOW_MS);
      recent.push(t);
      failures.set(id, recent);
      if (recent.length >= TRIP_COUNT) {
        openedUntil.set(id, t + OPEN_MS);
      }
    },
    recordSuccess(id: string) {
      failures.set(id, []);
      openedUntil.delete(id);
    },
    isHealthy(id: string) {
      const until = openedUntil.get(id);
      if (until == null) return true;
      if (now() < until) return false;
      openedUntil.delete(id);
      failures.set(id, []);
      return true;
    },
  };
}

const defaultCircuit = createCircuitBreaker();

export function getDefaultCircuit() {
  return defaultCircuit;
}

export function getProviderHealth(
  circuit: CircuitBreaker = defaultCircuit,
  chain: ProviderEntry[] = loadProviderChain(),
): ProviderHealthRow[] {
  return chain.map((entry) => ({
    id: entry.provider,
    provider: entry.provider,
    model: entry.model,
    healthy: circuit.isHealthy(entry.provider),
  }));
}
