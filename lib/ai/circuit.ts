import { loadProviderChain, type ProviderEntry } from './providers';

const FAILURE_WINDOW_MS = 2 * 60_000;
const OPEN_MS = 5 * 60_000;
const TRIP_COUNT = 5;

export type CircuitBreaker = {
  recordFailure: (id: string) => void;
  recordSuccess: (id: string) => void;
  isHealthy: (id: string) => boolean;
  /** Epoch ms the breaker stays open until, or null when it is closed. */
  openUntil: (id: string) => number | null;
};

/**
 * How long the caller is being asked to wait, in the sentence the user reads.
 *
 * Rounded up to whole minutes and never below one: "try again in 0 minutes" is not an
 * instruction. Deliberately says nothing about configuration — an operator whose key is
 * fine must not be sent to Admin → Configuration by this.
 */
export function circuitOpenMessage(retryAfterMs: number) {
  const minutes = Math.max(1, Math.ceil(retryAfterMs / 60_000));
  return `The AI is resting after several failures in a row. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
}

/**
 * Raised when every entry in the chain was skipped because its breaker is open — the app
 * declined to call the provider, which is not the same thing as the provider failing and
 * not the same thing as no provider being configured.
 *
 * With a single-provider chain the old code fell out of the loop with `tried === 0` and
 * threw `lastError`'s initial value, "No healthy provider is configured": classified
 * `unavailable` → `provider_error` → "The AI service did not respond". So for five minutes
 * every generation in the installation failed with a sentence that blamed the vendor, read
 * as a misconfiguration to the operator, and never mentioned that it clears on its own
 * (F-031).
 */
export class CircuitOpenError extends Error {
  readonly provider: string;
  readonly retryAfterMs: number;

  constructor(provider: string, retryAfterMs: number) {
    super(circuitOpenMessage(retryAfterMs));
    this.name = 'CircuitOpenError';
    this.provider = provider;
    this.retryAfterMs = retryAfterMs;
  }
}

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
    openUntil(id: string) {
      const until = openedUntil.get(id);
      if (until == null) return null;
      // Expired: let `isHealthy` do the reset so both readers agree.
      return now() < until ? until : null;
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
