export function shouldSkipHealthProbe(input: {
  isActive: boolean;
  healthStatus: string;
  downUntil: Date | null;
  now: Date;
}) {
  if (!input.isActive) return true;
  if (input.healthStatus === 'down' && input.downUntil && input.downUntil.getTime() > input.now.getTime()) {
    return true;
  }
  return false;
}

export const CIRCUIT_FAILS = 3;
export const CIRCUIT_COOLDOWN_MS = 10 * 60_000;

export function nextHealthAfterFailure(consecutiveFails: number, now = new Date()) {
  const fails = consecutiveFails + 1;
  if (fails >= CIRCUIT_FAILS) {
    return {
      consecutiveFails: fails,
      healthStatus: 'down' as const,
      downUntil: new Date(now.getTime() + CIRCUIT_COOLDOWN_MS),
    };
  }
  return {
    consecutiveFails: fails,
    healthStatus: 'degraded' as const,
    downUntil: null as Date | null,
  };
}

export function nextHealthAfterSuccess() {
  return {
    consecutiveFails: 0,
    healthStatus: 'healthy' as const,
    downUntil: null as Date | null,
  };
}
